import { strict as assert } from "node:assert";
import test from "node:test";
import { getAuth } from "../../backend/auth";
import { withDatabase, TEST_PASSWORD } from "../helpers/database";

test("public registration is disabled even before the first owner exists", async () => {
    await withDatabase(async () => {
        const response = await getAuth().api.signUpEmail({
            body: { email: "intruder@example.com",
                name: "Intruder",
                password: TEST_PASSWORD },
            asResponse: true,
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
    });
});

// These tests exercise the HTTP bootstrap boundary and real better-auth sessions.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { authorizeSocketEvent, changeUserAccess, issueUser, resetUserPassword, roleAllowsEvent } from "../../backend/auth-access";
import { countUsers, getSessionFromHeaders } from "../../backend/auth";
import { Database } from "../../backend/database";
import { createTestAccount, makeAuthenticatedSocket } from "../helpers/database";

let bootstrapRequestNumber = 0;

/** Send setup through the same handler as the browser, including origin checks. */
function bootstrap(token : string, overrides : Record<string, unknown> = {}, origin = "http://localhost:5001") {
    return getAuth().handler(new Request("http://localhost:5001/api/auth/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json",
            origin,
            "x-dockge-client-ip": `192.0.2.${++bootstrapRequestNumber}` },
        body: JSON.stringify({ token,
            username: "owner",
            name: "Owner",
            email: "owner@example.com",
            password: TEST_PASSWORD,
            ...overrides }),
    }));
}

test("first owner needs the local token and a same-origin request", async () => {
    await withDatabase(async ({ dataDir }) => {
        const tokenPath = path.join(dataDir, "bootstrap-token");
        const token = (await readFile(tokenPath, "utf8")).trim();
        assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
        assert.ok(token.length >= 32);
        assert.equal((await bootstrap("x".repeat(token.length))).status, 403);
        assert.equal((await bootstrap(token, {}, "https://attacker.example")).status, 403);
        assert.equal(await countUsers(), 0);
        const created = await bootstrap(token);
        assert.equal(created.status, 200, await created.clone().text());
        assert.equal((await Database.getKnex()("user").first()).role, "admin");
        await assert.rejects(readFile(tokenPath), { code: "ENOENT" });
        assert.notEqual((await bootstrap(token)).status, 200);
    });
});

test("parallel setup requests can create exactly one owner and credential account", async () => {
    await withDatabase(async ({ dataDir }) => {
        const token = (await readFile(path.join(dataDir, "bootstrap-token"), "utf8")).trim();
        const responses = await Promise.all([ bootstrap(token), bootstrap(token, { username: "other",
            email: "other@example.com" }) ]);
        assert.equal(responses.filter((response) => response.ok).length, 1);
        assert.equal(await countUsers(), 1);
        assert.equal((await Database.getKnex()("account")).length, 1);
    });
});

test("viewer cannot request raw files, logs, Docker actions, agent management or unknown events", () => {
    for (const event of [ "getStack", "getStackFiles", "revealSecret", "terminalJoin", "mainTerminal", "deployStack", "deleteStack", "saveEnvFile", "futureEvent" ]) {
        assert.equal(roleAllowsEvent("viewer", event, true), false, event);
    }
    assert.equal(roleAllowsEvent("viewer", "usersCreate"), false);
    assert.equal(roleAllowsEvent("operator", "setSettings"), false);
    assert.equal(roleAllowsEvent("operator", "usersUpdate"), false);
    assert.equal(roleAllowsEvent("operator", "startStack", true), true);
    assert.equal(roleAllowsEvent("viewer", "stabilityOverview", true), true);
});

test("username and existing email login both work; self-update cannot escalate a role", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        await issueUser({ username: "observer",
            email: "viewer@example.com",
            name: "Observer",
            password: TEST_PASSWORD,
            role: "viewer" });
        const login = await getAuth().api.signInUsername({ body: { username: "OBSERVER",
            password: TEST_PASSWORD },
        asResponse: true });
        assert.equal(login.status, 200, await login.clone().text());
        const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        await getAuth().api.updateUser({ headers: { cookie },
            body: { role: "admin" } as never,
            asResponse: true });
        const user = await Database.getKnex()("user").where("username", "observer").first();
        assert.equal(user.role, "viewer");
        const socket = makeAuthenticatedSocket({ cookie,
            userID: user.id });
        await authorizeSocketEvent(socket, "stabilityOverview", true);
        await assert.rejects(authorizeSocketEvent(socket, "getStack", true), /authPermissionDenied/);
        await changeUserAccess(user.id, { suspended: true });
        await assert.rejects(authorizeSocketEvent(socket, "stabilityOverview", true), /authSessionExpired/);
        const suspended = await getAuth().api.signInUsername({ body: { username: "observer",
            password: TEST_PASSWORD },
        asResponse: true });
        assert.equal(suspended.ok, false);
    });
});

test("password reset revokes current cookies and role changes affect already open sockets", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const user = await issueUser({ username: "operator",
            email: "operator@example.com",
            name: "Operator",
            password: TEST_PASSWORD,
            role: "operator" });
        const login = await getAuth().api.signInUsername({ body: { username: "operator",
            password: TEST_PASSWORD },
        asResponse: true });
        const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const socket = makeAuthenticatedSocket({ cookie,
            userID: user.id });
        await authorizeSocketEvent(socket, "startStack", true);
        await resetUserPassword(user.id, "changed-password-1234");
        assert.equal(await getSessionFromHeaders({ cookie }), null);
        await assert.rejects(authorizeSocketEvent(socket, "startStack", true), /authSessionExpired/);
        await changeUserAccess(user.id, { role: "viewer" });
        const nextLogin = await getAuth().api.signInUsername({ body: { username: "operator",
            password: "changed-password-1234" },
        asResponse: true });
        const nextCookie = (nextLogin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        await assert.rejects(authorizeSocketEvent(makeAuthenticatedSocket({ cookie: nextCookie,
            userID: user.id }), "startStack", true), /authPermissionDenied/);
    });
});

test("last active owner cannot be suspended, demoted or removed, including concurrent changes", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const owner = await Database.getKnex()("user").first();
        for (const change of [{ remove: true }, { role: "viewer" }, { suspended: true }]) {
            await assert.rejects(changeUserAccess(owner.id, change), /authLastOwner/);
        }
        const second = await issueUser({ username: "second",
            email: "second@example.com",
            name: "Second",
            password: TEST_PASSWORD,
            role: "admin" });
        const results = await Promise.allSettled([ changeUserAccess(owner.id, { remove: true }), changeUserAccess(second.id, { remove: true }) ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal((await Database.getKnex()("user").where({ role: "admin",
            suspended: 0 })).length, 1);
    });
});

test("migration preserves the owner identity, password and existing cookie", async () => {
    await withDatabase(async ({ dataDir }) => {
        const cookie = await createTestAccount();
        const before = await getSessionFromHeaders({ cookie });
        assert.ok(before?.user.id);
        await Database.getKnex()("user").where("id", before.user.id).update({ role: "viewer" });
        const { initializeAccess } = await import("../../backend/auth-access");
        await initializeAccess(dataDir, false);
        const after = await getSessionFromHeaders({ cookie });
        assert.equal(after?.user.id, before.user.id);
        assert.equal(after?.user.role, "admin");
        const signedIn = await getAuth().api.signInEmail({ body: { email: "owner@example.com",
            password: TEST_PASSWORD },
        asResponse: true });
        assert.equal(signedIn.ok, true);
    });
});

test("remote agents sign in through better-auth and do not mistake a 2FA challenge for a session", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const { createServer } = await import("node:http");
        const { toNodeHandler } = await import("better-auth/node");
        const { signInAgent, invalidateAgentSession } = await import("../../backend/agent-auth");
        const server = createServer(toNodeHandler(getAuth()));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}`;
        try {
            const cookie = await signInAgent(url, "owner", TEST_PASSWORD);
            assert.equal((await getSessionFromHeaders({ cookie }))?.user.username, "owner");
            await assert.rejects(signInAgent(url, "owner", "invalid-password"), /authAgentLoginFailed/);
            await Database.getKnex()("user").where("username", "owner").update({ twoFactorEnabled: 1 });
            invalidateAgentSession(url, "owner", TEST_PASSWORD, cookie);
            await assert.rejects(signInAgent(url, "owner", TEST_PASSWORD), /authAgentTwoFactor/);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});

test("viewer agent calls are enforced before forwarding and hide raw status errors", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const user = await issueUser({ username: "watcher",
            email: "watcher@example.com",
            name: "Watcher",
            role: "viewer",
            password: TEST_PASSWORD });
        const login = await getAuth().api.signInUsername({ body: { username: "watcher",
            password: TEST_PASSWORD },
        asResponse: true });
        const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        const { EventEmitter } = await import("node:events");
        const { AgentProxySocketHandler } = await import("../../backend/socket-handlers/agent-proxy-socket-handler");
        const { AgentSocket } = await import("../../common/agent-socket");
        const socket = Object.assign(new EventEmitter(), makeAuthenticatedSocket({ cookie,
            userID: user.id }));
        let forwarded = 0;
        socket.instanceManager = {
            emitToEndpoint: async (_endpoint : string, _event : string, callback : (response : unknown) => void) => {
                forwarded += 1;
                callback({ ok: false,
                    msg: "Compose failed near SECRET=example-private-value" });
            },
        } as never;
        new AgentProxySocketHandler().create2(socket, {} as never, new AgentSocket());
        const call = (event : string) => new Promise<{ ok : boolean; msg : string }>((resolve) => socket.emit("agent", "remote.example", event, resolve));
        const denied = await call("deployStack");
        assert.equal(denied.ok, false);
        assert.equal(denied.msg, "authPermissionDenied");
        assert.equal(forwarded, 0);
        const status = await call("stabilityOverview");
        assert.equal(forwarded, 1);
        assert.equal(status.msg, "authStatusUnavailable");
        assert.equal(JSON.stringify(status).includes("example-private-value"), false);
    });
});

test("reading settings never writes auth secrets or their cached values to debug logs", async (context) => {
    await withDatabase(async () => {
        const { Settings } = await import("../../backend/settings");
        const { log } = await import("../../backend/log");
        const messages : string[] = [];
        context.mock.method(log, "debug", (_module : string, message : unknown) => messages.push(String(message)));
        await Settings.set("authSecret", "synthetic-test-secret-must-not-appear-in-logs", "internal");
        await Settings.get("authSecret");
        await Settings.get("authSecret");
        assert.equal(messages.some((message) => message.includes("synthetic-test-secret")), false);
    });
});

test("local account recovery removes the setup claim and creates a fresh code on restart", async () => {
    await withDatabase(async ({ dataDir }) => {
        const tokenPath = path.join(dataDir, "bootstrap-token");
        const token = (await readFile(tokenPath, "utf8")).trim();
        assert.equal((await bootstrap(token)).ok, true);
        const { resetInstanceAccounts, initializeAccess } = await import("../../backend/auth-access");
        await resetInstanceAccounts();
        assert.equal(await countUsers(), 0);
        await initializeAccess(dataDir, true);
        const freshToken = (await readFile(tokenPath, "utf8")).trim();
        assert.notEqual(freshToken, token);
        assert.equal((await bootstrap(freshToken)).ok, true);
        assert.equal(await countUsers(), 1);
    });
});

test("an HTTPS public URL enables Secure cookies and rejects an explicit insecure override", async () => {
    const publicURL = process.env.DOCKGE_PUBLIC_URL;
    const secureCookies = process.env.DOCKGE_SECURE_COOKIES;
    try {
        process.env.DOCKGE_PUBLIC_URL = "HTTPS://panel.example.com";
        delete process.env.DOCKGE_SECURE_COOKIES;
        await withDatabase(async () => {
            await createTestAccount();
            const login = await getAuth().api.signInEmail({ body: { email: "owner@example.com",
                password: TEST_PASSWORD },
            asResponse: true });
            assert.match(login.headers.get("set-cookie") ?? "", /; Secure/i);
        });
        process.env.DOCKGE_SECURE_COOKIES = " false ";
        await assert.rejects(withDatabase(async () => undefined), /HTTPS public URL requires secure cookies/);
    } finally {
        if (publicURL === undefined) {
            delete process.env.DOCKGE_PUBLIC_URL;
        } else {
            process.env.DOCKGE_PUBLIC_URL = publicURL;
        }
        if (secureCookies === undefined) {
            delete process.env.DOCKGE_SECURE_COOKIES;
        } else {
            process.env.DOCKGE_SECURE_COOKIES = secureCookies;
        }
    }
});
