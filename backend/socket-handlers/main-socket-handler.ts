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
import { Settings } from "../settings";
import fs, { promises as fsAsync } from "fs";
import path from "path";

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
                    msg: "Saved"
                }, callback);

                server.sendInfo(socket);

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
                let composeTemplate = composerize(dockerRunCommand, "", "latest");

                // Remove the first line "name: <your project name>"
                composeTemplate = composeTemplate.split("\n").slice(1).join("\n");

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
