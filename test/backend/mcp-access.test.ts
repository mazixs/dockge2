import { test } from "node:test";
import assert from "node:assert/strict";
import { hashKey, parseBearer, permittedTool, safeContainer, validScope } from "../../backend/mcp-policy";

test("MCP keys require a bearer secret and never accept query or cookie identities", () => {
    assert.equal(parseBearer(undefined), null);
    assert.equal(parseBearer("Basic abc"), null);
    assert.equal(parseBearer("Bearer short"), null);
    const key = "dg_" + "a".repeat(32) + "." + "b".repeat(64);
    assert.equal(parseBearer("Bearer " + key), key);
    assert.notEqual(hashKey(key), key);
});

test("viewer denies every mutation and unknown tool independently of discovery", () => {
    for (const tool of [ "container_start", "container_stop", "container_restart", "stack_start", "stack_stop", "stack_restart", "stack_files_write", "git_preview", "git_apply", "stack_deploy", "stack_images_update", "git_clone", "exec", "usersCreate", "operation_apply" ]) {
        assert.equal(permittedTool("viewer", tool), false, tool);
    }
    assert.equal(permittedTool("viewer", "stacks_list"), true);
    assert.equal(permittedTool("operator", "exec"), false);
});

test("scope is explicit and bounded, never an endpoint or wildcard", () => {
    assert.equal(validScope([ "local" ], [ "abc" ]), true);
    assert.equal(validScope([ "*" ], [ "abc" ]), false);
    assert.equal(validScope([ "https://host" ], [ "abc" ]), false);
    assert.equal(validScope([ "local" ], [ "*" ]), false);
    assert.equal(validScope([ "local" ], []), false);
});

test("container summaries whitelist fields instead of redacting raw inspect", () => {
    const result = safeContainer({ id: "id",
        name: "name",
        state: "running",
        health: "healthy",
        startedAt: "date",
        restartCount: 2,
        env: "SECRET",
        workingDir: "/secret",
        labels: { password: "SECRET" } });
    assert.deepEqual(Object.keys(result).sort(), [ "health", "id", "name", "restartCount", "startedAt", "state" ].sort());
    assert.ok(!JSON.stringify(result).includes("SECRET"));
});

import express from "express";
import { request as httpRequest } from "node:http";
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withDatabase, createTestAccount, TEST_PASSWORD } from "../helpers/database";
import { Database } from "../../backend/database";
import { Settings } from "../../backend/settings";
import { McpKeys, synchronizeStackIdentities } from "../../backend/mcp-keys";
import { mountMcp, validateMcpURL, readMcpTool } from "../../backend/mcp-server";
import type { DockgeServer } from "../../backend/dockge-server";

/** Fresh HTTP endpoint and database; no real Docker command is performed. */
async function withMcp(callback : (ctx : { base : string; secret : string; keyId : string; cookie : string; stackId : string; server : DockgeServer; userId : string; stacksDir : string }) => Promise<void>) {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const app = express();
        const server = { app,
            stacksDir,
            config: { stacksDir,
                port: 5001 },
            isSSL: () => false,
            getBaseURL: () => "http://localhost:5001" } as unknown as DockgeServer;
        await mkdir(path.join(stacksDir, "demo"));
        await writeFile(path.join(stacksDir, "demo", "compose.yaml"), "services: {}\n");
        const [ stack ] = await synchronizeStackIdentities(Database.getKnex(), server);
        assert.ok(stack);
        const user = await Database.getKnex()("user").first();
        const keys = new McpKeys(Database.getKnex());
        const key = await keys.issue({ name: "test",
            userId: user.id,
            stacks: [ stack.id ] });
        mountMcp(server);
        const http = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => http.once("listening", resolve));
        const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
        await Settings.set("mcpConfig", { enabled: true,
            url: base + "/mcp" }, "internal");
        try {
            await callback({ base,
                secret: key.secret,
                keyId: key.id,
                cookie,
                stackId: stack.id,
                server,
                userId: user.id,
                stacksDir });
        } finally {
            await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
        }
    });
}

test("actual SDK client negotiates stateless HTTP with a Bearer key", async () => {
    await withMcp(async ({ base, secret, keyId, stackId }) => {
        const client = new Client({ name: "dockge-test",
            version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + secret } } });
        try {
            await client.connect(transport as Transport);
            const tools = await client.listTools();
            assert.equal(tools.tools.length, 5);
            const result = await client.callTool({ name: "stacks_list",
                arguments: { server_id: "local" } });
            assert.equal(result.isError, undefined);
            assert.ok(JSON.stringify(result).includes(stackId));
            for (const name of [ "stack_stop", "container_restart", "stack_files_write", "git_apply", "stack_deploy", "exec", "operation_status" ]) {
                const denied = await client.callTool({ name,
                    arguments: { server_id: "local",
                        stack_id: stackId } });
                assert.equal(denied.isError, true, name);
            }
            const extra = await client.callTool({ name: "stacks_list",
                arguments: { server_id: "local",
                    role: "admin" } });
            assert.equal(extra.isError, true);
            const remote = await client.callTool({ name: "stacks_list",
                arguments: { server_id: "other" } });
            assert.equal(remote.isError, true);
            const foreign = await client.callTool({ name: "containers_list",
                arguments: { server_id: "local",
                    stack_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" } });
            assert.equal(foreign.isError, true);
            await new McpKeys(Database.getKnex()).revoke(keyId);
            await assert.rejects(client.listTools());
        } finally {
            await client.close();
        }
    });
});

test("key metadata never contains secret or digest; expiration, owner suspension and deletion invalidate keys", async () => {
    await withMcp(async ({ secret, keyId, userId }) => {
        const knex = Database.getKnex();
        const keys = new McpKeys(knex);
        const row = await knex("mcp_key").where({ id: keyId }).first();
        assert.equal(row.secret_hash, hashKey(secret));
        const list = JSON.stringify(await keys.list());
        assert.ok(!list.includes(secret));
        assert.ok(!list.includes(row.secret_hash));
        await knex("mcp_key").where({ id: keyId }).update({ expires_at: Date.now() - 1 });
        await assert.rejects(keys.authenticate(secret));
        await knex("mcp_key").where({ id: keyId }).update({ expires_at: Date.now() + 60_000 });
        await knex("user").where({ id: userId }).update({ suspended: 1 });
        await assert.rejects(keys.authenticate(secret));
        await knex("user").where({ id: userId }).update({ suspended: 0,
            role: "viewer" });
        assert.equal((await keys.authenticate(secret)).role, "viewer");
        await knex("user").where({ id: userId }).delete();
        await assert.rejects(keys.authenticate(secret));
    });
});

test("HTTP boundary rejects missing key, cookie-only, wrong host/origin and oversized input", async () => {
    await withMcp(async ({ base, secret, cookie }) => {
        const endpoint = base + "/mcp";
        const auth = { Authorization: "Bearer " + secret };
        assert.equal((await fetch(endpoint)).status, 401);
        assert.equal((await fetch(endpoint, { headers: { Cookie: cookie } })).status, 401);
        assert.equal((await fetch(endpoint, { headers: { ...auth,
            Origin: "https://attacker.example" } })).status, 403);
        assert.equal(await new Promise<number | undefined>((resolve, reject) => {
            const req = httpRequest(endpoint, { headers: { ...auth,
                Host: "attacker.example" } }, (response) => {
                response.resume();
                resolve(response.statusCode);
            });
            req.on("error", reject);
            req.end();
        }), 403);
        assert.equal((await fetch(endpoint + "?key=x", { headers: auth })).status, 403);
        assert.equal((await fetch(endpoint, { headers: auth })).status, 405);
        assert.equal((await fetch(endpoint, { method: "POST",
            headers: { ...auth,
                "Content-Type": "application/json" },
            body: JSON.stringify({ value: "x".repeat(2 * 1024 * 1024 + 1) }) })).status, 413);
        await Settings.set("disableAuth", true);
        assert.equal((await fetch(endpoint)).status, 401);
        await Settings.set("mcpConfig", { enabled: false,
            url: endpoint }, "internal");
        assert.equal((await fetch(endpoint, { headers: auth })).status, 404);
    });
});

test("management requires actual owner session and password and cannot use machine credential", async () => {
    await withMcp(async ({ base, secret, cookie, keyId }) => {
        const endpoint = base + "/api/mcp/revoke";
        const body = JSON.stringify({ password: TEST_PASSWORD,
            data: { id: keyId } });
        const headers = { Origin: base,
            "Content-Type": "application/json" };
        assert.equal((await fetch(endpoint, { method: "POST",
            headers: { ...headers,
                Authorization: "Bearer " + secret },
            body })).status, 403);
        assert.equal((await fetch(endpoint, { method: "POST",
            headers: { ...headers,
                Cookie: cookie },
            body: JSON.stringify({ password: "wrong",
                data: { id: keyId } }) })).status, 403);
        assert.equal((await fetch(endpoint, { method: "POST",
            headers: { ...headers,
                Cookie: cookie },
            body })).status, 200);
        await assert.rejects(new McpKeys(Database.getKnex()).authenticate(secret));
    });
});

test("a recreated stack name never inherits the old resource grant", async () => {
    await withMcp(async ({ server, secret, stackId, stacksDir }) => {
        await rename(path.join(stacksDir, "demo"), path.join(stacksDir, "previous"));
        await mkdir(path.join(stacksDir, "demo"));
        await writeFile(path.join(stacksDir, "demo", "compose.yaml"), "services: {}\n");
        const identities = await synchronizeStackIdentities(Database.getKnex(), server);
        assert.notEqual(identities.find((stack) => stack.name === "demo")?.id, stackId);
        const identity = await new McpKeys(Database.getKnex()).authenticate(secret);
        const result = await readMcpTool(server, identity, "stacks_list", { server_id: "local" });
        assert.deepEqual(result, { stacks: [] });
    });
});

test("public transport configuration requires HTTPS except loopback and rejects credentials", () => {
    assert.equal(validateMcpURL("https://dockge.example/mcp").host, "dockge.example");
    assert.throws(() => validateMcpURL("http://dockge.example/mcp"));
    assert.throws(() => validateMcpURL("https://user:password@dockge.example/mcp"));
    assert.throws(() => validateMcpURL("https://dockge.example/mcp?secret=x"));
});

import { stabilityCollector } from "../../backend/stability";

test("role reduction during a read suppresses its response even when the key remains valid", async (context) => {
    await withMcp(async ({ base, secret, keyId, stackId, userId }) => {
        const knex = Database.getKnex();
        await knex("mcp_key").where({ id: keyId }).update({ role: "operator",
            actions: JSON.stringify([ "logs:read" ]),
            mode: "automatic" });
        context.mock.method(stabilityCollector, "read", async () => {
            await knex("user").where({ id: userId }).update({ role: "viewer" });
            return { observedAt: Date.now(),
                stale: false,
                windowHours: 24,
                stacks: [] };
        });
        const client = new Client({ name: "access-race",
            version: "1.0.0" });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + secret } } }) as Transport);
            const response = await client.callTool({ name: "containers_list",
                arguments: { server_id: "local",
                    stack_id: stackId } });
            assert.equal(response.isError, true);
            assert.equal((await new McpKeys(knex).authenticate(secret)).role, "viewer");
        } finally {
            await client.close();
        }
    });
});

test("scope reduction during a read suppresses the previous resource result", async (context) => {
    await withMcp(async ({ base, secret, keyId, stackId, userId, server, stacksDir }) => {
        await mkdir(path.join(stacksDir, "other"));
        await writeFile(path.join(stacksDir, "other", "compose.yaml"), "services: {}\n");
        const other = (await synchronizeStackIdentities(Database.getKnex(), server)).find(item => item.name === "other");
        assert.ok(other);
        const knex = Database.getKnex();
        await knex("mcp_key").where({ id: keyId }).update({ stacks: JSON.stringify([ stackId, other.id ]),
            resources: JSON.stringify({ local: [ stackId, other.id ] }) });
        context.mock.method(stabilityCollector, "read", async () => {
            await new McpKeys(knex).reduce(keyId, { name: "reduced",
                userId,
                stacks: [ other.id ] });
            return { observedAt: Date.now(),
                stale: false,
                windowHours: 24,
                stacks: [] };
        });
        const client = new Client({ name: "scope-race",
            version: "1.0.0" });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + secret } } }) as Transport);
            assert.equal((await client.callTool({ name: "containers_list",
                arguments: { server_id: "local",
                    stack_id: stackId } })).isError, true);
            assert.deepEqual((await new McpKeys(knex).authenticate(secret)).stacks, [ other.id ]);
        } finally {
            await client.close();
        }
    });
});

test("HTTP request rate is bounded even without a valid key", async () => {
    await withMcp(async ({ base }) => {
        for (let count = 0; count < 60; count++) {
            assert.equal((await fetch(base + "/mcp")).status, 401);
        }
        const limited = await fetch(base + "/mcp");
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get("retry-after"), "60");
    });
});

test("four pending bodies hold the concurrency limit and closing them releases capacity", async () => {
    await withMcp(async ({ base, secret }) => {
        const held = Array.from({ length: 4 }, () => {
            const request = httpRequest(base + "/mcp", { method: "POST",
                headers: { Authorization: "Bearer " + secret,
                    "Content-Type": "application/json",
                    "Content-Length": "1000" } });
            request.on("error", () => undefined);
            request.flushHeaders();
            request.write("{");
            return request;
        });
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal((await fetch(base + "/mcp", { headers: { Authorization: "Bearer " + secret } })).status, 429);
        } finally {
            held.forEach(request => request.destroy());
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal((await fetch(base + "/mcp", { headers: { Authorization: "Bearer " + secret } })).status, 405);
    });
});
