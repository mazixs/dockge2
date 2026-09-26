import { OperationError } from "../../backend/operation-error";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Stack } from "../../backend/stack";
import { statusConvert } from "../../backend/stack-state";
import {
    CREATED_STACK,
    EXITED,
    MAX_STACK_NAME_LENGTH,
    RUNNING,
    UNKNOWN,
} from "../../common/util-common";
import {
    DockgeSocket,
    ValidationError,
    callbackError,
    callbackResult,
    checkLogin,
    fileExists,
} from "../../backend/util-server";
import { makeAuthenticatedSocket, withDatabase } from "../helpers/database";

/**
 * A socket with or without a session
 * @param userID Identifier of the signed in user, empty for an anonymous socket
 * @returns Fake socket
 */
function makeSocket(userID : string): DockgeSocket {
    return makeAuthenticatedSocket({ userID });
}

test("server utilities validate login and serialize callback results and errors", () => {
    assert.doesNotThrow(() => checkLogin(makeSocket("owner")));
    assert.throws(() => checkLogin(makeSocket("")), /notLoggedIn/);

    const results: unknown[] = [];
    callbackResult({ ok: true }, (value: unknown) => results.push(value));
    assert.deepEqual(results, [{ ok: true }]);

    const errors: unknown[] = [];
    callbackError(new ValidationError("invalid"), (value: unknown) => errors.push(value));
    callbackError(new Error("failed"), (value: unknown) => errors.push(value));
    callbackError("unknown", (value: unknown) => errors.push(value));
    assert.deepEqual(errors, [
        { ok: false,
            type: 1,
            msg: "invalid",
            msgi18n: true },
        { ok: false,
            msg: "failed",
            msgi18n: true },
        { ok: false,
            msg: "operationUnexpectedError",
            msgi18n: true },
    ]);

    assert.doesNotThrow(() => callbackError(new Error("ignored"), undefined));
    assert.doesNotThrow(() => callbackResult({ ok: true }, undefined));

    // An error whose message is a catalogue entry taking values sends them along, or the
    // browser would show the entry with the placeholder still in it
    const withValues = Object.assign(new Error("gitRollbackIncomplete"), { values: { backup: "dockge-recovery-1" } });
    const carried: unknown[] = [];
    callbackError(withValues, (value: unknown) => carried.push(value));
    assert.deepEqual(carried, [
        { ok: false,
            msg: { key: "gitRollbackIncomplete",
                values: { backup: "dockge-recovery-1" } },
            msgi18n: true },
    ]);
});

test("fileExists checks real files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dockge-file-test-"));
    const file = path.join(directory, "file.txt");
    try {
        assert.equal(await fileExists(file), false);
        await writeFile(file, "content");
        assert.equal(await fileExists(file), true);
    } finally {
        await rm(directory, { recursive: true,
            force: true });
    }
});

// Saving a stack also stores which files it is made of, and that selection lives in the
// database: with none connected the write has nowhere to record what it just did, so the
// test needs a real one rather than a directory alone
test("Stack validates, saves and reads compose files using the real filesystem", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const server = { stacksDir,
            config: { dataDir } } as never;

        const stack = new Stack(
            server,
            "demo-stack",
            "services:\n  app:\n    image: nginx\n",
            "APP_ENV=production\n",
            true
        );
        assert.doesNotThrow(() => stack.validate());
        assert.equal(stack.isManagedByDockge, false);
        assert.equal(stack.status, UNKNOWN);
        assert.equal(stack.fullPath, path.join(stacksDir, "demo-stack"));
        // Строка списка несет и сводку сервисов, и источник каталога: до обхода списка
        // они пусты, но поле обязано быть, иначе интерфейс не отличит "нет данных"
        // от "поле не пришло"
        assert.deepEqual(stack.toSimpleJSON("localhost"), {
            name: "demo-stack",
            status: UNKNOWN,
            issues: [],
            tags: [],
            isManagedByDockge: false,
            composeFileName: "compose.yaml",
            endpoint: "localhost",
            services: [],
            source: null,
            dir: "",
            availability: null,
            panelService: "",
        });

        await stack.save(true);
        assert.equal(await fileExists(path.join(stacksDir, "demo-stack", "compose.yaml")), true);
        assert.equal(await readFile(path.join(stacksDir, "demo-stack", "compose.yaml"), "utf8"), stack.composeYAML);
        assert.equal(stack.isManagedByDockge, true);
        await assert.rejects(stack.save(true), /stackNameExists/);

        const loaded = await Stack.getStack(server, "demo-stack");
        assert.equal(loaded.composeYAML, stack.composeYAML);
        assert.equal(loaded.composeENV, "APP_ENV=production\n");
        assert.equal(loaded.status, UNKNOWN);

        const updated = new Stack(server, "demo-stack", "services:\n  app:\n    image: alpine\n", "KEY=value", true);
        await updated.save(false);
        assert.match(await readFile(path.join(stacksDir, "demo-stack", "compose.yaml"), "utf8"), /alpine/);

        const composeDir = path.join(stacksDir, "compose-only");
        await mkdir(composeDir);
        await writeFile(path.join(composeDir, "docker-compose.yml"), "services: {}\n");
        assert.equal(await Stack.composeFileExists(stacksDir, "compose-only"), true);
        assert.equal(await Stack.composeFileExists(stacksDir, "missing"), false);

        const withGlobalEnv = new Stack(server, "demo-stack", undefined, undefined, true);
        await writeFile(path.join(stacksDir, "global.env"), "GLOBAL=value\n");
        await writeFile(path.join(stacksDir, "demo-stack", ".env"), "LOCAL=value\n");
        assert.deepEqual(withGlobalEnv.getComposeOptions("ps", "--format", "json"), [
            "compose",
            "--env-file",
            "../global.env",
            "--env-file",
            "./.env",
            "-f",
            "compose.yaml",
            "ps",
            "--format",
            "json",
        ]);
    });
});

test("Stack persists environment files on save", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const server = { stacksDir,
            config: { dataDir } } as never;
        const envPath = path.join(stacksDir, "env-stack", ".env");

        // 1. A new stack with env content writes .env byte for byte
        const created = new Stack(server, "env-stack", "services:\n  app:\n    image: nginx\n", "KEY=initial\n", true);
        await created.save(true);
        assert.equal(await readFile(envPath, "utf8"), "KEY=initial\n");

        // 2. Saving an existing stack replaces the env file
        const updated = new Stack(server, "env-stack", "services:\n  app:\n    image: nginx\n", "KEY=updated\n", true);
        await updated.save(false);
        assert.equal(await readFile(envPath, "utf8"), "KEY=updated\n");

        // 3. Clearing the env content empties the existing file instead of leaving stale values
        const cleared = new Stack(server, "env-stack", "services:\n  app:\n    image: nginx\n", "", true);
        await cleared.save(false);
        assert.equal(await fileExists(envPath), true);
        assert.equal(await readFile(envPath, "utf8"), "");

        // 4. A new stack without env content does not create an empty .env
        const withoutEnv = new Stack(server, "plain-stack", "services:\n  app:\n    image: nginx\n", "", true);
        await withoutEnv.save(true);
        assert.equal(await fileExists(path.join(stacksDir, "plain-stack", ".env")), false);
    });
});

test("a new stack name has a length limit that an existing stack does not", () => {
    const longest = "a".repeat(MAX_STACK_NAME_LENGTH);
    assert.doesNotThrow(() => Stack.validateNewName(longest));
    assert.throws(() => Stack.validateNewName(longest + "a"), ValidationError);
    // Unsafe characters are still refused, whatever the length
    assert.throws(() => Stack.validateNewName("UPPER"), ValidationError);

    // A stack whose directory already carries a longer name stays reachable: the limit
    // guards what is being created, not what is already on disk
    assert.doesNotThrow(() => Stack.validateName(longest + "a"));
});

test("Stack rejects unsafe names before touching the filesystem", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dockge-stack-path-"));
    const stacksDir = path.join(root, "stacks");
    const outsideDir = path.join(root, "outside");
    await mkdir(stacksDir);
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, ".env"), "SECRET=outside\n");
    await writeFile(path.join(outsideDir, "compose.yaml"), "services: {}\n");

    try {
        const server = { stacksDir,
            config: { dataDir: stacksDir } } as never;

        for (const unsafeName of [ "../outside", "..", "/tmp/outside", "..\\outside", "", "with space", "UPPER", "dot.stack" ]) {
            assert.throws(() => Stack.validateName(unsafeName), ValidationError, `expected ${JSON.stringify(unsafeName)} to be rejected`);
            assert.throws(() => Stack.getSafePath(server, unsafeName), ValidationError, `expected ${JSON.stringify(unsafeName)} to be rejected`);
        }

        assert.doesNotThrow(() => Stack.validateName("ok-stack_1"));
        assert.equal(Stack.getSafePath(server, "ok-stack_1"), path.join(stacksDir, "ok-stack_1"));

        // Traversal must not read or delete anything outside stacksDir
        await assert.rejects(Stack.getStack(server, "../outside"), ValidationError);
        assert.equal(await readFile(path.join(outsideDir, ".env"), "utf8"), "SECRET=outside\n");

        const traversalStack = new Stack(server, "../outside", undefined, undefined, true);
        assert.throws(() => traversalStack.path, ValidationError);
        assert.equal(traversalStack.isManagedByDockge, false);
        await assert.rejects(traversalStack.save(false), ValidationError);
        assert.equal(await readFile(path.join(outsideDir, "compose.yaml"), "utf8"), "services: {}\n");

        // A valid name pointing outside via symlink must be rejected too
        await symlink(outsideDir, path.join(stacksDir, "linked"), "dir");
        await assert.rejects(Stack.getStack(server, "linked"), ValidationError);
        assert.equal(await readFile(path.join(outsideDir, ".env"), "utf8"), "SECRET=outside\n");

        // A real stack inside stacksDir keeps working
        const okDir = path.join(stacksDir, "ok-stack_1");
        await mkdir(okDir);
        await writeFile(path.join(okDir, "compose.yaml"), "services:\n  app:\n    image: nginx\n");
        const loaded = await Stack.getStack(server, "ok-stack_1");
        assert.match(loaded.composeYAML, /nginx/);
    } finally {
        await rm(root, { recursive: true,
            force: true });
    }
});

test("Stack validates names, YAML and environment files and converts statuses", () => {
    const server = { stacksDir: "/tmp" } as never;
    const invalidName = new Stack(server, "Invalid Name", "services: {}", "", true);
    assert.throws(() => invalidName.validate(), ValidationError);

    const invalidYaml = new Stack(server, "valid-name", "services: [", "", true);
    assert.throws(() => invalidYaml.validate(), Error);

    const invalidEnv = new Stack(server, "valid-name", "services: {}", "INVALID", true);
    assert.throws(() => invalidEnv.validate(), ValidationError);

    assert.equal(statusConvert("created(1)"), CREATED_STACK);
    assert.equal(statusConvert("exited(1), running(1)"), EXITED);
    assert.equal(statusConvert("running(1)"), RUNNING);
    assert.equal(statusConvert("unknown"), UNKNOWN);
});

test("the texts of a stack are read once, before anyone asks for them", async () => {
    const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-texts-test-"));
    const server = { stacksDir,
        config: { dataDir: stacksDir } } as never;

    try {
        await mkdir(path.join(stacksDir, "texts"));
        await writeFile(path.join(stacksDir, "texts", "compose.yaml"), "services:\n  app:\n    image: nginx\n");
        await writeFile(path.join(stacksDir, "texts", ".env"), "KEY=value\n");

        // Nothing is read behind a getter: a stack that skipped reading says so
        const bare = new Stack(server, "texts", undefined, undefined, true);
        assert.throws(() => bare.composeYAML, /call loadTexts\(\) first/);
        await bare.loadTexts();
        assert.equal(bare.composeENV, "KEY=value\n");

        const loaded = await Stack.getStack(server, "texts");
        await writeFile(path.join(stacksDir, "texts", "compose.yaml"), "services: {}\n");

        // The snapshot is what was on disk when the stack was loaded
        assert.match(loaded.composeYAML, /nginx/);

        // An edit passed in is kept rather than replaced by the file
        const edited = new Stack(server, "texts", "services:\n  web:\n    image: caddy\n", "", true);
        await edited.loadTexts();
        assert.match(edited.composeYAML, /caddy/);
        assert.equal(edited.composeENV, "");
    } finally {
        await rm(stacksDir, { recursive: true,
            force: true });
    }
});

test("a stack that builds its own image is deployed with a build", async () => {
    const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-build-test-"));
    const server = { stacksDir,
        config: { dataDir: stacksDir } } as never;

    try {
        const built = new Stack(server, "built-stack", "services:\n  app:\n    build: .\n", "", true);
        const pulled = new Stack(server, "pulled-stack", "services:\n  app:\n    image: alpine\n", "", true);

        // Compose обошелся бы готовым образом, и правка в Dockerfile не доехала бы
        // до контейнера. Проверку конфигурации подменяем: она зовет настоящий docker
        for (const stack of [ built, pulled ]) {
            (stack as unknown as { validateComposeConfig : () => Promise<void> }).validateComposeConfig = async () => {};
            (stack as unknown as { updateStatus : () => Promise<void> }).updateStatus = async () => {};
        }

        const builtCommands : string[][] = [];
        await built.control("deploy", async (args) => {
            builtCommands.push(args);
            return 0;
        });

        const plainCommands : string[][] = [];
        await pulled.control("deploy", async (args) => {
            plainCommands.push(args);
            return 0;
        });

        assert.equal(builtCommands.length, 1);
        assert.ok(builtCommands[0]!.includes("--build"), "a built stack has to be rebuilt on deploy");
        assert.equal(plainCommands.length, 1);
        assert.equal(plainCommands[0]!.includes("--build"), false, "an image from a registry is not built");

        // Обновление тянет базовый образ и пересобирает поверх него, а не просто up
        const updateCommands : string[][] = [];
        (built as unknown as { _status : number })._status = RUNNING;
        await built.control("update", async (args) => {
            updateCommands.push(args);
            return 0;
        });

        assert.deepEqual(updateCommands.map((args) => args.filter((arg) => !arg.startsWith("-") && arg !== "compose" && !arg.endsWith(".yaml"))), [
            [ "pull" ],
            [ "build" ],
            [ "up" ],
        ]);
        assert.ok(updateCommands[0]!.includes("--ignore-buildable"));
        assert.ok(updateCommands[1]!.includes("--pull"), "the base image of a Dockerfile is only refreshed by build --pull");
    } finally {
        await rm(stacksDir, { recursive: true,
            force: true });
    }
});

test("update failure categories stop at the failed command boundary", async (context) => {
    const server = { stacksDir: os.tmpdir() } as never;
    for (const failedStage of [ "pull", "build", "up" ]) {
        const stack = new Stack(server, "boundary-test", "services:\n  app:\n    build: .\n", "", true);
        context.mock.method(stack, "validateComposeConfig", async () => {});
        context.mock.method(stack, "updateStatus", async () => {});
        (stack as unknown as { _status : number })._status = RUNNING;
        const commands : string[] = [];
        await assert.rejects(stack.control("update", async (args) => {
            const stage = args.find(arg => [ "pull", "build", "up" ].includes(arg))!;
            commands.push(stage);
            return stage === failedStage ? 1 : 0;
        }), (error : unknown) => {
            assert.ok(error instanceof OperationError);
            assert.equal(error.code, failedStage === "up" ? "apply" : failedStage);
            const replies : unknown[] = [];
            callbackError(error, (response : unknown) => replies.push(response));
            assert.deepEqual(replies, [{ ok: false,
                code: error.code,
                unknown: false,
                msg: error.message,
                msgi18n: true }]);
            return true;
        });
        assert.equal(commands.at(-1), failedStage);
    }
});

test("an unavailable Compose executable is not reported as invalid user configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dockge-missing-compose-"));
    const savedPath = process.env.PATH;
    try {
        await mkdir(path.join(root, "fixture"));
        const stack = new Stack({ stacksDir: root } as never, "fixture", "services: {}", "", true);
        process.env.PATH = "";
        await assert.rejects(stack.validateComposeConfig(), { code: "spawn",
            message: "operationValidationUnavailable" });
    } finally {
        if (savedPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = savedPath;
        }
        await rm(root, { recursive: true,
            force: true });
    }
});
