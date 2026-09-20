import { DockgeServer } from "./dockge-server";
import { AgentSocket } from "../common/agent-socket";
import type { AgentRequestContract } from "../common/agent-events";
import { DockgeSocket } from "./util-server";

export abstract class AgentSocketHandler {
    abstract create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket<AgentRequestContract>): void;
}
