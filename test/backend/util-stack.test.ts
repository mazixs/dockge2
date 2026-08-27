import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Stack } from "../../backend/stack";
import {
    CREATED_STACK,
    EXITED,
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
import { makeAuthenticatedSocket } from "../helpers/database";

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
    assert.throws(() => checkLogin(makeSocket("")), /You are not logged in/);

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
    ]);

    assert.doesNotThrow(() => callbackError(new Error("ignored"), undefined));
    assert.doesNotThrow(() => callbackResult({ ok: true }, undefined));
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

test("Stack validates, saves and reads compose files using the real filesystem", async () => {
    const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-stack-test-"));
    const server = { stacksDir } as never;

    try {
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
        assert.deepEqual(stack.toSimpleJSON("localhost"), {
            name: "demo-stack",
            status: UNKNOWN,
            issues: [],
            tags: [],
            isManagedByDockge: false,
            composeFileName: "compose.yaml",
            endpoint: "localhost",
        });

        await stack.save(true);
        assert.equal(await fileExists(path.join(stacksDir, "demo-stack", "compose.yaml")), true);
        assert.equal(await readFile(path.join(stacksDir, "demo-stack", "compose.yaml"), "utf8"), stack.composeYAML);
        assert.equal(stack.isManagedByDockge, true);
        await assert.rejects(stack.save(true), /Stack name already exists/);

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
    } finally {
        await rm(stacksDir, { recursive: true,
            force: true });
    }
});

test("Stack persists environment files on save", async () => {
    const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-stack-env-"));
    const server = { stacksDir } as never;
    const envPath = path.join(stacksDir, "env-stack", ".env");

    try {
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
    } finally {
        await rm(stacksDir, { recursive: true,
            force: true });
    }
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
        const server = { stacksDir } as never;

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

    assert.equal(Stack.statusConvert("created(1)"), CREATED_STACK);
    assert.equal(Stack.statusConvert("exited(1), running(1)"), EXITED);
    assert.equal(Stack.statusConvert("running(1)"), RUNNING);
    assert.equal(Stack.statusConvert("unknown"), UNKNOWN);
});
