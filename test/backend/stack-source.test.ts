import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import { cleanRemote, clearStackSourceCache, readStackSource } from "../../backend/stack-source";
import { stackSourceState } from "../../common/stack-source";

/**
 * Run git in a directory, failing the test when git itself fails
 * @param dir Work tree
 * @param args Git arguments
 * @returns void
 */
async function git(dir : string, args : string[]) : Promise<void> {
    await spawn("git", args, {
        cwd: dir,
        encoding: "utf-8",
        timeoutMs: 10_000,
    });
}

/**
 * Create a temporary directory that the test removes afterwards
 * @returns Directory path
 */
function tempDir() : string {
    return mkdtempSync(path.join(os.tmpdir(), "dockge-source-"));
}

test("обычный каталог не выдается за репозиторий", async () => {
    const dir = tempDir();

    try {
        clearStackSourceCache();
        const source = await readStackSource(dir);

        assert.equal(source.kind, "local");
        assert.equal(source.remote, "");
        assert.equal(source.behind, null);
    } finally {
        rmSync(dir, { recursive: true,
            force: true });
    }
});

test("файл .git без репозитория репозиторием не считается", async () => {
    const dir = tempDir();

    try {
        // Такое бывает после неудачного копирования каталога: сам git скажет, что это не рабочее дерево
        writeFileSync(path.join(dir, ".git"), "not a repository\n");
        clearStackSourceCache();

        assert.equal((await readStackSource(dir)).kind, "local");
    } finally {
        rmSync(dir, { recursive: true,
            force: true });
    }
});

test("рабочее дерево читается вместе с ветвью, изменениями и отставанием", async () => {
    const upstream = tempDir();
    const work = tempDir();

    try {
        // Отдельный "удаленный" репозиторий в файловой системе: сеть не нужна
        await git(upstream, [ "init", "--bare", "--initial-branch=main", "." ]);

        await git(work, [ "init", "--initial-branch=main", "." ]);
        await git(work, [ "config", "user.email", "test@example.com" ]);
        await git(work, [ "config", "user.name", "Test" ]);
        writeFileSync(path.join(work, "compose.yaml"), "services: {}\n");
        await git(work, [ "add", "." ]);
        await git(work, [ "commit", "-m", "first" ]);
        await git(work, [ "remote", "add", "origin", upstream ]);
        await git(work, [ "push", "-u", "origin", "main" ]);

        clearStackSourceCache();
        const clean = await readStackSource(work);

        assert.equal(clean.kind, "git");
        assert.equal(clean.branch, "main");
        assert.equal(clean.dirty, false);
        assert.equal(clean.behind, 0);
        assert.ok(clean.remote.includes(path.basename(upstream)), clean.remote);

        // Незакоммиченная правка обязана быть видна: обновление из Git ее перепишет
        writeFileSync(path.join(work, "compose.yaml"), "services: {}\n# правка\n");
        clearStackSourceCache();
        assert.equal((await readStackSource(work)).dirty, true);
    } finally {
        rmSync(upstream, { recursive: true,
            force: true });
        rmSync(work, { recursive: true,
            force: true });
    }
});

test("отставание считается по локальным ссылкам, без обращения к сети", async () => {
    const upstream = tempDir();
    const first = tempDir();
    const second = tempDir();

    try {
        await git(upstream, [ "init", "--bare", "--initial-branch=main", "." ]);

        await git(first, [ "init", "--initial-branch=main", "." ]);
        await git(first, [ "config", "user.email", "test@example.com" ]);
        await git(first, [ "config", "user.name", "Test" ]);
        writeFileSync(path.join(first, "compose.yaml"), "services: {}\n");
        await git(first, [ "add", "." ]);
        await git(first, [ "commit", "-m", "first" ]);
        await git(first, [ "remote", "add", "origin", upstream ]);
        await git(first, [ "push", "-u", "origin", "main" ]);

        // Второе рабочее дерево отстает на два коммита после fetch
        await git(second, [ "clone", upstream, "." ]);
        for (const message of [ "second", "third" ]) {
            writeFileSync(path.join(first, `${message}.txt`), `${message}\n`);
            await git(first, [ "add", "." ]);
            await git(first, [ "commit", "-m", message ]);
        }
        await git(first, [ "push", "origin", "main" ]);
        await git(second, [ "fetch", "origin" ]);

        clearStackSourceCache();
        const source = await readStackSource(second);
        assert.equal(source.behind, 2);
    } finally {
        for (const dir of [ upstream, first, second ]) {
            rmSync(dir, { recursive: true,
                force: true });
        }
    }
});

test("ответ переиспользуется, пока не истек срок кеша", async () => {
    const dir = tempDir();

    try {
        clearStackSourceCache();
        const first = await readStackSource(dir, 1_000);

        // Каталог стал репозиторием, но в пределах минуты ответ прежний:
        // иначе десятисекундный крон запускал бы git по каждому стеку
        mkdirSync(path.join(dir, ".git"));
        assert.equal((await readStackSource(dir, 30_000)).kind, first.kind);

        // За минутой кеш истекает и ответ читается заново
        assert.notEqual(await readStackSource(dir, 120_000), first);
    } finally {
        rmSync(dir, { recursive: true,
            force: true });
    }
});

test("время проверки берется из FETCH_HEAD, а не из факта клонирования", async () => {
    const upstream = tempDir();
    const work = tempDir();
    const cloned = tempDir();

    try {
        await git(upstream, [ "init", "--bare", "--initial-branch=main", "." ]);

        await git(work, [ "init", "--initial-branch=main", "." ]);
        await git(work, [ "config", "user.email", "test@example.com" ]);
        await git(work, [ "config", "user.name", "Test" ]);
        writeFileSync(path.join(work, "compose.yaml"), "services: {}\n");
        await git(work, [ "add", "." ]);
        await git(work, [ "commit", "-m", "first" ]);
        await git(work, [ "remote", "add", "origin", upstream ]);
        await git(work, [ "push", "-u", "origin", "main" ]);

        // Клон приносит файлы, но FETCH_HEAD не пишет: с этой минуты origin никто
        // не спрашивал, и нулевое отставание означает "не проверяли", а не "свежее"
        await git(cloned, [ "clone", upstream, "." ]);
        clearStackSourceCache();
        const fresh = await readStackSource(cloned);

        assert.equal(fresh.behind, 0);
        assert.equal(fresh.checkedAt, null);
        assert.equal(stackSourceState(fresh), "unchecked");

        const before = Date.now();
        await git(cloned, [ "fetch", "origin" ]);
        clearStackSourceCache();
        const checked = await readStackSource(cloned);

        assert.equal(typeof checked.checkedAt, "number");
        // Минута запаса: файловые системы хранят время с разной точностью
        assert.ok((checked.checkedAt ?? 0) >= before - 60_000, `${checked.checkedAt} раньше ${before}`);
        assert.equal(stackSourceState(checked), "clean");
    } finally {
        for (const dir of [ upstream, work, cloned ]) {
            rmSync(dir, { recursive: true,
                force: true });
        }
    }
});

test("учетные данные из адреса удаляются, потому что адрес виден в интерфейсе", () => {
    assert.equal(cleanRemote("https://user:token@github.com/mazix/stack.git"), "github.com/mazix/stack");
    assert.equal(cleanRemote("git@github.com:mazix/stack.git"), "github.com/mazix/stack");
    assert.equal(cleanRemote("https://github.com/mazix/stack/"), "github.com/mazix/stack");
    assert.equal(cleanRemote(""), "");
});
