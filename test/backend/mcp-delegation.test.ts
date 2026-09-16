import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { callDelegatedRead, callDelegatedTool, createDelegationRouter, type DelegatedIdentity, type DelegationConfig } from "../../backend/mcp-delegation";

const stackA = randomUUID();
const stackB = randomUUID();
const tools = [ "stacks_list", "containers_list", "container_status", "stability_get" ];

async function pair(run : (fixture : {
    origin : DelegationConfig;
    target : DelegationConfig;
    identity : DelegatedIdentity;
    state : { enabled : boolean; identity : DelegatedIdentity | null; reads : number; dispatches : number; operationTarget : {action: string; stackId: string; additionalActions?: string[]} | null; afterRead : (() => void) | null };
}) => Promise<void>) {
    const keys = [ generateKeyPairSync("ed25519"), generateKeyPairSync("ed25519") ];
    const configs : DelegationConfig[] = keys.map((key, index) => ({ serverId: index ? "target" : "origin",
        privateKey: key.privateKey.export({ type: "pkcs8",
            format: "pem" }).toString(),
        peers: [] }));
    const identity : DelegatedIdentity = { keyId: "a".repeat(32),
        userId: "owner",
        role: "viewer",
        servers: [ "target" ],
        stacks: [ stackA ],
        resources: { target: [ stackA ] },
        policyVersion: 1,
        actions: tools,
        mode: "readonly" };
    const state = { enabled: true,
        identity: identity as DelegatedIdentity | null,
        reads: 0,
        dispatches: 0,
        operationTarget: null as {action: string; stackId: string; additionalActions?: string[]} | null,
        afterRead: null as (() => void) | null };
    const servers : Server[] = [];
    try {
        for (const config of configs) {
            const app = express();
            app.use(createDelegationRouter({ getConfig: async () => config,
                authorizePeer: async () => state.enabled,
                resolveIdentity: async key => state.identity?.keyId === key ? state.identity : null,
                operationTarget: async () => state.operationTarget,
                dispatch: async (_subject, _action, _args, refresh) => {
                    await refresh();
                    state.dispatches++;
                    return { state: "prepared" };
                },
                read: async (subject, action, args) => {
                    state.reads++;
                    assert.equal(subject.role, "viewer");
                    assert.deepEqual(subject.resources, { local: [ stackA ] });
                    assert.deepEqual(subject.servers, [ "local" ]);
                    assert.equal((args as { server_id : string }).server_id, "local");
                    assert.equal(action, "stacks_list");
                    state.afterRead?.();
                    return { stacks: [{ id: stackA,
                        name: "allowed" }] };
                } }));
            const server = app.listen(0, "127.0.0.1");
            await new Promise<void>(resolve => server.once("listening", resolve));
            servers.push(server);
        }
        for (const [ index, config ] of configs.entries()) {
            const other = 1 - index;
            const address = servers[other]!.address();
            assert(address && typeof address !== "string");
            config.peers = [{ id: configs[other]!.serverId,
                name: "Isolated peer",
                url: `http://127.0.0.1:${address.port}`,
                publicKey: keys[other]!.publicKey.export({ type: "spki",
                    format: "pem" }).toString(),
                allowedStackIds: [ stackA ],
                actions: tools,
                role: "viewer",
                ownerId: "local-owner" }];
        }
        await run({ origin: configs[0]!,
            target: configs[1]!,
            identity,
            state });
    } finally {
        await Promise.all(servers.map(server => new Promise<void>(resolve => {
            server.closeAllConnections();
            server.close(() => resolve());
        })));
    }
}

test("two HTTP peers narrow server/stack scope without forwarding external credentials", async () => {
    await pair(async ({ origin, identity, state }) => {
        const result = await callDelegatedRead(origin, "target", identity, "stacks_list", { server_id: "target" });
        assert.deepEqual(result, { stacks: [{ id: stackA,
            name: "allowed" }] });
        assert.equal(state.reads, 1);
    });
});

test("wrong server, hidden stack, writes and extra fields never reach execution", async () => {
    await pair(async ({ origin, identity, state }) => {
        for (const [ action, args ] of [[ "stack_stop", { server_id: "target",
            stack_id: stackA }], [ "containers_list", { server_id: "target",
            stack_id: stackB }], [ "stacks_list", { server_id: "other" }], [ "stacks_list", { server_id: "target",
            role: "admin" }]] as const) {
            await assert.rejects(callDelegatedRead(origin, "target", identity, action, args));
        }
        assert.equal(state.reads, 0);
        await assert.rejects(callDelegatedRead(origin, "target", { ...identity,
            resources: { other: [ stackA ] } }, "stacks_list", { server_id: "target" }));
        assert.equal(state.reads, 0);
    });
});

test("issuer revocation and receiver account suspension are independently checked", async () => {
    await pair(async ({ origin, identity, state }) => {
        state.identity = null;
        await assert.rejects(callDelegatedRead(origin, "target", identity, "stacks_list", { server_id: "target" }));
        assert.equal(state.reads, 0);
        state.identity = identity;
        state.enabled = false;
        await assert.rejects(callDelegatedRead(origin, "target", identity, "stacks_list", { server_id: "target" }));
        assert.equal(state.reads, 0);
    });
});

test("revocation during observation suppresses response data", async () => {
    await pair(async ({ origin, identity, state }) => {
        state.afterRead = () => {
            state.identity = null;
        };
        await assert.rejects(callDelegatedRead(origin, "target", identity, "stacks_list", { server_id: "target" }));
        assert.equal(state.reads, 1);
    });
});

test("receiver rejects forged signatures, replay, expired envelopes and browser credentials", async () => {
    await pair(async ({ origin, identity, state }) => {
        const envelope = { kind: "read",
            issuer: "origin",
            audience: "target",
            requestId: randomUUID(),
            issuedAt: Date.now(),
            expiresAt: Date.now() + 15000,
            identity,
            action: "stacks_list",
            args: { server_id: "target" } };
        const send = async (value : unknown, signatureOverride? : string, cookie? : string) => {
            const body = JSON.stringify(value);
            return fetch(new URL("/internal/mcp-delegation/read", origin.peers[0]!.url), { method: "POST",
                headers: { "content-type": "application/json",
                    "x-dockge-signature": signatureOverride ?? sign(null, Buffer.from(body), origin.privateKey).toString("base64url"),
                    ...(cookie ? { cookie } : {}) },
                body });
        };
        assert.equal((await send(envelope, "x".repeat(86))).status, 403);
        assert.equal((await send(envelope, undefined, "better-auth.session_token=privileged")).status, 403);
        assert.equal((await send({ ...envelope,
            expiresAt: Date.now() - 1 })).status, 403);
        assert.equal(state.reads, 0);
        assert.equal((await send(envelope)).status, 200);
        assert.equal((await send(envelope)).status, 403);
        assert.equal(state.reads, 1);
    });
});

test("Git apply deployment requires the receiver deployment grant at prepare and later apply", async () => {
    await pair(async ({ origin, target, identity, state }) => {
        identity.role = "operator";
        identity.mode = "automatic";
        identity.actions = [ "git:apply", "deploy" ];
        for (const config of [ origin, target ]) {
            config.peers[0]!.role = "operator";
            config.peers[0]!.actions = [ "operation_prepare", "operation_apply", "git_apply" ];
        }
        const args = { server_id: "target",
            action: "git_apply",
            request_id: "git-deploy",
            parameters: { server_id: "target",
                stack_id: stackA,
                deploy: true } };
        await assert.rejects(callDelegatedTool(origin, "target", identity, "operation_prepare", args));
        assert.equal(state.dispatches, 0);
        origin.peers[0]!.actions.push("stack_deploy");
        await assert.rejects(callDelegatedTool(origin, "target", identity, "operation_prepare", args));
        assert.equal(state.dispatches, 0, "origin permission cannot replace receiver permission");
        target.peers[0]!.actions.push("stack_deploy");
        await callDelegatedTool(origin, "target", identity, "operation_prepare", args);
        assert.equal(state.dispatches, 1);
        state.operationTarget = { action: "git_apply",
            stackId: stackA,
            additionalActions: [ "stack_deploy" ] };
        target.peers[0]!.actions = target.peers[0]!.actions.filter(action => action !== "stack_deploy");
        await assert.rejects(callDelegatedTool(origin, "target", identity, "operation_apply", { server_id: "target",
            operation_id: randomUUID(),
            parameters_hash: "a".repeat(64) }));
        assert.equal(state.dispatches, 1, "removing deployment after preparation also prevents apply");
        target.peers[0]!.actions.push("stack_deploy");
        origin.peers[0]!.actions = origin.peers[0]!.actions.filter(action => action !== "stack_deploy");
        await assert.rejects(callDelegatedTool(origin, "target", identity, "operation_apply", { server_id: "target",
            operation_id: randomUUID(),
            parameters_hash: "a".repeat(64) }));
        assert.equal(state.dispatches, 1, "origin peer cap is rechecked for the saved concrete operation too");
    });
});
