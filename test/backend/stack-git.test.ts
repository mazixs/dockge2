import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { StackGitWorkflow, validateGitRepository } from "../../backend/stack-git";
import type { GitCloneInput, GitUpdatePreview } from "../../common/stack-git";
import type { StackFileConfig } from "../../common/types/stack";

const config: StackFileConfig = { composeFileName: "compose.yaml",
    envFileNames: [ ".env" ],
    activeEnvFileName: ".env",
    secretBindings: [] };
const compose = "# preserve this comment\r\nservices:\r\n  app:\r\n    image: nginx:1\r\n";
const updatedCompose = compose.replace("nginx:1", "nginx:2");

function git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir,
        encoding: "utf8",
        stdio: [ "ignore", "pipe", "pipe" ] }).trim();
}

async function fixture(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-git-test-"));
    t.after(async () => fs.rm(root, { recursive: true,
        force: true }));
    const upstream = path.join(root, "upstream");
    const stack = path.join(root, "stack");
    await fs.mkdir(upstream);
    git(upstream, "init", "-b", "main");
    git(upstream, "config", "user.email", "fixture@example.invalid");
    git(upstream, "config", "user.name", "Fixture");
    await fs.writeFile(path.join(upstream, "compose.yaml"), compose);
    await fs.writeFile(path.join(upstream, ".env"), "PASSWORD=not-for-the-browser\n");
    await fs.writeFile(path.join(upstream, "readme.txt"), "initial\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "initial");
    let validations = 0;
    const validate = async (dir: string) => {
        validations++;
        const content = await fs.readFile(path.join(dir, "compose.yaml"), "utf8");
        assert.ok(content.includes("services:"), "Invalid selected compose");
        await fs.access(path.join(dir, ".env"));
    };
    const workflow = new StackGitWorkflow({ allowLocalTransport: true,
        validate });
    const input: GitCloneInput = { name: "stack",
        repository: upstream,
        branch: "main",
        composeFile: "compose.yaml",
        envFiles: [ ".env" ],
        deploy: false };
    await workflow.clone(stack, input, config);
    async function update() {
        await fs.writeFile(path.join(upstream, "compose.yaml"), updatedCompose);
        await fs.writeFile(path.join(upstream, ".env"), "PASSWORD=new-upstream-value\n");
        await fs.writeFile(path.join(upstream, "readme.txt"), "upstream\n");
        await fs.mkdir(path.join(upstream, "nested"));
        await fs.writeFile(path.join(upstream, "nested/file.txt"), "added\n");
        git(upstream, "add", ".");
        git(upstream, "commit", "-m", "update");
    }
    return { root,
        upstream,
        stack,
        workflow,
        input,
        update,
        validate,
        validations: () => validations };
}

function choices(preview: GitUpdatePreview, choice: "server" | "git" = "git") {
    return Object.fromEntries(preview.files.map((file) => [ file.path, choice ]));
}

test("clone validates before publishing and preserves exact source bytes", async (t) => {
    const f = await fixture(t);
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
    assert.equal(git(f.stack, "status", "--porcelain"), "");
    assert.equal(f.validations(), 1);
    await assert.rejects(f.workflow.clone(f.stack, f.input, config));
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
    assert.deepEqual((await fs.readdir(f.root)).sort(), [ "stack", "upstream" ]);
});

test("invalid clone never publishes a destination directory", async (t) => {
    const f = await fixture(t);
    const workflow = new StackGitWorkflow({ allowLocalTransport: true,
        validate: async () => {
            throw new Error("invalid");
        } });
    const destination = path.join(f.root, "invalid");
    await assert.rejects(workflow.clone(destination, f.input, config), /invalid/);
    await assert.rejects(fs.access(destination));
});

test("network preview leaves files and HEAD untouched and hides env and credential content", async (t) => {
    const f = await fixture(t);
    await f.update();
    await fs.writeFile(path.join(f.stack, "readme.txt"), "server-only\n");
    const head = git(f.stack, "rev-parse", "HEAD");
    const preview = await f.workflow.preview(f.stack, config);
    assert.equal(preview.currentCommit, head);
    assert.equal(preview.targetCommit, git(f.upstream, "rev-parse", "HEAD"));
    assert.equal(git(f.stack, "rev-parse", "HEAD"), head);
    assert.equal(await fs.readFile(path.join(f.stack, "readme.txt"), "utf8"), "server-only\n");
    assert.equal(preview.files.find((file) => file.path === "readme.txt")?.serverText, "server-only\n");
    assert.equal(preview.files.find((file) => file.path === ".env")?.redacted, true);
    assert.equal(preview.files.find((file) => file.path === ".env")?.gitText, null);
    assert.ok(!JSON.stringify(preview).includes("new-upstream-value"));
    assert.ok(!JSON.stringify(preview).includes("not-for-the-browser"));
});

test("apply uses per-file choices, preserves local bytes and marks them dirty against target Git", async (t) => {
    const f = await fixture(t);
    await f.update();
    await fs.writeFile(path.join(f.stack, "readme.txt"), "server-only\r\n");
    const preview = await f.workflow.preview(f.stack, config);
    const decision = { ...choices(preview),
        "readme.txt": "server" as const,
        ".env": "server" as const };
    await f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: decision,
        deploy: false }, config);
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), updatedCompose);
    assert.equal(await fs.readFile(path.join(f.stack, "readme.txt"), "utf8"), "server-only\r\n");
    assert.equal(await fs.readFile(path.join(f.stack, "nested/file.txt"), "utf8"), "added\n");
    assert.equal(git(f.stack, "rev-parse", "HEAD"), preview.targetCommit);
    assert.match(git(f.stack, "status", "--porcelain"), /M readme.txt/);
    assert.match(git(f.stack, "status", "--porcelain"), /M .env/);
    assert.equal(f.validations(), 2);
});

test("stale files and incomplete decisions reject before writing", async (t) => {
    const f = await fixture(t);
    await f.update();
    const preview = await f.workflow.preview(f.stack, config);
    await assert.rejects(f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: {},
        deploy: false }, config), /каждого/);
    await fs.writeFile(path.join(f.stack, "untracked.txt"), "a concurrent user change");
    await assert.rejects(f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: choices(preview),
        deploy: false }, config), /изменились/);
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
    assert.equal(git(f.stack, "rev-parse", "HEAD"), preview.currentCommit);
});

test("failure on a later file restores prior bytes and Git index", async (t) => {
    const f = await fixture(t);
    await f.update();
    let calls = 0;
    const workflow = new StackGitWorkflow({ allowLocalTransport: true,
        validate: f.validate,
        beforeWrite: async () => {
            if (++calls === 3) {
                throw new Error("injected write failure");
            }
        } });
    const preview = await workflow.preview(f.stack, config);
    const index = await fs.readFile(path.join(f.stack, ".git/index"));
    await assert.rejects(workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: choices(preview),
        deploy: false }, config), /injected/);
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
    assert.equal(await fs.readFile(path.join(f.stack, ".env"), "utf8"), "PASSWORD=not-for-the-browser\n");
    assert.ok((await fs.readFile(path.join(f.stack, ".git/index"))).equals(index));
    assert.equal(git(f.stack, "rev-parse", "HEAD"), preview.currentCommit);
});

test("reject symbolic links and diverged local commits without overwriting", async (t) => {
    const f = await fixture(t);
    await f.update();
    await fs.symlink(f.upstream, path.join(f.stack, "linked"));
    await assert.rejects(f.workflow.preview(f.stack, config), /ссылки/);
    await fs.unlink(path.join(f.stack, "linked"));
    git(f.stack, "config", "user.name", "Fixture");
    git(f.stack, "config", "user.email", "fixture@example.invalid");
    await fs.writeFile(path.join(f.stack, "readme.txt"), "local commit\n");
    git(f.stack, "add", ".");
    git(f.stack, "commit", "-m", "diverged");
    await assert.rejects(f.workflow.preview(f.stack, config), /разошлись/);
    assert.equal(await fs.readFile(path.join(f.stack, "readme.txt"), "utf8"), "local commit\n");
});

test("transport validation forbids URLs with credentials, helper protocols and local files", () => {
    for (const address of [ "file:///etc", "/tmp/repo", "ext::sh command", "--upload-pack=evil", "https://user:token@example.com/repo", "https://token@example.com/repo", "https://example.com/repo?token=secret" ]) {
        assert.throws(() => validateGitRepository(address));
    }
    for (const address of [ "http://127.0.0.1:5088/repo.git", "https://example.com/repo.git", "git@example.com:team/repo.git", "ssh://git@example.com/team/repo.git" ]) {
        assert.doesNotThrow(() => validateGitRepository(address));
    }
});

test("staged user changes are refused instead of discarding the Git index", async (t) => {
    const f = await fixture(t);
    await f.update();
    await fs.writeFile(path.join(f.stack, "readme.txt"), "staged local change\n");
    git(f.stack, "add", "readme.txt");
    const index = await fs.readFile(path.join(f.stack, ".git/index"));
    await assert.rejects(f.workflow.preview(f.stack, config), /подготовленные/);
    assert.ok((await fs.readFile(path.join(f.stack, ".git/index"))).equals(index));
    assert.match(git(f.stack, "diff", "--cached"), /staged local change/);
});

test("metadata symlinks are rejected before Git can write through them", async (t) => {
    const f = await fixture(t);
    const originalIndex = path.join(f.stack, ".git/index");
    const external = path.join(f.root, "external-index");
    await fs.rename(originalIndex, external);
    await fs.symlink(external, originalIndex);
    await assert.rejects(f.workflow.preview(f.stack, config), /Метаданные Git/);
});

test("remote deletions and executable bytes apply without rewriting unrelated local files", async (t) => {
    const f = await fixture(t);
    await fs.unlink(path.join(f.upstream, "readme.txt"));
    await fs.writeFile(path.join(f.upstream, "start.sh"), "#!/bin/sh\necho ready\n", { mode: 0o755 });
    git(f.upstream, "add", ".");
    git(f.upstream, "commit", "-m", "delete and executable");
    await fs.writeFile(path.join(f.stack, "local-only.txt"), "keep my bytes\r\n");
    const preview = await f.workflow.preview(f.stack, config);
    assert.equal(preview.files.find((file) => file.path === "readme.txt")?.status, "deleted");
    await f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: choices(preview),
        deploy: false }, config);
    await assert.rejects(fs.access(path.join(f.stack, "readme.txt")));
    assert.ok((await fs.stat(path.join(f.stack, "start.sh"))).mode & 0o111);
    assert.equal(await fs.readFile(path.join(f.stack, "local-only.txt"), "utf8"), "keep my bytes\r\n");
});

test("taking Git content preserves restrictive permissions of existing env files", async (t) => {
    const f = await fixture(t);
    await f.update();
    await fs.chmod(path.join(f.stack, ".env"), 0o600);
    const preview = await f.workflow.preview(f.stack, config);
    await f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: choices(preview),
        deploy: false }, config);
    assert.equal((await fs.stat(path.join(f.stack, ".env"))).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(path.join(f.stack, ".env"), "utf8"), "PASSWORD=new-upstream-value\n");
});

test("apply holds the Git index lock and checks a file again immediately before replacing it", async (t) => {
    const f = await fixture(t);
    await f.update();
    let lockChecked = false;
    const workflow = new StackGitWorkflow({ allowLocalTransport: true,
        validate: f.validate,
        beforeWrite: async (name) => {
            if (!lockChecked) {
                assert.throws(() => git(f.stack, "add", "readme.txt"), /index.lock/);
                lockChecked = true;
            }
            if (name === "compose.yaml") {
                await fs.writeFile(path.join(f.stack, "compose.yaml"), "services: {}\n# concurrent editor\n");
            }
        } });
    const preview = await workflow.preview(f.stack, config);
    await assert.rejects(workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: choices(preview),
        deploy: false }, config), /изменился во время/);
    assert.equal(lockChecked, true);
    assert.equal(await fs.readFile(path.join(f.stack, ".env"), "utf8"), "PASSWORD=not-for-the-browser\n");
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), "services: {}\n# concurrent editor\n");
    assert.equal(git(f.stack, "rev-parse", "HEAD"), preview.currentCommit);
    await assert.rejects(fs.access(path.join(f.stack, ".git/index.lock")));
});

test("source reading never executes repository-configured clean filters", async (t) => {
    const f = await fixture(t);
    const marker = path.join(f.root, "filter-ran");
    await fs.writeFile(path.join(f.stack, ".gitattributes"), "*.txt filter=tripwire\n");
    git(f.stack, "config", "filter.tripwire.clean", `touch '${marker}'; cat`);
    await fs.writeFile(path.join(f.stack, "readme.txt"), "changed\n");
    // Prove this repository configuration really invokes a filter without our boundary.
    git(f.stack, "status", "--porcelain");
    await fs.access(marker);
    await fs.unlink(marker);
    const { clearStackSourceCache, readStackSource } = await import("../../backend/stack-source");
    clearStackSourceCache(f.stack);
    assert.equal((await readStackSource(f.stack)).dirty, true);
    await assert.rejects(fs.access(marker));
});

test("edited result preserves exact text, validates before writes and remains a local change", async (t) => {
    const f = await fixture(t);
    await f.update();
    const preview = await f.workflow.preview(f.stack, config);
    const merged = updatedCompose + "    ports: [\"8088:80\"]\r\n";
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
    await f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: { ...choices(preview),
            "compose.yaml": "edited" },
        editedContents: { "compose.yaml": merged },
        deploy: false }, config);
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), merged);
    assert.match(git(f.stack, "status", "--porcelain"), /compose.yaml/);
    assert.equal(f.validations(), 2);
});

test("edited results reject hidden files, oversized input, invalid Compose and stale source", async (t) => {
    const f = await fixture(t);
    await f.update();
    const preview = await f.workflow.preview(f.stack, config);
    const input = { stackName: "stack",
        previewId: preview.id,
        choices: choices(preview),
        deploy: false };
    for (const [ name, content ] of [[ ".env", "visible" ], [ "compose.yaml", "x".repeat(1024 * 1024 + 1) ], [ "compose.yaml", "invalid" ]]) {
        await assert.rejects(f.workflow.apply(f.stack, { ...input,
            choices: { ...input.choices,
                [name!]: "edited" },
            editedContents: { [name!]: content! } }, config));
        assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
    }
    await fs.writeFile(path.join(f.stack, "readme.txt"), "concurrent change");
    await assert.rejects(f.workflow.apply(f.stack, { ...input,
        choices: { ...input.choices,
            "compose.yaml": "edited" },
        editedContents: { "compose.yaml": updatedCompose } }, config), /после сравнения/);
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
});

test("edited deleted text recreates a file while binary choices stay opaque", async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.upstream, "binary.dat"), Buffer.from([ 0, 1, 2 ]));
    await fs.rm(path.join(f.upstream, "readme.txt"));
    git(f.upstream, "add", ".");
    git(f.upstream, "commit", "-m", "delete and binary");
    const preview = await f.workflow.preview(f.stack, config);
    assert.equal(preview.files.find(file => file.path === "binary.dat")?.gitText, null);
    await assert.rejects(f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: { ...choices(preview),
            "binary.dat": "edited" },
        editedContents: { "binary.dat": "text" },
        deploy: false }, config));
    await f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: { ...choices(preview),
            "readme.txt": "edited" },
        editedContents: { "readme.txt": "restored\r\n" },
        deploy: false }, config);
    assert.equal(await fs.readFile(path.join(f.stack, "readme.txt"), "utf8"), "restored\r\n");
    assert.deepEqual(await fs.readFile(path.join(f.stack, "binary.dat")), Buffer.from([ 0, 1, 2 ]));
});

test("configured secrets and env files with neutral names are never exposed or editable", async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.upstream, "data.txt"), "opaque-value\n");
    await fs.writeFile(path.join(f.upstream, "settings.txt"), "VALUE=opaque\n");
    git(f.upstream, "add", ".");
    git(f.upstream, "commit", "-m", "private files");
    const privateConfig = { ...config,
        envFileNames: [ ".env", "settings.txt" ],
        secretBindings: [{ name: "db",
            fileName: "data.txt",
            services: [] }] };
    const preview = await f.workflow.preview(f.stack, privateConfig);
    for (const name of [ "data.txt", "settings.txt" ]) {
        const file = preview.files.find(file => file.path === name)!;
        assert.equal(file.redacted, true);
        assert.equal(file.gitText, null);
        await assert.rejects(f.workflow.apply(f.stack, { stackName: "stack",
            previewId: preview.id,
            choices: { ...choices(preview),
                [name]: "edited" },
            editedContents: { [name]: "overwrite" },
            deploy: false }, privateConfig));
    }
});

test("edited payload rejects inherited choices, stray contents and malformed UTF-8", async (t) => {
    const f = await fixture(t);
    await f.update();
    const preview = await f.workflow.preview(f.stack, config);
    const base = { stackName: "stack",
        previewId: preview.id,
        choices: choices(preview),
        deploy: false };
    await assert.rejects(f.workflow.apply(f.stack, { ...base,
        choices: Object.create(base.choices) }, config));
    await assert.rejects(f.workflow.apply(f.stack, { ...base,
        editedContents: { "extra": "text" } }, config));
    for (const text of [ "\ud800", "\0" ]) {
        await assert.rejects(f.workflow.apply(f.stack, { ...base,
            choices: { ...base.choices,
                "compose.yaml": "edited" },
            editedContents: { "compose.yaml": text } }, config));
    }
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
});

test("concurrent changes to retained inputs during writes reject and roll back edited files", async (t) => {
    const f = await fixture(t);
    await f.update();
    const workflow = new StackGitWorkflow({ allowLocalTransport: true,
        validate: f.validate,
        beforeWrite: async () => {
            await fs.writeFile(path.join(f.stack, "readme.txt"), "concurrent\n");
        } });
    const preview = await workflow.preview(f.stack, config);
    await assert.rejects(workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: { ...choices(preview, "server"),
            "compose.yaml": "edited" },
        editedContents: { "compose.yaml": updatedCompose },
        deploy: false }, config), /во время применения/);
    assert.equal(await fs.readFile(path.join(f.stack, "compose.yaml"), "utf8"), compose);
    assert.equal(await fs.readFile(path.join(f.stack, "readme.txt"), "utf8"), "concurrent\n");
    assert.equal(git(f.stack, "rev-parse", "HEAD"), preview.currentCommit);
});

test("aggregate edited bytes and combined result file count are bounded before validation", async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 21; i++) {
        await fs.writeFile(path.join(f.upstream, `file-${i}.txt`), "small");
    }
    git(f.upstream, "add", ".");
    git(f.upstream, "commit", "-m", "many editable files");
    const preview = await f.workflow.preview(f.stack, config);
    await assert.rejects(f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: Object.fromEntries(preview.files.map(file => [ file.path, "edited" ])),
        editedContents: Object.fromEntries(preview.files.map(file => [ file.path, "x".repeat(1024 * 1024) ])),
        deploy: false }, config), /20 МБ/);
    assert.equal(f.validations(), 1);
    for (let i = 0; i < 997; i++) {
        await fs.writeFile(path.join(f.stack, `local-${i}.txt`), "local");
    }
    const crowded = await f.workflow.preview(f.stack, config);
    await assert.rejects(f.workflow.apply(f.stack, { stackName: "stack",
        previewId: crowded.id,
        choices: choices(crowded),
        deploy: false }, config), /1000 файлов/);
    assert.equal(f.validations(), 1);
});

test("apply returns the intended tree hash so later edits cannot become the deployment baseline", async t => {
    const f = await fixture(t);
    await f.update();
    const preview = await f.workflow.preview(f.stack, config);
    const result = await f.workflow.apply(f.stack, { stackName: "stack",
        previewId: preview.id,
        choices: choices(preview),
        deploy: false }, config);
    assert.equal(await f.workflow.filesHash(f.stack), result.filesHash);
    await fs.writeFile(path.join(f.stack, "compose.yaml"), updatedCompose + "# concurrent edit\n");
    assert.notEqual(await f.workflow.filesHash(f.stack), result.filesHash);
});

test("clone returns a hash of the intended source bytes, not a later directory snapshot", async t => {
    const f = await fixture(t);
    const destination = path.join(f.root, "another");
    const result = await f.workflow.clone(destination, { ...f.input,
        name: "another" }, config);
    assert.equal(await f.workflow.filesHash(destination), result.filesHash);
    await fs.writeFile(path.join(destination, "readme.txt"), "changed after clone\n");
    assert.notEqual(await f.workflow.filesHash(destination), result.filesHash);
});
