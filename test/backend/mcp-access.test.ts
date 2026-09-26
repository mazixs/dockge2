import { test } from "node:test";
import assert from "node:assert/strict";
import { hashKey, parseBearer, permittedTool, safeContainer, validScope } from "../../backend/mcp-policy";

test("MCP keys require a bearer secret and never accept query or cookie identities", () => {
    assert.equal(parseBearer(undefined), null);
    assert.equal(parseBearer("Basic abc"), null);
    assert.equal(parseBearer("Bearer short"), null);
    const key = "dg2_" + "a".repeat(32) + "." + "b".repeat(64);
    assert.equal(parseBearer("Bearer " + key), key);
    assert.notEqual(hashKey(key), key);
    // Ключи, выпущенные до переименования, продолжают приниматься
    const legacy = "dg_" + "a".repeat(32) + "." + "b".repeat(64);
    assert.equal(parseBearer("Bearer " + legacy), legacy);
    assert.equal(parseBearer("Bearer dg3_" + "a".repeat(32) + "." + "b".repeat(64)), null);
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
import { McpKeys, REISSUE_OVERLAP_MS, synchronizeStackIdentities } from "../../backend/mcp-keys";
import { mountMcp, validateMcpURL, readMcpTool } from "../../backend/mcp-server";
import { flushMcpAudit, resetMcpAudit, auditReason, auditText } from "../../backend/mcp-audit";
import { failureMessage, MCP_TOOL_ORDER } from "../../backend/mcp-catalog";
import type { DockgeServer } from "../../backend/dockge-server";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

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
            await resetMcpAudit();
        }
    });
}

test("mounting the routes touches no database, which connects only after them", () => {
    const app = express();
    assert.doesNotThrow(() => mountMcp({ app,
        stacksDir: "/nonexistent",
        config: { port: 5001 } } as unknown as DockgeServer));
});

/** Rows of the MCP log, oldest first, after pending counters are written */
async function auditRows() {
    await flushMcpAudit();
    return Database.getKnex()("mcp_audit").orderBy("id", "asc");
}

test("a 2025-11-25 client still works through the stateless legacy path, and its session is logged", async () => {
    await withMcp(async ({ base, secret, keyId, stackId }) => {
        const client = new Client({ name: "dockge-test",
            version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + secret } } });
        try {
            await client.connect(transport as Transport);
            const tools = await client.listTools();
            assert.deepEqual(tools.tools.map(tool => tool.name), [ "servers_list", "stacks_list", "containers_list", "container_status", "stability_get" ]);
            assert.ok(tools.tools.every(tool => tool.annotations?.readOnlyHint === true && tool.title));
            assert.match(client.getInstructions() ?? "", /operation_prepare/);
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
        const rows = await auditRows();
        const connected = rows.find(row => row.tool === "initialize");
        assert.equal(connected?.client_name, "dockge-test");
        assert.equal(connected?.client_version, "1.0.0");
        assert.equal(connected?.protocol_version, "2025-11-25");
        assert.equal(connected?.key_id, keyId);
        assert.equal(connected?.address, "127.0.0.1");
        const listed = rows.find(row => row.tool === "tools/list");
        assert.equal(listed?.outcome, "allowed");
        const call = rows.find(row => row.tool === "stacks_list" && row.outcome === "allowed");
        assert.equal(call?.client_name, "dockge-test", "a 2025 call is attributed to the client that initialised");
        assert.equal(rows.find(row => row.tool === "unknown")?.outcome, "denied");
        const foreign = rows.find(row => row.tool === "containers_list");
        assert.equal(foreign?.stack_id, null, "a refused call does not record a stack the key cannot see");
        const refused = rows.find(row => row.outcome === "refused");
        assert.equal(refused?.reason, "revoked_key");
        assert.equal(refused?.key_id, keyId);
        assert.ok(!JSON.stringify(rows).includes(secret));
    });
});

test("a 2026-07-28 client discovers the server without a session and gets actionable argument errors", async () => {
    await withMcp(async ({ base, secret, keyId, stackId }) => {
        const client = new ModernClient({ name: "modern-test",
            version: "2.0.0" }, { versionNegotiation: { mode: "auto" } });
        try {
            await client.connect(new ModernTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + secret } } }));
            assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
            assert.equal(client.getServerVersion()?.name, "dockge2");
            assert.match(client.getInstructions() ?? "", /untrusted/);
            const tools = await client.listTools();
            assert.deepEqual(tools.tools.map(tool => tool.name), MCP_TOOL_ORDER.filter(name => tools.tools.some(tool => tool.name === name)));
            assert.equal(tools.tools.find(tool => tool.name === "stacks_list")?.title, "List stacks");
            const listed = await client.callTool({ name: "stacks_list",
                arguments: { server_id: "local" } });
            assert.ok(JSON.stringify(listed).includes(stackId));
            const invalid = await client.callTool({ name: "containers_list",
                arguments: { server_id: "local",
                    stack_id: "not-a-uuid" } });
            assert.equal(invalid.isError, true);
            assert.match(JSON.stringify(invalid.content), /Invalid arguments\. stack_id/);
            const hidden = await client.callTool({ name: "containers_list",
                arguments: { server_id: "local",
                    stack_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" } });
            assert.match(JSON.stringify(hidden.content), /Access denied or observation unavailable/);
        } finally {
            await client.close();
        }
        const rows = await auditRows();
        const discovered = rows.find(row => row.tool === "server/discover");
        assert.equal(discovered?.client_name, "modern-test");
        assert.equal(discovered?.protocol_version, "2026-07-28");
        assert.equal(discovered?.key_id, keyId);
        const invalid = rows.find(row => row.tool === "containers_list" && row.outcome === "invalid");
        assert.equal(invalid?.reason, "invalid_arguments");
        assert.equal(invalid?.client_name, "modern-test");
        assert.equal(rows.find(row => row.tool === "containers_list" && row.outcome === "denied")?.reason, "permission_denied");
    });
});

test("an operator key lists its operation tools after the reads, with honest hints", async () => {
    await withMcp(async ({ base, stackId, userId, cookie }) => {
        const issued = await new McpKeys(Database.getKnex()).issue({ name: "operator",
            userId,
            role: "operator",
            actions: [ "stacks:control", "logs:read", "deploy" ],
            mode: "approval",
            stacks: [ stackId ] });
        const client = new ModernClient({ name: "operator-test",
            version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
        try {
            await client.connect(new ModernTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + issued.secret } } }));
            const tools = (await client.listTools()).tools;
            assert.deepEqual(tools.map(tool => tool.name), [ "servers_list", "stacks_list", "containers_list", "container_status", "stability_get", "container_logs", "operation_prepare", "operation_apply", "operation_status" ]);
            const hints = Object.fromEntries(tools.map(tool => [ tool.name, tool.annotations ]));
            assert.equal(hints.operation_prepare?.readOnlyHint, false);
            assert.equal(hints.operation_prepare?.destructiveHint, false);
            assert.equal(hints.operation_apply?.destructiveHint, true);
            assert.equal(hints.operation_apply?.openWorldHint, true);
            assert.equal(hints.operation_status?.readOnlyHint, true);
            assert.equal(hints.container_logs?.readOnlyHint, true);
            const schema = JSON.stringify(tools.find(tool => tool.name === "operation_apply")?.inputSchema);
            assert.match(schema, /parameters_hash returned by operation_prepare/);
            const invalid = await client.callTool({ name: "operation_apply",
                arguments: { operation_id: "x",
                    parameters_hash: "y" } });
            assert.match(JSON.stringify(invalid.content), /Invalid arguments\. operation_id/);
            const prepared = await client.callTool({ name: "operation_prepare",
                arguments: { request_id: "restart-1",
                    action: "stack_restart",
                    parameters: { server_id: "local",
                        stack_id: stackId } } });
            const operation = (prepared.structuredContent ?? JSON.parse((prepared.content as Array<{ text : string }>)[0]!.text)) as { operation_id : string; parameters_hash : string; state : string };
            assert.equal(operation.state, "awaiting_approval");
            const early = await client.callTool({ name: "operation_apply",
                arguments: { operation_id: operation.operation_id,
                    parameters_hash: operation.parameters_hash } });
            assert.match(JSON.stringify(early.content), /Awaiting approval/);
            const approved = await fetch(base + "/api/mcp/approve", { method: "POST",
                headers: { Origin: base,
                    Cookie: cookie,
                    "Content-Type": "application/json" },
                body: JSON.stringify({ password: TEST_PASSWORD,
                    data: { id: operation.operation_id } }) });
            assert.equal(approved.status, 200);
        } finally {
            await client.close();
        }
        const rows = await auditRows();
        assert.equal(rows.find(row => row.tool === "operation_apply" && row.outcome === "denied")?.reason, "approval_required");
        const approval = rows.find(row => row.tool === "operation_approve");
        assert.equal(approval?.key_id, issued.id, "the owner's approval names the key that asked");
        assert.equal(approval?.action, "stack_restart");
        assert.equal(approval?.stack_id, stackId);
    });
});

test("failure messages name the fix only for conditions the caller can fix", () => {
    assert.match(failureMessage(new Error("mcpApprovalRequired")), /approve it in Dockge/);
    assert.match(failureMessage(new Error("mcpOperationStale")), /operation_prepare again/);
    assert.equal(failureMessage(new Error("mcpPermissionDenied")), "Access denied or observation unavailable");
    assert.equal(failureMessage(new Error("ENOENT: /opt/stacks/secret")), "Access denied or observation unavailable");
    const zod = z.object({ tail: z.number().max(200) }).safeParse({ tail: 999 });
    assert.match(failureMessage(zod.error), /^Invalid arguments\. tail: /);
    assert.equal(auditReason(new Error("mcpApprovalRequired")), "approval_required");
    assert.equal(auditReason(zod.error), "invalid_arguments");
    assert.equal(auditReason(new Error("boom")), "error");
    assert.equal(auditText("Claude\u202eCode\u0000 \n1.0"), "ClaudeCode 1.0");
    assert.equal(auditText("\u0007"), null);
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
        assert.equal((await fetch(endpoint, { method: "DELETE",
            headers: auth })).status, 405);
        assert.equal((await fetch(endpoint, { method: "POST",
            headers: { ...auth,
                "Content-Type": "application/json" },
            body: JSON.stringify({ value: "x".repeat(2 * 1024 * 1024 + 1) }) })).status, 413);
        await Settings.set("disableAuth", true);
        assert.equal((await fetch(endpoint)).status, 401);
        const rows = await auditRows();
        const reasons = rows.filter(row => row.outcome === "refused").map(row => row.reason);
        for (const reason of [ "missing_key", "origin_mismatch", "host_mismatch", "query_rejected" ]) {
            assert.ok(reasons.includes(reason), reason);
        }
        assert.equal(rows.find(row => row.reason === "missing_key")?.attempts, 3, "repeats are counted on one row");
        assert.equal(rows.find(row => row.reason === "host_mismatch")?.detail, "attacker.example");
        assert.ok(!JSON.stringify(rows).includes("key=x"), "a query is never written down");
        await Settings.set("mcpConfig", { enabled: false,
            url: endpoint }, "internal");
        assert.equal((await fetch(endpoint, { headers: auth })).status, 404);
        const discovery = await fetch(base + "/.well-known/oauth-protected-resource/mcp");
        assert.equal(discovery.status, 404);
        assert.deepEqual(await discovery.json(), { error: "not_found" });
    });
});

test("behind a declared proxy the forwarded host is accepted and the client address is logged", async () => {
    await withMcp(async ({ base }) => {
        await Settings.set("mcpConfig", { enabled: true,
            url: "https://dockge.example/mcp" }, "internal");
        const request = (headers : Record<string, string>) => fetch(base + "/mcp", { method: "POST",
            headers: { "Content-Type": "application/json",
                ...headers },
            body: "{}" });
        assert.equal((await request({ "X-Forwarded-Host": "dockge.example" })).status, 403, "without DOCKGE_TRUST_PROXY the header is ignored");
        process.env.DOCKGE_TRUST_PROXY = "true";
        try {
            assert.equal((await request({ "X-Forwarded-Host": "dockge.example",
                "X-Forwarded-For": "203.0.113.7, 10.0.0.1" })).status, 401);
        } finally {
            delete process.env.DOCKGE_TRUST_PROXY;
        }
        const rows = await auditRows();
        assert.equal(rows.find(row => row.reason === "host_mismatch")?.address, "127.0.0.1");
        assert.equal(rows.find(row => row.reason === "missing_key")?.address, "203.0.113.7");
    });
});

test("plain HTTP beyond loopback needs an explicit opt-in, and saving names the reason it failed", async () => {
    assert.throws(() => validateMcpURL("http://dockge.example/mcp"), /mcpInsecureURL/);
    assert.equal(validateMcpURL("http://dockge.example:5001/mcp", true).host, "dockge.example:5001");
    assert.throws(() => validateMcpURL("not a url", true), /mcpInvalidURL/);
    assert.throws(() => validateMcpURL("https://dockge.example/other", true), /mcpInvalidURL/);
    await withMcp(async ({ base, cookie }) => {
        const save = (data : unknown, password = TEST_PASSWORD) => fetch(base + "/api/mcp/config", { method: "POST",
            headers: { Origin: base,
                Cookie: cookie,
                "Content-Type": "application/json" },
            body: JSON.stringify({ password,
                data }) });
        const wrong = await save({ enabled: true,
            url: "https://dockge.example/mcp" }, "wrong");
        assert.equal(wrong.status, 403);
        assert.deepEqual(await wrong.json(), { error: "mcpWrongPassword" });
        const insecure = await save({ enabled: true,
            url: "http://dockge.example/mcp" });
        assert.equal(insecure.status, 400);
        assert.deepEqual(await insecure.json(), { error: "mcpInsecureURL" });
        const invalid = await save({ enabled: true,
            url: "dockge.example" });
        assert.deepEqual(await invalid.json(), { error: "mcpInvalidURL" });
        const saved = await save({ enabled: true,
            url: "http://dockge.example/mcp",
            allowInsecureHttp: true });
        assert.equal(saved.status, 200);
        assert.equal((await saved.json()).config.allowInsecureHttp, true);
        const state = await (await fetch(base + "/api/mcp", { headers: { Cookie: cookie } })).json();
        assert.equal(state.config.allowInsecureHttp, true);
        assert.ok(state.audit.some((row : { tool : string; detail : string }) => row.tool === "config_update" && row.detail === "enabled"));
    });
});

test("a reserved name can be listed, refused twice, and removed until it is cloned", async () => {
    await withMcp(async ({ base, cookie, stacksDir, server }) => {
        const call = (action : string, data : unknown) => fetch(base + "/api/mcp/" + action, { method: "POST",
            headers: { Origin: base,
                Cookie: cookie,
                "Content-Type": "application/json" },
            body: JSON.stringify({ password: TEST_PASSWORD,
                data }) });
        const reserved = await (await call("reserve", { name: "future" })).json();
        assert.equal(reserved.reserved, true);
        const duplicate = await call("reserve", { name: "future" });
        assert.equal(duplicate.status, 400);
        assert.deepEqual(await duplicate.json(), { error: "mcpStackReserved" });
        assert.deepEqual(await (await call("reserve", { name: "demo" })).json(), { error: "mcpStackExists" });
        const listed = await synchronizeStackIdentities(Database.getKnex(), server);
        assert.ok(listed.some(item => item.id === reserved.id && item.reserved));
        assert.equal((await call("unreserve", { id: reserved.id })).status, 200);
        assert.deepEqual(await (await call("unreserve", { id: reserved.id })).json(), { error: "mcpReservationMissing" });
        const [ demo ] = await synchronizeStackIdentities(Database.getKnex(), server);
        assert.deepEqual(await (await call("unreserve", { id: demo!.id })).json(), { error: "mcpReservationMissing" }, "a real stack is never removed");
        await rename(path.join(stacksDir, "demo"), path.join(stacksDir, "gone"));
        const again = await (await call("reserve", { name: "demo" })).json();
        assert.equal(again.reserved, true, "the identity of a deleted stack does not block its name");
        assert.notEqual(again.id, demo!.id);
        const tools = (await auditRows()).map(row => row.tool);
        assert.ok(tools.includes("stack_reserve") && tools.includes("stack_unreserve"));
    });
});

test("management requires actual owner session and password and cannot use machine credential", async () => {
    await withMcp(async ({ base, secret, cookie, keyId }) => {
        const endpoint = base + "/api/mcp/revoke";
        const body = JSON.stringify({ password: TEST_PASSWORD,
            data: { id: keyId } });
        const headers = { Origin: base,
            "Content-Type": "application/json" };
        const machine = await fetch(endpoint, { method: "POST",
            headers: { ...headers,
                Authorization: "Bearer " + secret },
            body });
        assert.equal(machine.status, 403);
        assert.deepEqual(await machine.json(), { error: "mcpOwnerRequired" });
        const foreign = await fetch(base + "/api/mcp", { headers: { Origin: "https://attacker.example",
            Cookie: cookie } });
        assert.equal(foreign.status, 403);
        assert.deepEqual(await foreign.json(), { error: "mcpOriginDenied" }, "a foreign page is told apart from a missing owner");
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

test("a reissued key hands over to a new secret, and the old one runs out after the overlap", async () => {
    await withMcp(async ({ base, secret, cookie, keyId }) => {
        const knex = Database.getKnex();
        const keys = new McpKeys(knex);
        const before = Date.now();
        const response = await fetch(base + "/api/mcp/reissue", { method: "POST",
            headers: { Origin: base,
                "Content-Type": "application/json",
                Cookie: cookie },
            body: JSON.stringify({ password: TEST_PASSWORD,
                data: { id: keyId } }) });
        assert.equal(response.status, 200);
        const issued = await response.json() as { id : string; secret : string; previousExpiresAt : number };
        assert.notEqual(issued.id, keyId);

        // Both work during the overlap, with the same authority
        const fresh = await keys.authenticate(issued.secret);
        const old = await keys.authenticate(secret);
        assert.deepEqual({ ...fresh,
            keyId: "" }, { ...old,
            keyId: "" });
        assert.ok(issued.previousExpiresAt >= before + REISSUE_OVERLAP_MS && issued.previousExpiresAt <= Date.now() + REISSUE_OVERLAP_MS);
        const rows = await knex("mcp_key").whereIn("id", [ keyId, issued.id ]).select("id", "expires_at");
        assert.equal(Number(rows.find((row) => row.id === keyId)?.expires_at), issued.previousExpiresAt);
        assert.ok(Number(rows.find((row) => row.id === issued.id)?.expires_at) > before + 29 * 86_400_000, "the new key gets the lifetime the old one was issued with");
        await flushMcpAudit();
        assert.ok(await knex("mcp_audit").where({ tool: "key_reissue",
            key_id: keyId }).first());

        await knex("mcp_key").where({ id: keyId }).update({ expires_at: Date.now() - 1 });
        await assert.rejects(keys.authenticate(secret));
        assert.equal((await keys.authenticate(issued.secret)).keyId, issued.id);
        await assert.rejects(keys.reissue(keyId), /mcpInvalidReissue/);
        await keys.revoke(issued.id);
        await assert.rejects(keys.reissue(issued.id), /mcpInvalidReissue/);
    });
});

test("a key whose owner lost the role is not carried forward by a reissue", async () => {
    await withMcp(async ({ stackId, userId }) => {
        const knex = Database.getKnex();
        const keys = new McpKeys(knex);
        await knex("user").where({ id: userId }).update({ role: "operator" });
        const operator = await keys.issue({ name: "operator",
            userId,
            role: "operator",
            actions: [ "stacks:control" ],
            mode: "approval",
            stacks: [ stackId ] });
        await knex("user").where({ id: userId }).update({ role: "viewer" });
        await assert.rejects(keys.reissue(operator.id), /mcpInvalidRole/);
        assert.equal(await knex("mcp_key").count({ count: "*" }).first().then((row) => Number(row?.count)), 2, "nothing was issued");
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
