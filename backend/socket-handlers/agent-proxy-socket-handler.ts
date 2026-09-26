import { SocketHandler } from "../socket-handler.js";
import { DockgeServer } from "../dockge-server";
import { log } from "../log";
import { callbackError, checkLogin, DockgeSocket } from "../util-server";
import { AgentSocket } from "../../common/agent-socket";
import type { AgentRequestContract } from "../../common/agent-events";
import { authorizeSocketEvent } from "../auth-access";
import { ALL_ENDPOINTS } from "../../common/util-common";

export class AgentProxySocketHandler extends SocketHandler {

    create2(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket<AgentRequestContract>) {
        // Events reach each endpoint in the order they arrived. Authorization takes a
        // varying number of turns of the event loop, and unchained, a key typed second
        // reached the shell first
        const queues = new Map<unknown, Promise<void>>();

        // Agent - proxying requests if needed
        socket.on("agent", (endpoint : unknown, eventName : unknown, ...args : unknown[]) => {
            const key = endpoint === socket.endpoint ? "" : endpoint;
            const turn : Promise<void> = (queues.get(key) ?? Promise.resolve())
                .then(() => forward(endpoint, eventName, args))
                .catch((e) => log.error("agent", String(e)))
                .finally(() => {
                    // Endpoint names come from the client: an idle one keeps no entry
                    if (queues.get(key) === turn) {
                        queues.delete(key);
                    }
                });
            queues.set(key, turn);
        });

        const forward = async (endpoint : unknown, eventName : unknown, args : unknown[]) => {
            // The last argument is the ack callback when the client passed one
            const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] as (res : unknown) => void : undefined;

            try {
                checkLogin(socket);

                // Check Type
                if (typeof(endpoint) !== "string") {
                    throw new Error("Endpoint must be a string: " + endpoint);
                }
                if (typeof(eventName) !== "string") {
                    throw new Error("Event name must be a string");
                }

                await authorizeSocketEvent(socket, eventName, true);
                if (socket.userRole === "viewer" && callback) {
                    // Compose/Docker exceptions may quote file content. A status-only
                    // account gets a safe failure, including responses from agents.
                    args[args.length - 1] = (response : { ok? : boolean }) => {
                        callback(response?.ok ? response : { ok: false,
                            msg: "authStatusUnavailable",
                            msgi18n: true });
                    };
                }

                if (endpoint === ALL_ENDPOINTS) {      // Send to all endpoints
                    log.debug("agent", "Sending to all endpoints: " + eventName);
                    socket.instanceManager.emitToAllEndpoints(eventName, ...args);

                } else if (!endpoint || endpoint === socket.endpoint) {      // Direct connection or matching endpoint
                    log.debug("agent", "Matched endpoint: " + eventName);
                    agentSocket.call(eventName, ...args);

                } else {
                    log.debug("agent", "Proxying request to " + endpoint + " for " + eventName);
                    await socket.instanceManager.emitToEndpoint(endpoint, eventName, ...args);
                }
            } catch (e) {
                if (e instanceof Error) {
                    log.warn("agent", e.message);
                }

                // Without this the browser keeps waiting for an answer that never comes
                callbackError(e, callback);
            }
        };
    }

    create(socket : DockgeSocket, server : DockgeServer) {
        throw new Error("Method not implemented. Please use create2 instead.");
    }
}
