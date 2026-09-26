import { AgentSocketHandler } from "../agent-socket-handler";
import type { DockgeServer } from "../dockge-server";
import type { AgentSocket } from "../../common/agent-socket";
import type { AgentRequestContract } from "../../common/agent-events";
import { callbackError, callbackResult, checkLogin, type DockgeSocket, ValidationError } from "../util-server";
import { controlContainer, type DockerCall, inspectContainer } from "../container-source";
import { Settings } from "../settings";
import { log } from "../log";
import { runInBackground } from "../background";
import { CONTAINER_CONTROL_SETTING } from "../../common/types/container";

/**
 * Containers the panel does not manage: the page of one container and its three actions.
 *
 * Reading is for operators and owners, as the role check of every agent event decides.
 * Acting additionally needs the owner of this server to have turned it on, because a
 * container outside the stacks directory is somebody else's.
 */
export class ContainerSocketHandler extends AgentSocketHandler {
    /**
     * @param docker How Docker is asked; a test replaces it
     */
    constructor(private readonly docker? : DockerCall) {
        super();
    }

    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket<AgentRequestContract>) : void {
        agentSocket.on("inspectContainer", async (containerId : unknown, callback) => {
            try {
                checkLogin(socket);
                callbackResult({ ok: true,
                    container: await inspectContainer(containerId, server.stacksDir, this.docker) }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("controlContainer", async (containerId : unknown, action : unknown, callback) => {
            try {
                checkLogin(socket);
                if (await Settings.get(CONTAINER_CONTROL_SETTING) !== true) {
                    throw new ValidationError("containerControlOff");
                }
                const container = await controlContainer(containerId, action, server.stacksDir, this.docker);
                log.info("controlContainer", `${String(action)} ${container.id} (${container.name}) by user ${socket.userID}`);
                callbackResult({ ok: true,
                    msg: "containerActionDone",
                    msgi18n: true }, callback);
            } catch (e) {
                callbackError(e, callback);
            } finally {
                runInBackground("stack list", () => server.sendStackList());
            }
        });
    }
}
