import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
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
import { Database } from "../../backend/database";
import { generatePasswordHash } from "../../backend/password-hash";
import { User } from "../../backend/models/user";
import { withDatabase } from "../helpers/database";

function makeSocket(userID: number): DockgeSocket {
    return { userID } as DockgeSocket;
}

test("server utilities validate login and serialize callback results and errors", () => {
    assert.doesNotThrow(() => checkLogin(makeSocket(1)));
    assert.throws(() => checkLogin(makeSocket(0)), /You are not logged in/);

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

test("doubleCheckPassword uses the persisted user password", async () => {
    await withDatabase(async () => {
        const password = generatePasswordHash("current-password");
        await Database.getKnex()("user").insert({
            username: "password-user",
            password,
            active: 1,
            twofa_status: 0,
        });
        const user = await User.findByUsername("password-user");
        assert.ok(user);

        const { doubleCheckPassword } = await import("../../backend/util-server");
        const socket = makeSocket(user.id);
        const checked = await doubleCheckPassword(socket, "current-password");
        assert.equal(checked.username, "password-user");
        await assert.rejects(doubleCheckPassword(socket, "wrong-password"), /Incorrect current password/);
        await assert.rejects(doubleCheckPassword(socket, 123), /Wrong data type/);
    });
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
        assert.equal(loaded.composeENV, "");
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
            "ps",
            "--format",
            "json",
        ]);
    } finally {
        await rm(stacksDir, { recursive: true,
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
