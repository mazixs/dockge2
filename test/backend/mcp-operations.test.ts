import test from "node:test";
import assert from "node:assert/strict";
import knex from "knex";
import { z } from "zod";
import { McpOperations } from "../../backend/mcp-operations";
import { up } from "../../backend/migrations/2026-09-11-1400-mcp-operations";
import type { MachineIdentity } from "../../backend/mcp-keys";

const stackId = "00000000-0000-4000-8000-000000000001";
const identity: MachineIdentity = { keyId: "key",
    userId: "owner",
    role: "operator",
    servers: [ "local" ],
    stacks: [ stackId ],
    resources: { local: [ stackId ] },
    actions: [ "stacks:control" ],
    mode: "automatic",
    policyVersion: 1 };

async function fixture(t: test.TestContext) {
    const db = knex({ client: "better-sqlite3",
        connection: { filename: ":memory:" },
        useNullAsDefault: true });
    t.after(() => db.destroy());
    await up(db);
    await db.schema.createTable("user", table => {
        table.string("id");
        table.string("role");
        table.integer("suspended");
    });
    await db("user").insert({ id: "owner",
        role: "admin",
        suspended: 0 });
    let current = structuredClone(identity);
    let executions = 0;
    let unchanged = true;
    const service = new McpOperations(db, async key => {
        if (key !== current.keyId) {
            throw new Error("revoked");
        }
        return current;
    });
    service.register("stack_restart", { requiredAction: "stacks:control",
        schema: z.object({ stack_id: z.literal(stackId) }).strict(),
        prepare: async () => ({ serverId: "local",
            stackId,
            fingerprint: "hash",
            summary: "Restart stack",
            revalidate: async () => unchanged,
            execute: async () => {
                executions++;
                return { completed: true,
                    stderr: "SECRET" };
            } }) });
    const prepare = (id = "request") => service.call(current, "operation_prepare", { action: "stack_restart",
        request_id: id,
        parameters: { stack_id: stackId } }) as Promise<{ operation_id: string; parameters_hash: string; state: string }>;
    return { db,
        service,
        prepare,
        executions: () => executions,
        change: () => {
            unchanged = false;
        },
        current: () => current,
        setIdentity: (value: MachineIdentity) => {
            current = value;
        } };
}

test("durable idempotency prevents concurrent and repeated execution and persists only safe metadata", async t => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    assert.equal(f.executions(), 0);
    const request = { operation_id: prepared.operation_id,
        parameters_hash: prepared.parameters_hash };
    await Promise.all([ f.service.call(identity, "operation_apply", request), f.service.call(identity, "operation_apply", request) ]);
    await f.service.call(identity, "operation_apply", request);
    assert.equal(f.executions(), 1);
    assert.equal((await f.prepare()).operation_id, prepared.operation_id);
    assert.ok(!JSON.stringify(await f.db("mcp_operation")).includes("SECRET"));
    const restarted = new McpOperations(f.db, async () => identity);
    await restarted.call(identity, "operation_apply", request);
    assert.equal(f.executions(), 1);
    await assert.rejects(f.service.call(identity, "operation_apply", { ...request,
        parameters_hash: "0".repeat(64) }));
});

test("foreign keys, viewer, revocation, changed scope and stale source cannot execute", async t => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    const request = { operation_id: prepared.operation_id,
        parameters_hash: prepared.parameters_hash };
    await assert.rejects(f.service.call({ ...identity,
        keyId: "foreign" }, "operation_status", { operation_id: prepared.operation_id }));
    for (const current of [{ ...identity,
        role: "viewer" as const }, { ...identity,
        resources: {} }, { ...identity,
        policyVersion: 2 }, { ...identity,
        keyId: "revoked" }]) {
        f.setIdentity(current);
        await assert.rejects(f.service.call(identity, "operation_apply", request));
    }
    f.setIdentity(identity);
    f.change();
    await assert.rejects(f.service.call(identity, "operation_apply", request));
    assert.equal(f.executions(), 0);
});

test("owner approval is one-time, machine input cannot bypass it and expired drafts never apply", async t => {
    const f = await fixture(t);
    f.setIdentity({ ...identity,
        mode: "approval" });
    const prepared = await f.prepare();
    const request = { operation_id: prepared.operation_id,
        parameters_hash: prepared.parameters_hash };
    await assert.rejects(f.service.call(f.current(), "operation_apply", { ...request,
        approved_by: "owner" }));
    await assert.rejects(f.service.call(f.current(), "operation_apply", request));
    await assert.rejects(f.service.approve("key", prepared.operation_id));
    await f.service.approve("owner", prepared.operation_id);
    await assert.rejects(f.service.approve("owner", prepared.operation_id));
    await f.service.call(f.current(), "operation_apply", request);
    assert.equal(f.executions(), 1);
    const later = await f.prepare("later");
    await f.db("mcp_operation").where({ id: later.operation_id }).update({ expires_at: 0 });
    await assert.rejects(f.service.approve("owner", later.operation_id));
    await assert.rejects(f.service.call(f.current(), "operation_apply", { operation_id: later.operation_id,
        parameters_hash: later.parameters_hash }));
});

test("strict action schemas reject extra fields and crash-lost preparations cannot execute", async t => {
    const f = await fixture(t);
    for (const parameters of [{ stack_id: stackId,
        command: "shell" }, { stack_id: "foreign" }]) {
        await assert.rejects(f.service.call(identity, "operation_prepare", { action: "stack_restart",
            request_id: "bad",
            parameters }));
    }
    const prepared = await f.prepare();
    const restarted = new McpOperations(f.db, async () => identity);
    await assert.rejects(restarted.call(identity, "operation_apply", { operation_id: prepared.operation_id,
        parameters_hash: prepared.parameters_hash }));
    assert.equal(f.executions(), 0);
});

import { Stack } from "../../backend/stack";
import { ContainerOperations } from "../../backend/container-operations";
import type { ContainerRuntime } from "../../common/stability";

test("UI and MCP share lifecycle command selection without rewriting Compose", async () => {
    const commands: string[][] = [];
    let validated = 0;
    const stack = { validateComposeConfig: async () => {
        validated++;
    },
    getComposeOptions: (command: string, ...args: string[]) => [ "compose", "-f", "compose.yaml", command, ...args ],
    path: "/isolated" } as unknown as Stack;
    for (const action of [ "start", "stop", "restart" ] as const) {
        await Stack.prototype.control.call(stack, action, async (args, cwd) => {
            assert.equal(cwd, "/isolated");
            commands.push(args);
            return 0;
        });
    }
    assert.equal(validated, 1);
    assert.deepEqual(commands, [[ "compose", "-f", "compose.yaml", "up", "-d", "--remove-orphans" ], [ "compose", "-f", "compose.yaml", "stop" ], [ "compose", "-f", "compose.yaml", "restart" ]]);
});

test("container control checks actual immutable ID, managed path and declared service before side effects", async () => {
    const id = "a".repeat(64);
    let rows = [{ id,
        workingDir: "/isolated/app",
        service: "web" }] as ContainerRuntime[];
    const commands: string[][] = [];
    const operations = new ContainerOperations(async () => rows, async args => {
        commands.push(args);
        return { code: 0,
            stdout: "",
            stderr: "",
            signal: null,
            killed: false };
    });
    const stack = { path: "/isolated/app",
        isManagedByDockge: true,
        composeYAML: "services:\n  web:\n    image: nginx\n" } as unknown as Stack;
    await operations.control(stack, id, "restart");
    assert.deepEqual(commands, [[ "restart", id ]]);
    for (const changed of [[], [{ id,
        workingDir: "/another/app",
        service: "web" }], [{ id,
        workingDir: "/isolated/app",
        service: "foreign" }]]) {
        rows = changed as ContainerRuntime[];
        await assert.rejects(operations.control(stack, id, "stop"));
    }
    await assert.rejects(operations.control(stack, "--all", "stop"));
    assert.equal(commands.length, 1);
});

test("logs enforce line and time bounds and suppress subprocess error details", async () => {
    const id = "a".repeat(64);
    let calls = 0;
    const operations = new ContainerOperations(async () => [{ id,
        workingDir: "/isolated/app",
        service: "web" }] as ContainerRuntime[], async () => {
        calls++;
        throw new Error("SECRET stderr");
    });
    const stack = { path: "/isolated/app",
        isManagedByDockge: true,
        composeYAML: "services:\n  web:\n    image: nginx\n" } as unknown as Stack;
    await assert.rejects(operations.logs(stack, id, 201, 60));
    await assert.rejects(operations.logs(stack, id, 100, 86401));
    assert.equal(calls, 0);
    await assert.rejects(operations.logs(stack, id, 100, 60), error => String(error) === "Error: mcpOperationFailed");
});

import { CREATED_STACK, RUNNING } from "../../common/util-common";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stackOperationFingerprint } from "../../backend/mcp-operations";

test("shared image update preserves stopped stacks and restarts only running stacks", async () => {
    for (const status of [ CREATED_STACK, RUNNING ]) {
        const commands: string[][] = [];
        const stack = { status,
            path: "/isolated",
            validateComposeConfig: async () => {},
            updateStatus: async () => {},
            getComposeOptions: (command: string, ...args: string[]) => [ command, ...args ] } as unknown as Stack;
        await Stack.prototype.control.call(stack, "update", async args => {
            commands.push(args);
            return 0;
        });
        assert.deepEqual(commands, status === RUNNING ? [[ "pull" ], [ "up", "-d", "--remove-orphans" ]] : [[ "pull" ]]);
    }
});

test("operation fingerprint preserves byte distinctions and rejects symlinks", async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-fingerprint-"));
    t.after(() => rm(directory, { recursive: true,
        force: true }));
    await writeFile(path.join(directory, "compose.yaml"), "# comment\r\nservices: {}\r\n");
    const original = await stackOperationFingerprint(directory);
    assert.equal(await stackOperationFingerprint(directory), original);
    await writeFile(path.join(directory, "compose.yaml"), "# comment\nservices: {}\n");
    assert.notEqual(await stackOperationFingerprint(directory), original);
    await writeFile(path.join(directory, "compose.yaml"), "services:\n  app:\n    env_file: other.yaml\n");
    await symlink("compose.yaml", path.join(directory, "other.yaml"));
    await assert.rejects(stackOperationFingerprint(directory));
});

test("runtime data is excluded but all declared Compose inputs stay bound", async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-runtime-"));
    t.after(() => rm(directory, { recursive: true,
        force: true }));
    await writeFile(path.join(directory, "compose.yaml"), "services:\n  app:\n    image: nginx\n    env_file: app.env\n    volumes: [./database:/data]\n");
    await writeFile(path.join(directory, "app.env"), "VALUE=one\n");
    await writeFile(path.join(directory, "database"), Buffer.alloc(2 * 1024 * 1024));
    const before = await stackOperationFingerprint(directory);
    await writeFile(path.join(directory, "database"), "runtime changed");
    assert.equal(await stackOperationFingerprint(directory), before);
    await writeFile(path.join(directory, "app.env"), "VALUE=two\n");
    assert.notEqual(await stackOperationFingerprint(directory), before);
    await writeFile(path.join(directory, "compose.yaml"), "services:\n  app:\n    build: .\n");
    await assert.rejects(stackOperationFingerprint(directory));
    await stackOperationFingerprint(directory, undefined, { deployment: false });
});

test("revocation guard after container inspection prevents the command", async () => {
    let calls = 0;
    const id = "a".repeat(64);
    const service = new ContainerOperations(async () => [{ id,
        workingDir: "/isolated",
        service: "web" }] as ContainerRuntime[], async () => {
        calls++;
        return { code: 0,
            stdout: "",
            stderr: "",
            killed: false,
            signal: null };
    });
    const stack = { path: "/isolated",
        isManagedByDockge: true,
        composeYAML: "services:\n  web:\n    image: nginx\n" } as unknown as Stack;
    await assert.rejects(service.control(stack, id, "stop", async () => {
        throw new Error("revoked");
    }));
    assert.equal(calls, 0);
});

test("tool discovery excludes actions without grants", async t => {
    const f = await fixture(t);
    assert.deepEqual(f.service.getToolDefinitions({ ...identity,
        role: "viewer",
        mode: "readonly",
        actions: [] }), []);
    const denied = f.service.getToolDefinitions({ ...identity,
        actions: [] });
    assert.equal(denied.find(tool => tool.name === "operation_prepare")?.inputSchema.oneOf?.length, 0);
    const allowed = f.service.getToolDefinitions(identity);
    assert.equal(allowed.find(tool => tool.name === "operation_prepare")?.inputSchema.oneOf?.length, 1);
});

test("exact owner review is volatile and unavailable to machine status or non-owner", async t => {
    const f = await fixture(t);
    f.service.register("stack_stop", { requiredAction: "stacks:control",
        schema: z.object({}).strict(),
        prepare: async () => ({ serverId: "local",
            stackId,
            fingerprint: "hash",
            summary: "Stop",
            ownerReview: { content: "sensitive review" },
            revalidate: async () => true,
            execute: async () => ({ completed: true }) }) });
    const prepared = await f.service.call(identity, "operation_prepare", { action: "stack_stop",
        request_id: "review",
        parameters: {} }) as { operation_id: string };
    assert.ok(JSON.stringify(await f.service.review("owner", prepared.operation_id)).includes("sensitive review"));
    await assert.rejects(f.service.review("key", prepared.operation_id));
    assert.ok(!JSON.stringify(await f.service.call(identity, "operation_status", { operation_id: prepared.operation_id })).includes("sensitive review"));
    assert.ok(!JSON.stringify(await f.db("mcp_operation")).includes("sensitive review"));
    await assert.rejects(f.service.call(identity, "operation_prepare", { action: "stack_restart",
        request_id: "review",
        parameters: { stack_id: stackId } }), /mcpRequestChanged/);
});

test("an interrupted running operation is unknown after restart and cannot execute again", async t => {
    const f = await fixture(t);
    const prepared = await f.prepare();
    await f.db("mcp_operation").where({ id: prepared.operation_id }).update({ state: "running" });
    const restarted = new McpOperations(f.db, async () => identity);
    const status = await restarted.call(identity, "operation_status", { operation_id: prepared.operation_id }) as { state: string };
    assert.equal(status.state, "unknown");
    const result = await restarted.call(identity, "operation_apply", { operation_id: prepared.operation_id,
        parameters_hash: prepared.parameters_hash }) as { state: string };
    assert.equal(result.state, "unknown");
    assert.equal(f.executions(), 0);
});

import { containerOperationFingerprint } from "../../backend/container-operations";

test("last container check rejects a replaced start state before the command", async () => {
    const id = "a".repeat(64);
    const row = { id,
        workingDir: "/isolated",
        service: "web",
        state: "running",
        startedAt: 1 } as ContainerRuntime;
    let calls = 0;
    const service = new ContainerOperations(async () => [{ ...row,
        startedAt: 2 }], async () => {
        calls++;
        return { code: 0,
            stdout: "",
            stderr: "",
            signal: null,
            killed: false };
    });
    const stack = { path: "/isolated",
        isManagedByDockge: true,
        composeYAML: "services:\n  web:\n    image: nginx\n" } as unknown as Stack;
    await assert.rejects(service.control(stack, id, "stop", async () => {}, containerOperationFingerprint(row)), /mcpOperationStale/);
    assert.equal(calls, 0);
});
