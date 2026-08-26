import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import type { DockgeServer } from "../../backend/dockge-server";
import { MainSocketHandler } from "../../backend/socket-handlers/main-socket-handler";
import type { DockgeSocket } from "../../backend/util-server";
import { User } from "../../backend/models/user";
import { verifyPassword } from "../../backend/password-hash";
import { Settings } from "../../backend/settings";
import { withDatabase } from "../helpers/database";

interface CallbackResponse {
    ok?: boolean;
    msg?: string;
    token?: string;
    tokenRequired?: boolean;
    composeTemplate?: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
}

class TestSocket extends EventEmitter {
    id = "test-socket";
    userID = 0;
    endpoint = "";
    connected = true;
    instanceManager = {};
    emittedAgents: unknown[][] = [];

    emitAgent(eventName: string, ...args: unknown[]) {
        this.emittedAgents.push([ eventName, ...args ]);
    }
}

function createServer(socket: TestSocket, stacksDir: string): DockgeServer {
    return {
        needSetup: true,
        jwtSecret: "test-jwt-secret",
        stacksDir,
        getClientIP: async () => "127.0.0.1",
        afterLogin: async (currentSocket: DockgeSocket, user: User) => {
            currentSocket.userID = user.id;
        },
        disconnectAllSocketClients: () => undefined,
        sendInfo: () => undefined,
        sendStackList: () => undefined,
        socket,
    } as unknown as DockgeServer;
}

function emitWithCallback(socket: TestSocket, eventName: string, ...args: unknown[]): Promise<CallbackResponse> {
    return new Promise((resolve) => {
        socket.emit(eventName, ...args, (response: CallbackResponse) => resolve(response));
    });
}

test("MainSocketHandler executes setup, login, token, settings and composerize flows", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const socket = new TestSocket();
        const server = createServer(socket, stacksDir);
        const handler = new MainSocketHandler();

        handler.create(socket as unknown as DockgeSocket, server);

        const weakSetup = await emitWithCallback(socket, "setup", "admin", "weak");
        assert.equal(weakSetup.ok, false);
        assert.match(weakSetup.msg ?? "", /too weak/i);

        const setup = await emitWithCallback(socket, "setup", "admin", "StrongPassword123");
        assert.deepEqual(setup, {
            ok: true,
            msg: "successAdded",
            msgi18n: true,
        });
        assert.equal(server.needSetup, false);

        const repeatedSetup = await emitWithCallback(socket, "setup", "other", "StrongPassword123");
        assert.equal(repeatedSetup.ok, false);
        assert.match(repeatedSetup.msg ?? "", /initialized/i);

        const invalidLogin = await emitWithCallback(socket, "login", {
            username: "admin",
            password: "wrong-password",
        });
        assert.deepEqual(invalidLogin, {
            ok: false,
            msg: "authIncorrectCreds",
            msgi18n: true,
        });

        const login = await emitWithCallback(socket, "login", {
            username: "admin",
            password: "StrongPassword123",
        });
        assert.equal(login.ok, true);
        assert.equal(typeof login.token, "string");
        assert.equal(socket.userID, 1);

        const byToken = await emitWithCallback(socket, "loginByToken", login.token);
        assert.deepEqual(byToken, { ok: true });

        const invalidToken = await emitWithCallback(socket, "loginByToken", "invalid-token");
        assert.deepEqual(invalidToken, {
            ok: false,
            msg: "authInvalidToken",
            msgi18n: true,
        });

        const settingsBefore = await emitWithCallback(socket, "getSettings");
        assert.equal(settingsBefore.ok, true);
        assert.equal(settingsBefore.data?.globalENV, "# VARIABLE=value #comment");

        const setSettings = await emitWithCallback(socket, "setSettings", {
            checkUpdate: false,
            globalENV: "GLOBAL=value\n",
        }, "StrongPassword123");
        assert.deepEqual(setSettings, {
            ok: true,
            msg: "Saved",
        });
        assert.equal(await Settings.get("checkUpdate"), false);

        const settingsAfter = await emitWithCallback(socket, "getSettings");
        assert.equal(settingsAfter.data?.globalENV, "GLOBAL=value\n");

        const changedPassword = await emitWithCallback(socket, "changePassword", {
            currentPassword: "StrongPassword123",
            newPassword: "NewStrongPassword123",
        });
        assert.deepEqual(changedPassword, {
            ok: true,
            msg: "Password has been updated successfully.",
        });
        const updatedUser = await User.findByUsername("admin");
        assert.ok(updatedUser);
        assert.equal(verifyPassword("NewStrongPassword123", updatedUser.password), true);

        const composerized = await emitWithCallback(socket, "composerize", "docker run --name web nginx:latest");
        assert.equal(composerized.ok, true);
        assert.match(composerized.composeTemplate ?? "", /services:/);

        const invalidComposerize = await emitWithCallback(socket, "composerize", 123);
        assert.deepEqual(invalidComposerize, {
            ok: false,
            type: 1,
            msg: "dockerRunCommand must be a string",
            msgi18n: true,
        });

        await mkdir(`${stacksDir}/unused`, { recursive: true });
    });
});

test("MainSocketHandler login validates input before querying the database", async () => {
    await withDatabase(async () => {
        const handler = new MainSocketHandler();
        assert.equal(await handler.login(123 as never, "password"), null);
        assert.equal(await handler.login("missing", "password"), null);
    });
});
