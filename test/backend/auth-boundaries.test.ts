import { strict as assert } from "node:assert";
import test from "node:test";
import type { DockgeServer } from "../../backend/dockge-server";
import {
    CLIENT_IP_HEADER,
    getAuth,
    resolveSocketIdentity,
    resolveTrustedOrigins,
    trustsProxyHeaders,
    verifyAccountPassword,
} from "../../backend/auth";
import { Settings } from "../../backend/settings";
import { clearPasswordAttempts, doubleCheckPassword, dropRevokedSessions } from "../../backend/util-server";
import type { DockgeSocket } from "../../backend/util-server";
import { createTestAccount, makeAuthenticatedSocket, TEST_PASSWORD, withDatabase } from "../helpers/database";

/**
 * A server as the origin helper sees it
 * @param options Hostname, port and TLS of the fake server
 * @returns Server stub
 */
function serverStub(options : { hostname? : string, port? : number, ssl? : boolean } = {}) : DockgeServer {
    return {
        config: {
            hostname: options.hostname ?? "",
            port: options.port ?? 5001,
        },
        isSSL: () => (options.ssl ? { key: "test" } : undefined),
    } as unknown as DockgeServer;
}

/**
 * Ask the auth endpoints the way a browser does, so origin checks and rate limits apply
 * @param path Path under the auth base path
 * @param options Body, origin, cookie and client address of the request
 * @returns Response of the handler
 */
function browserRequest(path : string, options : {
    body? : unknown,
    origin? : string,
    host? : string,
    cookie? : string,
    clientIP? : string,
} = {}) : Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });

    if (options.origin) {
        headers.set("origin", options.origin);
    }

    if (options.cookie) {
        headers.set("cookie", options.cookie);
    }

    headers.set(CLIENT_IP_HEADER, options.clientIP ?? "203.0.113.7");

    const host = options.host ?? "localhost:5001";

    return getAuth().handler(new Request(`http://${host}/api/auth${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(options.body ?? {}),
    }));
}

test("the origin of the address the browser asked for is trusted, a foreign one is not", async () => {
    const server = serverStub({ port: 5001 });

    // A deployment has no fixed address: LAN address, container name or a domain
    const lan = resolveTrustedOrigins(server, { host: "192.168.1.10:5001" });
    assert.ok(lan.includes("http://192.168.1.10:5001"));
    assert.ok(lan.includes("https://192.168.1.10:5001"));

    const domain = resolveTrustedOrigins(server, { host: "dockge.example.com" });
    assert.ok(domain.includes("https://dockge.example.com"));

    // The host of the request never makes a different site trusted
    assert.equal(domain.includes("http://evil.example.com"), false);

    // A proxy header is ignored until the operator says there is a proxy
    assert.equal(trustsProxyHeaders(), false);
    const withoutTrust = resolveTrustedOrigins(server, {
        host: "127.0.0.1:5001",
        forwardedHost: "panel.example.com",
        forwardedProto: "https",
    });
    assert.equal(withoutTrust.includes("https://panel.example.com"), false);

    process.env.DOCKGE_TRUST_PROXY = "true";

    try {
        const withTrust = resolveTrustedOrigins(server, {
            host: "127.0.0.1:5001",
            forwardedHost: "panel.example.com",
            forwardedProto: "https",
        });
        assert.ok(withTrust.includes("https://panel.example.com"));
    } finally {
        delete process.env.DOCKGE_TRUST_PROXY;
    }
});

test("an extra origin can be configured, and nothing else is added", async () => {
    process.env.DOCKGE_TRUSTED_ORIGINS = "https://panel.example.com, https://second.example.com";

    try {
        const origins = resolveTrustedOrigins(serverStub());
        assert.ok(origins.includes("https://panel.example.com"));
        assert.ok(origins.includes("https://second.example.com"));

        // Without a request there is only the configured list and the own address
        assert.deepEqual(origins.filter((origin) => origin.includes("example.com")).sort(), [
            "https://panel.example.com",
            "https://second.example.com",
        ]);
    } finally {
        delete process.env.DOCKGE_TRUSTED_ORIGINS;
    }
});

test("signing in works from the address the browser used and is refused from another site", async () => {
    await withDatabase(async () => {
        await createTestAccount();

        const sameOrigin = await browserRequest("/sign-in/email", {
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            host: "192.168.1.10:5001",
            origin: "http://192.168.1.10:5001",
        });
        assert.equal(sameOrigin.status, 200, await sameOrigin.clone().text());

        const otherSite = await browserRequest("/sign-in/email", {
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            host: "192.168.1.10:5001",
            origin: "http://evil.example.com",
        });
        assert.equal(otherSite.ok, false);
        assert.equal(otherSite.headers.get("set-cookie"), null);
    });
});

test("guessing a password over the endpoints is rate limited per client address", async () => {
    await withDatabase(async () => {
        await createTestAccount();

        const attempt = (clientIP : string) => browserRequest("/sign-in/email", {
            body: {
                email: "owner@example.com",
                password: "not-the-password",
            },
            origin: "http://localhost:5001",
            clientIP,
        });

        const statuses : number[] = [];

        for (let index = 0; index < 14; index += 1) {
            statuses.push((await attempt("198.51.100.5")).status);
        }

        assert.ok(statuses.includes(429), `expected a refused attempt, got ${statuses.join(",")}`);
        assert.ok(statuses.filter((status) => status === 401).length <= 10, `too many attempts were allowed: ${statuses.join(",")}`);

        // The address comes from our own middleware, so a header cannot buy a new budget
        const forged = await getAuth().handler(new Request("http://localhost:5001/api/auth/sign-in/email", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "origin": "http://localhost:5001",
                "x-forwarded-for": "203.0.113.99",
                [CLIENT_IP_HEADER]: "198.51.100.5",
            },
            body: JSON.stringify({
                email: "owner@example.com",
                password: "not-the-password",
            }),
        }));
        assert.equal(forged.status, 429);

        // Another client still gets its own attempts
        assert.notEqual((await attempt("198.51.100.6")).status, 429);

        // Signing in has to keep working for a person who mistyped a few times, so the
        // browser tests and a real owner do not run into the limit
        assert.ok(statuses.filter((status) => status === 401).length >= 5, `the limit is too tight: ${statuses.join(",")}`);
    });
});

test("a client whose session was revoked loses its open socket", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const session = await getAuth().api.getSession({ headers: { cookie } as never });
        const userID = session?.user?.id ?? "";

        let emitted : string | undefined;
        let disconnected = false;
        const socket = {
            ...makeAuthenticatedSocket({ cookie,
                userID }),
            emit: (event : string) => {
                emitted = event;
            },
            disconnect: () => {
                disconnected = true;
            },
        } as unknown as DockgeSocket;

        // While the session exists the client is left alone
        assert.equal(await dropRevokedSessions([ socket ]), 0);
        assert.equal(disconnected, false);

        await getAuth().api.signOut({
            headers: { cookie } as never,
            asResponse: true,
        });

        assert.equal(await dropRevokedSessions([ socket ]), 1);
        assert.equal(disconnected, true);
        assert.equal(emitted, "needAuth");
    });
});

test("with authentication disabled the socket acts as the owner and keeps working", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const session = await getAuth().api.getSession({ headers: { cookie } as never });
        const userID = session?.user?.id ?? "";

        // No cookie at all: anonymous until the setting says otherwise
        assert.deepEqual(await resolveSocketIdentity({}), {});

        await Settings.set("disableAuth", true);
        Settings.cacheList = {};

        const identity = await resolveSocketIdentity({});
        assert.equal(identity.userID, userID);
        assert.equal(identity.autoLogin, true);

        // Such a socket has no session, so confirming a password has to work without one
        const socket = makeAuthenticatedSocket({ userID });
        await doubleCheckPassword(socket, TEST_PASSWORD);
        await assert.rejects(doubleCheckPassword(socket, "wrong-password"), /Incorrect current password/);
        clearPasswordAttempts(socket);

        // And that socket must not be dropped by the periodic check
        assert.equal(await dropRevokedSessions([ makeAuthenticatedSocket({ userID }) ]), 0);
    });
});

test("password confirmation over the socket stops accepting guesses", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const socket = makeAuthenticatedSocket({ cookie,
            userID: "owner" });
        clearPasswordAttempts(socket);

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await assert.rejects(doubleCheckPassword(socket, `guess-${attempt}`), /Incorrect current password/);
        }

        // Locked: even the right password is refused now, which is what stops guessing
        await assert.rejects(doubleCheckPassword(socket, TEST_PASSWORD), /tooManyPasswordAttempts/);

        clearPasswordAttempts(socket);
        await doubleCheckPassword(socket, TEST_PASSWORD);
    });
});

test("the password of the owner is verified against the stored hash", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const session = await getAuth().api.getSession({ headers: { cookie } as never });
        const userID = session?.user?.id ?? "";

        assert.equal(await verifyAccountPassword(userID, TEST_PASSWORD), true);
        assert.equal(await verifyAccountPassword(userID, "not-the-password"), false);
        assert.equal(await verifyAccountPassword("no-such-user", TEST_PASSWORD), false);
    });
});

test("the auth secret is generated once and survives a restart", async () => {
    await withDatabase(async ({ dataDir }) => {
        const cookie = await createTestAccount();
        const secret = await Settings.get("authSecret");

        assert.equal(typeof secret, "string");
        assert.ok((secret as string).length >= 32, "a short secret would make session cookies guessable");
        assert.equal(dataDir.length > 0, true);

        // Starting again must not roll the secret, or every client would be signed out
        const { initAuth, resetAuth } = await import("../../backend/auth");
        resetAuth();
        await initAuth({
            config: {
                dataDir,
                stacksDir: dataDir,
                port: 5001,
            },
            isSSL: () => undefined,
            getBaseURL: () => "http://localhost:5001",
        } as unknown as DockgeServer);

        assert.equal(await Settings.get("authSecret"), secret);
        assert.ok(await getAuth().api.getSession({ headers: { cookie } as never }), "the session of before the restart has to stay valid");
    });
});

test("a password shorter than the policy is refused", async () => {
    await withDatabase(async () => {
        const short = await getAuth().api.signUpEmail({
            body: {
                email: "owner@example.com",
                password: "short",
                name: "Owner",
            },
            asResponse: true,
        });

        assert.equal(short.ok, false);
    });
});

test("the session cookie says how long it lives, and TLS adds the secure flag", async () => {
    await withDatabase(async () => {
        const response = await getAuth().api.signUpEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
                name: "Owner",
            },
            asResponse: true,
        });

        const maxAge = Number(/Max-Age=(\d+)/i.exec(response.headers.get("set-cookie") ?? "")?.[1]);
        assert.equal(maxAge, 7 * 24 * 60 * 60, "the session is meant to last a week");
    });

    await withDatabase(async () => {
        const response = await getAuth().api.signUpEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
                name: "Owner",
            },
            asResponse: true,
        });

        // Running with TLS, so the cookie must not travel over plain HTTP
        assert.match(response.headers.get("set-cookie") ?? "", /Secure/i);
    }, { ssl: true });
});
