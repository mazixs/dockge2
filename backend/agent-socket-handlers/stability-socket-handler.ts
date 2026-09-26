import { AgentSocketHandler } from "../agent-socket-handler";
import type { DockgeServer } from "../dockge-server";
import type { AgentSocket } from "../../common/agent-socket";
import type { AgentRequestContract } from "../../common/agent-events";
import { callbackError, callbackResult, checkLogin, type DockgeSocket, ValidationError } from "../util-server";
import { stabilityCollector } from "../stability";
import { STABILITY_WINDOWS, type StabilityWindow } from "../../common/stability";

/** Authenticated runtime metadata only: no Compose files, environment, logs or shell. */
export class StabilitySocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket<AgentRequestContract>) : void {
        agentSocket.on("stabilityOverview", async (windowHours, callback) => {
            try {
                checkLogin(socket);
                if (typeof windowHours !== "number" || !STABILITY_WINDOWS.includes(windowHours as StabilityWindow)) {
                    throw new ValidationError("requestNotUnderstood");
                }
                callbackResult({ ok: true,
                    overview: await stabilityCollector.read(windowHours as StabilityWindow) }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }
}
