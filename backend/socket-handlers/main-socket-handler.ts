import composerize from "composerize";
import type { LooseObject } from "../../common/util-common";
import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { countUsers } from "../auth";
import {
    callbackError,
    callbackResult,
    checkLogin,
    DockgeSocket,
    doubleCheckPassword,
    ValidationError
} from "../util-server";
import checkVersion from "../check-version";
import { Settings } from "../settings";
import fs, { promises as fsAsync } from "fs";
import path from "path";
import { runInBackground } from "../background";
import { MainTerminal } from "../terminal";
import { CONSOLE_OPERATORS_SETTING, listUsers } from "../auth-access";

export class MainSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {

        // ***************************
        // Public Socket API
        // ***************************

        // Setup
        // Whether this instance still needs its first account.
        // Creating it goes through the auth endpoints, not through this socket.
        socket.on("needsSetup", async (callback) => {
            try {
                callbackResult({
                    ok: true,
                    needsSetup: await countUsers() === 0,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("getSettings", async (callback) => {
            try {
                checkLogin(socket);
                if (socket.userRole && socket.userRole !== "admin") {
                    callbackResult({ ok: true,
                        data: { disableAuth: Boolean(await Settings.get("disableAuth")) } }, callback);
                    return;
                }
                const data = await Settings.getSettings("general");

                if (fs.existsSync(path.join(server.stacksDir, "global.env"))) {
                    data.globalENV = fs.readFileSync(path.join(server.stacksDir, "global.env"), "utf-8");
                } else {
                    data.globalENV = "# VARIABLE=value #comment";
                }

                callbackResult({
                    ok: true,
                    data: data,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        socket.on("checkForUpdates", async (callback) => {
            try {
                checkLogin(socket);
                if (socket.userRole !== "admin") {
                    throw new ValidationError("authPermissionDenied");
                }
                const result = await checkVersion.check(true);
                callbackResult(result ?? {
                    ok: false,
                    msg: "updateCheckFailed",
                    msgi18n: true,
                }, callback);
                if (result) {
                    runInBackground("server info", () => server.sendInfoToAll());
                }
            } catch (error) {
                callbackError(error, callback);
            }
        });

        socket.on("setSettings", async (data, currentPassword, callback) => {
            try {
                checkLogin(socket);

                // If currently is disabled auth, don't need to check
                // Disabled Auth + Want to Disable Auth => No Check
                // Disabled Auth + Want to Enable Auth => No Check
                // Enabled Auth + Want to Disable Auth => Check!!
                // Enabled Auth + Want to Enable Auth => No Check
                const currentDisabledAuth = await Settings.get("disableAuth");
                if (!currentDisabledAuth && data.disableAuth) {
                    await doubleCheckPassword(socket, currentPassword);
                }
                // Handle global.env
                if (data.globalENV && data.globalENV != "# VARIABLE=value #comment") {
                    await fsAsync.writeFile(path.join(server.stacksDir, "global.env"), data.globalENV);
                } else {
                    await fsAsync.rm(path.join(server.stacksDir, "global.env"), {
                        recursive: true,
                        force: true
                    });
                }
                delete data.globalENV;

                await Settings.setSettings("general", pickGeneralSettings(data));

                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);

                // The check is asked for here rather than left to the interval, which is
                // two days long: whoever just turned it on is looking at the screen now.
                // Every open browser is told, because the setting belongs to the panel
                // and not to the tab that changed it
                runInBackground("server info", async () => {
                    await checkVersion.check();
                    await server.sendInfoToAll();
                });

            } catch (e) {
                callbackError(e, callback);
            }
        });

        // The console runs commands inside the Dockge container, which drives the Docker
        // daemon of the host. Only an owner turns it on, confirming with the password;
        // turning it off needs no confirmation and ends the session that is open
        socket.on("setConsoleEnabled", async (enabled : unknown, currentPassword : unknown, callback) => {
            try {
                checkLogin(socket);
                if (socket.userRole !== "admin") {
                    throw new ValidationError("authPermissionDenied");
                }
                if (typeof enabled !== "boolean") {
                    throw new ValidationError("Wrong data type?");
                }
                if (enabled) {
                    await doubleCheckPassword(socket, currentPassword);
                }

                await Settings.set(MainTerminal.SETTING, enabled, "console");
                if (!enabled) {
                    await MainTerminal.closeSessions();
                }
                log.info("console", `Console turned ${enabled ? "on" : "off"} by user ${socket.userID}`);

                callbackResult({
                    ok: true,
                    msg: enabled ? "consoleTurnedOn" : "consoleTurnedOff",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Who opens the console: owners only, the default, or operators as well. Letting
        // operators in hands them the host, so it takes the password; narrowing ends
        // the sessions of everyone who is not an owner
        socket.on("setConsoleOperators", async (allowed : unknown, currentPassword : unknown, callback) => {
            try {
                checkLogin(socket);
                if (socket.userRole !== "admin") {
                    throw new ValidationError("authPermissionDenied");
                }
                if (typeof allowed !== "boolean") {
                    throw new ValidationError("Wrong data type?");
                }
                if (allowed) {
                    await doubleCheckPassword(socket, currentPassword);
                }

                await Settings.set(CONSOLE_OPERATORS_SETTING, allowed, "console");
                if (!allowed) {
                    const owners = (await listUsers()).filter((user) => user.role === "admin" && !user.suspended);
                    await MainTerminal.closeSessions(new Set(owners.map((user) => String(user.id))));
                }
                log.info("console", `Console ${allowed ? "opened to operators" : "limited to owners"} by user ${socket.userID}`);

                callbackResult({
                    ok: true,
                    msg: allowed ? "consoleOperatorsAllowed" : "consoleOwnersOnlySet",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Disconnect all other socket clients of the user
        socket.on("disconnectOtherSocketClients", async () => {
            try {
                checkLogin(socket);
                server.disconnectAllSocketClients(socket.userID, socket.id);
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("disconnectOtherSocketClients", e.message);
                }
            }
        });

        // composerize
        socket.on("composerize", async (dockerRunCommand : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(dockerRunCommand) !== "string") {
                    throw new ValidationError("dockerRunCommand must be a string");
                }

                // Option: 'latest' | 'v2x' | 'v3x'
                const composeTemplate = stripGeneratedProjectName(composerize(dockerRunCommand, "", "latest"));

                callback({
                    ok: true,
                    composeTemplate,
                });
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

}

/**
 * Remove the project name the converter generates, and nothing else.
 *
 * Cutting the first line blindly is wrong: when a flag is not supported the
 * converter reports it as a comment above the name, so the cut used to remove
 * the report and leave `name: <your project name>` inside the file of the user.
 * @param composeTemplate Output of the converter
 * @returns Compose file without the generated name line
 */
export function stripGeneratedProjectName(composeTemplate : string) : string {
    const lines = composeTemplate.split("\n");
    const index = lines.findIndex((line) => /^name:\s*<[^>]*>\s*$/.test(line));

    if (index === -1) {
        return composeTemplate;
    }

    lines.splice(index, 1);
    return lines.join("\n");
}

/** Settings the general settings screen is allowed to write */
/** Settings that are switches, whatever the client sent */
const BOOLEAN_SETTING_KEYS = [
    "checkBeta",
    "checkUpdate",
    "disableAuth",
    "trustProxy",
];

const GENERAL_SETTING_KEYS = [
    "checkBeta",
    "checkUpdate",
    "disableAuth",
    "keepDataPeriodDays",
    "primaryHostname",
    "serverTimezone",
    "trustProxy",
];

/**
 * Keep only the known settings.
 * Without this a client could create arbitrary rows, including internal keys such as
 * the stack file selection, which is stored under its own type on purpose.
 * @param data Values from the client
 * @returns Values that may be stored
 */
function pickGeneralSettings(data : LooseObject) : LooseObject {
    const result : LooseObject = {};

    for (const key of GENERAL_SETTING_KEYS) {
        if (key in data) {
            // The switches decide behaviour, so a string like "0" must not end up
            // stored as a truthy value
            result[key] = BOOLEAN_SETTING_KEYS.includes(key) ? Boolean(data[key]) : data[key];
        }
    }

    return result;
}
