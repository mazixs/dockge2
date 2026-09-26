import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { callbackError, callbackResult, checkLogin, DockgeSocket, ValidationError } from "../util-server";
import { LooseObject } from "../../common/util-common";
import { runInBackground } from "../background";

/** Length of the `name` column of the agent table */
const AGENT_NAME_MAX_LENGTH = 255;

/**
 * The name an owner gave an agent, as it may be stored
 * @param value Name from the browser; nothing means no name, and the address is shown instead
 * @returns The name without surrounding spaces
 * @throws {ValidationError} When it is not text or does not fit the column
 */
export function normalizeAgentName(value : unknown) : string {
    if (value === undefined || value === null) {
        return "";
    }
    if (typeof value !== "string" || value.trim().length > AGENT_NAME_MAX_LENGTH) {
        throw new ValidationError("agentNameInvalid", { max: String(AGENT_NAME_MAX_LENGTH) });
    }
    return value.trim();
}

export class ManageAgentSocketHandler extends SocketHandler {

    create(socket : DockgeSocket, server : DockgeServer) {
        // addAgent
        socket.on("addAgent", async (requestData : unknown, callback : unknown) => {
            try {
                log.debug("manage-agent-socket-handler", "addAgent");
                checkLogin(socket);

                if (typeof(requestData) !== "object") {
                    throw new Error("Data must be an object");
                }

                let data = requestData as LooseObject;
                const name = normalizeAgentName(data.name);
                let manager = socket.instanceManager;
                await manager.test(data.url, data.username, data.password);
                await manager.add(data.url, data.username, data.password, name);

                // connect to the agent
                manager.connect(data.url, data.username, data.password);

                // Refresh another sockets
                // It is a bit difficult to control another browser sessions to connect/disconnect agents, so force them to refresh the page will be easier.
                server.disconnectAllSocketClients(undefined, socket.id);
                runInBackground("agent list", () => manager.sendAgentList());

                callbackResult({
                    ok: true,
                    msg: "agentAddedSuccessfully",
                    msgi18n: true,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        // removeAgent
        socket.on("removeAgent", async (url : unknown, callback : unknown) => {
            try {
                log.debug("manage-agent-socket-handler", "removeAgent");
                checkLogin(socket);

                if (typeof(url) !== "string") {
                    throw new Error("URL must be a string");
                }

                let manager = socket.instanceManager;
                await manager.remove(url);

                server.disconnectAllSocketClients(undefined, socket.id);
                runInBackground("agent list", () => manager.sendAgentList());

                callbackResult({
                    ok: true,
                    msg: "agentRemovedSuccessfully",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // updateAgent
        socket.on("updateAgent", async (url : unknown, updatedName : unknown, callback : unknown) => {
            try {
                log.debug("manage-agent-socket-handler", "updateAgent");
                checkLogin(socket);

                if (typeof url !== "string") {
                    throw new ValidationError("URL must be a string");
                }

                let manager = socket.instanceManager;
                await manager.update(url, normalizeAgentName(updatedName));

                server.disconnectAllSocketClients(undefined, socket.id);
                runInBackground("agent list", () => manager.sendAgentList());

                callbackResult({
                    ok: true,
                    msg: "agentUpdatedSuccessfully",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
