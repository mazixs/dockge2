import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { DockgeServer } from "../../backend/dockge-server";
import checkVersion from "../../backend/check-version";
import { MainSocketHandler, stripGeneratedProjectName } from "../../backend/socket-handlers/main-socket-handler";
import { Settings } from "../../backend/settings";
import type { DockgeSocket } from "../../backend/util-server";
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
        assert.match(String(read.msg), /not logged in/i);

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

test("composerize converts a docker run command for a signed in client", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const converted = await emitWithCallback(socket, "composerize", "docker run -p 8080:80 nginx");
        assert.equal(converted.ok, true);
        assert.match(String(converted.composeTemplate), /nginx/);
        assert.match(String(converted.composeTemplate), /8080:80/);

        const refused = await emitWithCallback(socket, "composerize", 42);
        assert.equal(refused.ok, false);
    });
});

test("преобразование снимает только сгенерированное имя проекта", async () => {
    // Конвертер сообщает о неподдержанном флаге комментарием над строкой name,
    // и прежняя обрезка первой строки убирала сообщение, оставляя в файле
    // пользователя "name: <your project name>"
    const withComment = "# -P\nname: <your project name>\nservices:\n    nginx:\n        image: nginx\n";
    const stripped = stripGeneratedProjectName(withComment);

    assert.equal(stripped.includes("name: <your project name>"), false);
    assert.ok(stripped.startsWith("# -P"), "сообщение конвертера должно остаться");
    assert.ok(stripped.includes("services:"));

    // Файл без сгенерированного имени не меняется вообще
    const plain = "services:\n    nginx:\n        image: nginx\n";
    assert.equal(stripGeneratedProjectName(plain), plain);
});

test("composerize отдает компоуз без служебного имени проекта", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";
        new MainSocketHandler().create(socket as unknown as DockgeSocket, createServer(stacksDir));

        const converted = await emitWithCallback(socket, "composerize", "docker run -d -P nginx");
        assert.equal(converted.ok, true);

        const template = String(converted.composeTemplate);
        assert.equal(template.includes("<your project name>"), false, template);
        assert.match(template, /services:/);
        assert.match(template, /# -P/);
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
                json: async () => [{ tag_name: "v9999.0.0" }] } as Response;
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

test("saving the settings tells every open browser, not only the tab that changed them", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const cookie = await createTestAccount();
        const socket = new TestSocket(cookie);
        socket.userID = "owner";

        // The switch belongs to the panel and not to the tab that flipped it: without the
        // broadcast the indicator and the menu item stayed until the panel was restarted
        let broadcasts = 0;
        const server = createServer(stacksDir) as DockgeServer & { sendInfoToAll : () => Promise<void> };
        server.sendInfoToAll = async () => {
            broadcasts += 1;
        };

        new MainSocketHandler().create(socket as unknown as DockgeSocket, server);

        await Settings.set("checkUpdate", true, "general");
        checkVersion.latestVersion = "9999.0.0";

        const saved = await emitWithCallback(socket, "setSettings", { checkUpdate: false }, TEST_PASSWORD);
        assert.equal(saved.ok, true);

        // The client is answered before the broadcast, so the sending is started in the
        // background and the test waits for it instead of racing it
        for (let attempt = 0; attempt < 100 && broadcasts === 0; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        assert.equal(broadcasts, 1, "the other sessions were never told about the change");
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
            return Response.json([{ tag_name: "v9999.0.0" }]);
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
