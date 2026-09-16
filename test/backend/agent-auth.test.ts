import test from "node:test";
import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { toNodeHandler } from "better-auth/node";
import { getAuth } from "../../backend/auth";
import { signInAgent } from "../../backend/agent-auth";
import { createTestAccount, TEST_PASSWORD, withDatabase } from "../helpers/database";

/** Listen on a fresh local port for a real HTTP boundary test. */
async function listen(server : Server) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
}

/** Close every test connection after the assertions. */
async function close(server : Server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("agent login is shared by concurrent tabs and reused across reconnects", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        let logins = 0;
        const handler = toNodeHandler(getAuth());
        const server = createServer((request, response) => {
            logins += 1;
            return handler(request, response);
        });
        const url = await listen(server);
        try {
            const results = await Promise.allSettled(Array.from({ length: 15 }, () => signInAgent(url, "owner", TEST_PASSWORD)));
            assert.equal(results.filter((result) => result.status === "fulfilled").length, 15);
            const cookies = results.map((result) => result.status === "fulfilled" ? result.value : "");
            assert.equal(new Set(cookies).size, 1);
            assert.equal(logins, 1);
            assert.equal(await signInAgent(url, "owner", TEST_PASSWORD), cookies[0]);
            assert.equal(logins, 1);
        } finally {
            await close(server);
        }
    });
});

test("invalidating an old agent cookie coordinates renewal and cannot evict its replacement", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const { invalidateAgentSession } = await import("../../backend/agent-auth");
        let logins = 0;
        const handler = toNodeHandler(getAuth());
        const server = createServer((request, response) => {
            logins += 1;
            return handler(request, response);
        });
        const url = await listen(server);
        try {
            const original = await signInAgent(url, "owner", TEST_PASSWORD);
            invalidateAgentSession(url, "owner", TEST_PASSWORD, original);
            const replacements = await Promise.all(Array.from({ length: 15 }, () => {
                invalidateAgentSession(url, "owner", TEST_PASSWORD, original);
                return signInAgent(url, "owner", TEST_PASSWORD);
            }));
            assert.equal(new Set(replacements).size, 1);
            assert.notEqual(replacements[0], original);
            assert.equal(logins, 2);
            invalidateAgentSession(url, "owner", TEST_PASSWORD, original);
            assert.equal(await signInAgent(url, "owner", TEST_PASSWORD), replacements[0]);
            assert.equal(logins, 2);
            await assert.rejects(signInAgent(url, "owner", "changed-and-invalid-password"), /authAgentLoginFailed/);
            assert.equal(logins, 3, "different credentials must be checked instead of using the cached cookie");
        } finally {
            await close(server);
        }
    });
});

test("a shared agent login retries 429 without multiplying requests across waiting tabs", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        let logins = 0;
        const handler = toNodeHandler(getAuth());
        const server = createServer((request, response) => {
            logins += 1;
            if (logins === 1) {
                response.writeHead(429, { "retry-after": "0" });
                response.end();
                return;
            }
            return handler(request, response);
        });
        const url = await listen(server);
        try {
            const cookies = await Promise.all(Array.from({ length: 15 }, () => signInAgent(url, "owner", TEST_PASSWORD)));
            assert.equal(logins, 2);
            assert.equal(new Set(cookies).size, 1);
        } finally {
            await close(server);
        }
    });
});

test("an expired agent cookie is never reused", async () => {
    let logins = 0;
    const server = createServer((_request, response) => {
        logins += 1;
        response.writeHead(200, { "content-type": "application/json",
            "set-cookie": `better-auth.session_token=test-${logins}; Max-Age=0; HttpOnly` });
        response.end("{}");
    });
    const url = await listen(server);
    try {
        assert.notEqual(await signInAgent(url, "test-user", "test-password"), await signInAgent(url, "test-user", "test-password"));
        assert.equal(logins, 2);
    } finally {
        await close(server);
    }
});

test("an agent socket renews its revoked shared session and reconnects with the new cookie", async () => {
    await withDatabase(async () => {
        const localCookie = await createTestAccount();
        const session = await getAuth().api.getSession({ headers: { cookie: localCookie } });
        assert.ok(session?.user.id);
        const { EventEmitter } = await import("node:events");
        const { Server: SocketServer } = await import("socket.io");
        const { AgentManager } = await import("../../backend/agent-manager");
        const { makeAuthenticatedSocket } = await import("../helpers/database");
        const { getSessionFromHeaders } = await import("../../backend/auth");
        const localSocket = Object.assign(new EventEmitter(), makeAuthenticatedSocket({ cookie: localCookie,
            userID: session.user.id }));
        const manager = new AgentManager(localSocket);
        localSocket.instanceManager = manager;
        let logins = 0;
        const handler = toNodeHandler(getAuth());
        const server = createServer((request, response) => {
            logins += 1;
            return handler(request, response);
        });
        const io = new SocketServer(server);
        const remoteCookies : string[] = [];
        io.on("connection", async (socket) => {
            const remoteSession = await getSessionFromHeaders(socket.request.headers);
            if (remoteSession) {
                remoteCookies.push(socket.request.headers.cookie ?? "");
                socket.emit("authIdentity", { userID: remoteSession.user.id,
                    role: remoteSession.user.role });
            } else {
                socket.emit("needAuth");
            }
        });
        const online = () => new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("agent did not connect")), 5000);
            const listener = (event : { status : string }) => {
                if (event.status === "online") {
                    clearTimeout(timeout);
                    localSocket.off("agentStatus", listener);
                    resolve();
                }
            };
            localSocket.on("agentStatus", listener);
        });
        const url = await listen(server);
        try {
            const firstOnline = online();
            await manager.connect(url, "owner", TEST_PASSWORD);
            await firstOnline;
            const previousCookie = remoteCookies[0];
            assert.ok(previousCookie);
            await getAuth().api.signOut({ headers: { cookie: previousCookie } });
            const nextOnline = online();
            for (const socket of io.sockets.sockets.values()) {
                socket.emit("refresh");
                socket.disconnect();
            }
            await nextOnline;
            assert.equal(logins, 2);
            assert.equal(remoteCookies.length, 2);
            assert.notEqual(remoteCookies[0], remoteCookies[1]);
        } finally {
            Object.assign(localSocket, { connected: false });
            manager.disconnectAll();
            await new Promise<void>((resolve) => io.close(() => resolve()));
        }
    });
});
