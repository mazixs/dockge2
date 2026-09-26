import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { DockgeServer } from "../../backend/dockge-server";
import { releaseAssets } from "../helpers/releases";
import checkVersion from "../../backend/check-version";
import { MainSocketHandler } from "../../backend/socket-handlers/main-socket-handler";
import { Settings } from "../../backend/settings";
import { MainTerminal, Terminal } from "../../backend/terminal";
import { CONSOLE_OPERATORS_SETTING, listUsers } from "../../backend/auth-access";
import { CONTAINER_CONTROL_SETTING, SET_CONTAINER_CONTROL_EVENT } from "../../common/types/container";
import type { DockgeSocket } from "../../backend/util-server";
import { MAX_DOCKER_RUN_COMMAND_LENGTH } from "../../common/docker-run-flags";
import { createTestAccount, TEST_PASSWORD, withDatabase } from "../helpers/database";

interface CallbackResponse {
    ok? : boolean;
    msg? : string;
    needsSetup? : boolean;
    composeTemplate? : string;
    data? : Record<string, unknown>;
    [key : string] : unknown;
}

/**
 * A socket that records what the handler sends, with an optional session cookie
 */
class TestSocket extends EventEmitter {
    id = "test-socket";
    userID = "";
    userRole? : string;
    endpoint = "";
    connected = true;
    instanceManager = {};
    request : { headers : Record<string, string> };

    constructor(cookie? : string) {
        super();
        this.request = { headers: cookie ? { cookie } : {} };
    }

    emitAgent() {
        // The tests do not look at agent traffic
    }
}

/**
 * Emit an event and wait for its acknowledgement
 * @param socket Socket the handler listens on
 * @param eventName Event to emit
 * @param args Arguments without the callback
 * @returns Callback response
 */
function emitWithCallback(socket : TestSocket, eventName : string, ...args : unknown[]) : Promise<CallbackResponse> {
    return new Promise((resolve) => {
        socket.emit(eventName, ...args, (response : CallbackResponse) => resolve(response));
    });
}

/**
 * Build a server stub the handler can work with
 * @param stacksDir Directory holding the stacks
 * @returns Server stub
 */
function createServer(stacksDir : string) : DockgeServer {
    return {
        needSetup: true,
        stacksDir,
        getClientIP: async () => "127.0.0.1",
        disconnectAllSocketClients: () => undefined,
        sendInfo: () => undefined,
        sendStackList: () => undefined,
    } as unknown as DockgeServer;
}

test("the setup screen follows the database, not a flag decided at start up", async () => {
    await withDatabase(async ({ stacksDir }) => {
        // The real server object, because this is exactly the decision that used to be
        // cached and kept sending the owner back to the setup screen after setup
        const { DockgeServer } = await import("../../backend/dockge-server");
        const server = Object.create(DockgeServer.prototype) as DockgeServer;

        assert.equal(await server.shouldShowSetup(), true);

        await createTestAccount();

        assert.equal(await server.shouldShowSetup(), false);
        assert.equal(stacksDir.length > 0, true);
    });
});

test("needsSetup reports whether this instance still has to create an account", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const socket = new TestSocket();
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const before = await emitWithCallback(socket, "needsSetup");
        assert.equal(before.ok, true);
        assert.equal(before.needsSetup, true);

        await createTestAccount();

        const after = await emitWithCallback(socket, "needsSetup");
        assert.equal(after.needsSetup, false);
    });
});

test("settings are refused for a client without a session", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const socket = new TestSocket();
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const read = await emitWithCallback(socket, "getSettings");
        assert.equal(read.ok, false);
        assert.match(String(read.msg), /notLoggedIn/);

        const write = await emitWithCallback(socket, "setSettings", { primaryHostname: "evil.example.com" }, "");
        assert.equal(write.ok, false);
        assert.equal(await Settings.get("primaryHostname"), undefined);
    });
});

test("a signed in client reads and writes the known settings only", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const saved = await emitWithCallback(socket, "setSettings", {
            primaryHostname: "dockge.example.com",
            checkUpdate: false,
            // Not a general setting: it must not reach the database through this event
            stackFiles: { evil: true },
        }, TEST_PASSWORD);
        assert.equal(saved.ok, true);

        assert.equal(await Settings.get("primaryHostname"), "dockge.example.com");
        assert.equal(await Settings.get("checkUpdate"), false);
        assert.equal(await Settings.get("stackFiles"), undefined);

        const read = await emitWithCallback(socket, "getSettings");
        assert.equal(read.ok, true);
        assert.equal(read.data?.primaryHostname, "dockge.example.com");
    });
});

test("disabling authentication requires the current password", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const wrong = await emitWithCallback(socket, "setSettings", { disableAuth: true }, "wrong-password");
        assert.equal(wrong.ok, false);
        assert.equal(await Settings.get("disableAuth"), undefined);

        const right = await emitWithCallback(socket, "setSettings", { disableAuth: true }, TEST_PASSWORD);
        assert.equal(right.ok, true);
        assert.equal(await Settings.get("disableAuth"), true);
    });
});

test("only an owner turns the console on, with the password, and turning it off ends the session", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        const server = createServer(stacksDir);
        new MainSocketHandler().create(socket as unknown as DockgeSocket, server);

        socket.userRole = "operator";
        const operator = await emitWithCallback(socket, "setConsoleEnabled", true, TEST_PASSWORD);
        assert.equal(operator.ok, false);
        assert.equal(await Settings.get(MainTerminal.SETTING), undefined);

        socket.userRole = "admin";
        const wrong = await emitWithCallback(socket, "setConsoleEnabled", true, "wrong-password");
        assert.equal(wrong.ok, false);
        assert.equal(await Settings.get(MainTerminal.SETTING), undefined);

        const notBoolean = await emitWithCallback(socket, "setConsoleEnabled", "true", TEST_PASSWORD);
        assert.equal(notBoolean.ok, false);

        const on = await emitWithCallback(socket, "setConsoleEnabled", true, TEST_PASSWORD);
        assert.equal(on.ok, true);
        assert.equal(on.msg, "consoleTurnedOn");
        assert.equal(await MainTerminal.enabled(), true);

        const session = await MainTerminal.open(server, socket as unknown as DockgeSocket);
        session.start();

        // Taking the console away asks for no password, and leaves no shell behind
        const off = await emitWithCallback(socket, "setConsoleEnabled", false, "");
        assert.equal(off.ok, true);
        assert.equal(Terminal.forClient(socket as unknown as DockgeSocket, MainTerminal.NAME), undefined);
        await assert.rejects(MainTerminal.open(server, socket as unknown as DockgeSocket), /consoleOff/);
    });
});

test("only an owner lets operators control unmanaged containers, and only with the password", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        socket.userRole = "operator";
        assert.equal((await emitWithCallback(socket, SET_CONTAINER_CONTROL_EVENT, true, TEST_PASSWORD)).ok, false);
        socket.userRole = "admin";
        assert.equal((await emitWithCallback(socket, SET_CONTAINER_CONTROL_EVENT, true, "wrong-password")).ok, false);
        assert.equal((await emitWithCallback(socket, SET_CONTAINER_CONTROL_EVENT, "true", TEST_PASSWORD)).ok, false);
        assert.equal(await Settings.get(CONTAINER_CONTROL_SETTING), undefined, "off until an owner confirms");

        const on = await emitWithCallback(socket, SET_CONTAINER_CONTROL_EVENT, true, TEST_PASSWORD);
        assert.equal(on.msg, "containerControlTurnedOn");
        assert.equal(await Settings.get(CONTAINER_CONTROL_SETTING), true);

        const off = await emitWithCallback(socket, SET_CONTAINER_CONTROL_EVENT, false, "");
        assert.equal(off.msg, "containerControlTurnedOff");
        assert.equal(await Settings.get(CONTAINER_CONTROL_SETTING), false);
    });
});

test("letting operators into the console takes the password, and narrowing it ends their sessions only", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const owner = new TestSocket(cookie);
        owner.userID = String((await listUsers())[0]?.id);
        const server = createServer(stacksDir);
        await Settings.set(MainTerminal.SETTING, true, "console");
        new MainSocketHandler().create(owner as unknown as DockgeSocket, server);

        owner.userRole = "operator";
        const refused = await emitWithCallback(owner, "setConsoleOperators", true, TEST_PASSWORD);
        assert.equal(refused.ok, false);

        owner.userRole = "admin";
        const wrong = await emitWithCallback(owner, "setConsoleOperators", true, "wrong-password");
        assert.equal(wrong.ok, false);
        assert.equal(await Settings.get(CONSOLE_OPERATORS_SETTING), undefined);

        const allowed = await emitWithCallback(owner, "setConsoleOperators", true, TEST_PASSWORD);
        assert.equal(allowed.ok, true);
        assert.equal(allowed.msg, "consoleOperatorsAllowed");
        assert.equal(await Settings.get(CONSOLE_OPERATORS_SETTING), true);

        const operator = new TestSocket();
        operator.id = "operator-socket";
        operator.userID = "operator";
        const ownerSession = await MainTerminal.open(server, owner as unknown as DockgeSocket);
        const operatorSession = await MainTerminal.open(server, operator as unknown as DockgeSocket);
        assert.notEqual(ownerSession, operatorSession, "every user has a console of their own");
        ownerSession.start();
        operatorSession.start();

        try {
            const narrowed = await emitWithCallback(owner, "setConsoleOperators", false, "");
            assert.equal(narrowed.ok, true);
            assert.equal(narrowed.msg, "consoleOwnersOnlySet");
            assert.equal(await Settings.get(CONSOLE_OPERATORS_SETTING), false);
            assert.equal(Terminal.forClient(operator as unknown as DockgeSocket, MainTerminal.NAME), undefined);
            assert.equal(Terminal.forClient(owner as unknown as DockgeSocket, MainTerminal.NAME), ownerSession, "the owner keeps working");
        } finally {
            await MainTerminal.closeSessions();
        }
    });
});

test("the global env file is written and removed through the settings event", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const written = await emitWithCallback(socket, "setSettings", { globalENV: "GLOBAL=value\n" }, TEST_PASSWORD);
        assert.equal(written.ok, true);
        assert.equal(await readFile(path.join(stacksDir, "global.env"), "utf8"), "GLOBAL=value\n");

        const cleared = await emitWithCallback(socket, "setSettings", { globalENV: "" }, TEST_PASSWORD);
        assert.equal(cleared.ok, true);
        await assert.rejects(readFile(path.join(stacksDir, "global.env"), "utf8"));
    });
});

test("the conversion converts a docker run command for a signed in client", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const converted = await emitWithCallback(socket, "convertDockerRun", "docker run -p 8080:80 nginx");
        assert.equal(converted.ok, true);
        assert.equal(converted.composeTemplate, "services:\n  nginx:\n    image: nginx\n    ports:\n      - 8080:80\n");
        assert.deepEqual(converted.report, { carried: [{ flag: "-p",
            value: "8080:80",
            outcome: "carried" }],
        review: [],
        dropped: [] });

        const refused = await emitWithCallback(socket, "convertDockerRun", 42);
        assert.equal(refused.ok, false);
    });
});

test("the conversion refuses a command that names no image, with a reason", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const refused = await emitWithCallback(socket, "convertDockerRun", "docker run -d -p 8080:80");
        assert.equal(refused.ok, false);
        assert.equal(refused.msg, "dockerRunNoImage");
        assert.equal(refused.msgi18n, true);
    });
});

test("the conversion names a lost flag in the report and writes no project name", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const converted = await emitWithCallback(socket, "convertDockerRun", "docker run -d -P nginx");
        assert.equal(converted.ok, true);

        const template = String(converted.composeTemplate);
        assert.equal(template, "services:\n  nginx:\n    image: nginx\n");
        assert.deepEqual(converted.report, { carried: [{ flag: "-d",
            outcome: "carried",
            reason: "flagNotNeeded" }],
        review: [],
        dropped: [{ flag: "-P",
            outcome: "dropped",
            reason: "flagPublishAllDropped" }] });
    });
});

test("the conversion refuses a command over the length limit before converting it", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const prefix = "docker run -e X=";
        const suffix = " nginx";
        const fill = MAX_DOCKER_RUN_COMMAND_LENGTH - prefix.length - suffix.length;

        const atLimit = await emitWithCallback(socket, "convertDockerRun", `${prefix}${"a".repeat(fill)}${suffix}`);
        assert.equal(atLimit.ok, true, JSON.stringify(atLimit));

        // The converter would accept this one too: only the limit can refuse it
        const overLimit = await emitWithCallback(socket, "convertDockerRun", `${prefix}${"a".repeat(fill + 1)}${suffix}`);
        assert.equal(overLimit.ok, false);
        assert.deepEqual(overLimit.msg, { key: "dockerRunCommandTooLong",
            values: { max: String(MAX_DOCKER_RUN_COMMAND_LENGTH) } });

        // A pasted megabyte is refused at once instead of blocking the server for minutes
        const started = performance.now();
        const huge = await emitWithCallback(socket, "convertDockerRun", `docker run ${"-e A=B ".repeat(150_000)}nginx`);
        assert.equal(huge.ok, false);
        assert.ok(performance.now() - started < 1000);
    });
});

test("the conversion converts a command copied with sudo", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const converted = await emitWithCallback(socket, "convertDockerRun", "sudo docker run -d -p 8080:80 nginx");
        assert.equal(converted.ok, true, JSON.stringify(converted));
        assert.match(String(converted.composeTemplate), /8080:80/);
    });
});

test("turning the update check on answers on the screen that turned it on", { timeout: 30_000 }, async (context) => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";

        const asked : string[] = [];
        context.mock.method(globalThis, "fetch", async (url : unknown) => {
            asked.push(String(url));
            return { ok: true,
                json: async () => [{ tag_name: "v9999.0.0",
                    assets: releaseAssets }] } as Response;
        });

        let informed : () => void = () => undefined;
        const infoSent = new Promise<void>((resolve) => {
            informed = resolve;
        });
        // Every signed-in browser is told, not only the tab that saved the switch: the
        // setting belongs to the panel, and a second tab must not keep the old answer
        const server = Object.assign(createServer(stacksDir), { sendInfoToAll: () => {
            informed();
        } });

        new MainSocketHandler().create(socket as unknown as DockgeSocket, server);

        const saved = await emitWithCallback(socket, "setSettings", { checkUpdate: true }, TEST_PASSWORD);
        assert.equal(saved.ok, true);

        // The interval that normally asks runs every 48 hours. Saving the switch and
        // saying nothing until the next restart is what made this setting look broken,
        // so the answer has to be fetched before the client is told about itself
        await infoSent;

        assert.deepEqual(asked.length, 1, "the registry was not asked before the client was informed");
        assert.equal(checkVersion.latestVersion, "9999.0.0");
        assert.equal(checkVersion.updateAvailable, true);

        checkVersion.latestVersion = undefined;
    });
});

test("only the owner can manually check updates, without changing the automatic setting", async (context) => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = Object.assign(new TestSocket(cookie), { userID: "owner",
            userRole: "operator" });
        let requests = 0;
        context.mock.method(globalThis, "fetch", async () => {
            requests++;
            return Response.json([{ tag_name: "v9999.0.0",
                assets: releaseAssets }]);
        });
        const server = Object.assign(createServer(stacksDir), { sendInfoToAll: async () => {} });
        new MainSocketHandler().create(socket as unknown as DockgeSocket, server);
        checkVersion.resume();
        const denied = await emitWithCallback(socket, "checkForUpdates");
        assert.equal(denied.ok, false);
        assert.equal(requests, 0);

        socket.userRole = "admin";
        const result = await emitWithCallback(socket, "checkForUpdates");
        assert.equal(result.ok, true);
        assert.equal(result.latestVersion, "9999.0.0");
        assert.equal(result.updateAvailable, true);
        assert.notEqual(await Settings.get("checkUpdate"), true);
        checkVersion.latestVersion = undefined;
    });
});
