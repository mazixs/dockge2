import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import os from "node:os";
import test from "node:test";
import { getAuth, resolveSocketIdentity } from "../../backend/auth";
import { issueUser } from "../../backend/auth-access";
import { UsersSocketHandler } from "../../backend/socket-handlers/users-socket-handler";
import type { DockgeServer } from "../../backend/dockge-server";
import { InteractiveTerminal, Terminal } from "../../backend/terminal";
import { createTestAccount, makeAuthenticatedSocket, TEST_PASSWORD, withDatabase } from "../helpers/database";

/** The account events and what the handler did to other sessions */
interface Fixture {
    call : (event : string, ...args : unknown[]) => Promise<{ ok : boolean; msg? : unknown; users? : unknown }>;
    disconnected : (string | undefined)[];
}

/**
 * Register the account events on a socket carrying the given session
 * @param cookie Session cookie of the client
 * @param userID Account the session belongs to
 * @returns How to call an event, and what was disconnected
 */
function handlerFor(cookie : string, userID : string) : Fixture {
    const socket = Object.assign(new EventEmitter(), makeAuthenticatedSocket({ cookie,
        userID }));
    const disconnected : (string | undefined)[] = [];
    const server = { disconnectAllSocketClients: (id? : string) => disconnected.push(id) } as unknown as DockgeServer;

    new UsersSocketHandler().create(socket, server);

    return {
        call: (event : string, ...args : unknown[]) => new Promise((resolve) => socket.emit(event, ...args, resolve)),
        disconnected,
    };
}

/**
 * Create an account and sign it in
 * @param username Name of the account
 * @param role Role the account is created with
 * @returns Session cookie and account id
 */
async function signIn(username : string, role : "admin" | "operator" | "viewer") : Promise<{ cookie : string, id : string }> {
    const user = await issueUser({ username,
        email: `${username}@example.com`,
        name: username,
        role,
        password: TEST_PASSWORD });
    const login = await getAuth().api.signInUsername({ body: { username,
        password: TEST_PASSWORD },
    asResponse: true });

    return { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
        id: user.id };
}

test("only the owner may see and change accounts", async () => {
    await withDatabase(async () => {
        const ownerCookie = await createTestAccount();
        const owner = await resolveSocketIdentity({ cookie: ownerCookie });
        const operator = await signIn("operator5", "operator");
        const asOwner = handlerFor(ownerCookie, owner.userID ?? "");
        const asOperator = handlerFor(operator.cookie, operator.id);

        const list = await asOwner.call("usersList");
        assert.equal(list.ok, true);
        assert.equal(Array.isArray(list.users), true);

        // An operator has a session and is still not allowed near the accounts
        const refusedList = await asOperator.call("usersList");
        assert.equal(refusedList.ok, false);
        assert.equal(refusedList.msg, "authPermissionDenied");

        const refusedCreate = await asOperator.call("usersCreate", { username: "sneak",
            email: "sneak@example.com",
            role: "admin",
            password: TEST_PASSWORD }, TEST_PASSWORD);
        assert.equal(refusedCreate.ok, false);
        assert.equal(refusedCreate.msg, "authPermissionDenied");
    });
});

test("a refused account creation says what is wrong without quoting the database", async () => {
    await withDatabase(async () => {
        const ownerCookie = await createTestAccount();
        const owner = await resolveSocketIdentity({ cookie: ownerCookie });
        const { call } = handlerFor(ownerCookie, owner.userID ?? "");

        const shortPassword = await call("usersCreate", { username: "newuser",
            email: "newuser@example.com",
            role: "operator",
            password: "short" }, TEST_PASSWORD);
        assert.equal(shortPassword.ok, false);
        assert.equal(shortPassword.msg, "authPasswordLength");

        const created = await call("usersCreate", { username: "newuser",
            email: "newuser@example.com",
            name: "New User",
            role: "operator",
            password: TEST_PASSWORD }, TEST_PASSWORD);
        assert.equal(created.ok, true);

        // The second attempt fails inside the database. What comes back is a message the
        // catalogue knows, not the text of a constraint
        const duplicate = await call("usersCreate", { username: "newuser",
            email: "newuser@example.com",
            name: "New User",
            role: "operator",
            password: TEST_PASSWORD }, TEST_PASSWORD);
        assert.equal(duplicate.ok, false);
        assert.equal(duplicate.msg, "authAccountExists");
    });
});

test("changing an account without naming it is refused, and removing one ends its sessions", async () => {
    await withDatabase(async () => {
        const ownerCookie = await createTestAccount();
        const owner = await resolveSocketIdentity({ cookie: ownerCookie });
        const victim = await signIn("operator6", "operator");
        const { call, disconnected } = handlerFor(ownerCookie, owner.userID ?? "");

        for (const event of [ "usersUpdate", "usersResetPassword", "usersDelete" ]) {
            const noID = await call(event, { role: "viewer" }, TEST_PASSWORD);
            assert.equal(noID.ok, false, event);
            assert.equal(noID.msg, "authInvalidUserData", event);
        }

        // A shell the account left open has to end with its access, not only its connections
        const shell = new InteractiveTerminal({ stacksDir: os.tmpdir() } as unknown as DockgeServer, "container-exec-victim", process.execPath,
            [ "-e", "setInterval(() => {}, 1000);" ], os.tmpdir(), { user: victim.id,
                client: "" });
        shell.start();

        const demoted = await call("usersUpdate", { id: victim.id,
            role: "viewer" }, TEST_PASSWORD);
        assert.equal(demoted.ok, true);

        // A changed role has to reach the open browser of that account, which is why its
        // clients are disconnected rather than left with the rights they connected with
        assert.deepEqual(disconnected, [ victim.id ]);
        const deadline = Date.now() + 10_000;
        while (Terminal.getTerminal(shell.name, shell.owner) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(Terminal.getTerminal(shell.name, shell.owner), undefined, "the shell of a demoted account ends");

        const removed = await call("usersDelete", { id: victim.id }, TEST_PASSWORD);
        assert.equal(removed.ok, true);
        assert.deepEqual(disconnected, [ victim.id, victim.id ]);

        const gone = await call("usersDelete", { id: victim.id }, TEST_PASSWORD);
        assert.equal(gone.ok, false);
        assert.equal(gone.msg, "authUnknownUser");
    });
});

test("every change to an account asks for the password of the owner making it", async () => {
    await withDatabase(async () => {
        const ownerCookie = await createTestAccount();
        const owner = await resolveSocketIdentity({ cookie: ownerCookie });
        const other = await signIn("operator7", "operator");
        const { call, disconnected } = handlerFor(ownerCookie, owner.userID ?? "");

        const create = await call("usersCreate", { username: "unconfirmed",
            email: "unconfirmed@example.com",
            role: "admin",
            password: TEST_PASSWORD }, "wrong-password");
        assert.equal(create.ok, false);
        assert.equal(create.msg, "incorrectCurrentPassword", "the refusal is not masked as an existing account");

        for (const [ event, data ] of [
            [ "usersUpdate", { id: other.id,
                role: "admin" }],
            [ "usersResetPassword", { id: other.id,
                password: "another-long-password" }],
            [ "usersDelete", { id: other.id }],
        ] as const) {
            const refused = await call(event, data, "wrong-password");
            assert.equal(refused.ok, false, event);
        }

        const missing = await call("usersDelete", { id: other.id }, undefined);
        assert.equal(missing.ok, false);

        assert.deepEqual(disconnected, [], "nothing changed, so nobody was disconnected");
        const list = await call("usersList");
        const users = list.users as { username : string; role : string }[];
        assert.equal(users.some((user) => user.username === "unconfirmed"), false);
        assert.equal(users.find((user) => user.username === "operator7")?.role, "operator");
    });
});
