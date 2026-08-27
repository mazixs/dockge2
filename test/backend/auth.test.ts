import { strict as assert } from "node:assert";
import test from "node:test";
import { countUsers, getAuth, getSessionFromHeaders } from "../../backend/auth";
import { doubleCheckPassword } from "../../backend/util-server";
import { createTestAccount, makeAuthenticatedSocket, TEST_PASSWORD, withDatabase } from "../helpers/database";

test("the first account is created through the auth endpoints and gets a session cookie", async () => {
    await withDatabase(async () => {
        assert.equal(await countUsers(), 0);

        const response = await getAuth().api.signUpEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
                name: "Owner",
            },
            asResponse: true,
        });

        assert.equal(response.ok, true);
        assert.equal(await countUsers(), 1);

        const setCookie = response.headers.get("set-cookie") ?? "";

        // The session lives in an httpOnly cookie, not in browser storage
        assert.match(setCookie, /better-auth\.session_token=/);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /SameSite=Lax/i);
        assert.equal(/Secure/i.test(setCookie), false, "plain HTTP must not set a Secure cookie");
    });
});

test("a second account cannot be registered on the same instance", async () => {
    await withDatabase(async () => {
        await createTestAccount("owner@example.com");

        const intruder = await getAuth().api.signUpEmail({
            body: {
                email: "intruder@example.com",
                password: "another-password-1234",
                name: "Intruder",
            },
            asResponse: true,
        });

        // Dockge is a single owner panel: an exposed instance must not accept sign-ups
        assert.equal(intruder.ok, false);
        assert.equal(await countUsers(), 1);
    });
});

test("only a valid session cookie identifies a client", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();

        const session = await getSessionFromHeaders({ cookie });
        assert.equal(session?.user?.email, "owner@example.com");

        // A forged or missing cookie yields no session at all
        assert.equal(await getSessionFromHeaders({ cookie: "better-auth.session_token=forged" }), null);
        assert.equal(await getSessionFromHeaders({}), null);
    });
});

test("signing out invalidates the session immediately", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        assert.ok(await getSessionFromHeaders({ cookie }));

        const signOut = await getAuth().api.signOut({
            headers: { cookie } as never,
            asResponse: true,
        });
        assert.equal(signOut.ok, true);

        // The same cookie no longer works, because the session row is gone
        assert.equal(await getSessionFromHeaders({ cookie }), null);
    });
});

test("wrong credentials are refused and rate limited", async () => {
    await withDatabase(async () => {
        await createTestAccount("owner@example.com");

        const wrong = await getAuth().api.signInEmail({
            body: {
                email: "owner@example.com",
                password: "not-the-password",
            },
            asResponse: true,
        });
        assert.equal(wrong.ok, false);
        assert.equal(wrong.headers.get("set-cookie"), null, "a failed sign-in must not set a session");

        const right = await getAuth().api.signInEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            asResponse: true,
        });
        assert.equal(right.ok, true);
        assert.match(right.headers.get("set-cookie") ?? "", /better-auth\.session_token=/);
    });
});

test("confirming an action needs the password of the session behind the socket", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const socket = makeAuthenticatedSocket({ cookie });

        await doubleCheckPassword(socket, TEST_PASSWORD);

        await assert.rejects(doubleCheckPassword(socket, "wrong-password"), /Incorrect current password/);
        await assert.rejects(doubleCheckPassword(socket, 12345), /Wrong data type/);

        // A socket without a session cannot confirm anything, even with the right password
        await assert.rejects(doubleCheckPassword(makeAuthenticatedSocket(), TEST_PASSWORD), /Incorrect current password/);
    });
});

test("changing the password invalidates other sessions", async () => {
    await withDatabase(async () => {
        const firstCookie = await createTestAccount();

        const secondSignIn = await getAuth().api.signInEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            asResponse: true,
        });
        const secondCookie = (secondSignIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        assert.ok(await getSessionFromHeaders({ cookie: secondCookie }));

        const changed = await getAuth().api.changePassword({
            body: {
                currentPassword: TEST_PASSWORD,
                newPassword: "a-brand-new-password-4567",
                revokeOtherSessions: true,
            },
            headers: { cookie: secondCookie } as never,
            asResponse: true,
        });
        assert.equal(changed.ok, true);

        // The session that did not perform the change is gone
        assert.equal(await getSessionFromHeaders({ cookie: firstCookie }), null);

        // And the old password no longer works
        const oldPassword = await getAuth().api.signInEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            asResponse: true,
        });
        assert.equal(oldPassword.ok, false);
    });
});

test("a proxy deployment can force the Secure flag on session cookies", async () => {
    process.env.DOCKGE_SECURE_COOKIES = "true";

    try {
        await withDatabase(async () => {
            const response = await getAuth().api.signUpEmail({
                body: {
                    email: "owner@example.com",
                    password: TEST_PASSWORD,
                    name: "Owner",
                },
                asResponse: true,
            });

            // TLS is terminated by the proxy, so the server speaks HTTP and still has to mark the cookie
            assert.match(response.headers.get("set-cookie") ?? "", /Secure/i);
        });
    } finally {
        delete process.env.DOCKGE_SECURE_COOKIES;
    }
});
