import { DockgeSocket } from "./util-server";
import { io, Socket as SocketClient } from "socket.io-client";
import { log } from "./log";
import { Agent } from "./models/agent";
import { isDev, LooseObject, sleep } from "../common/util-common";
import semver from "semver";
import { signInAgent, invalidateAgentSession } from "./agent-auth";
import { authorizeSocketEvent, viewerStackSummary } from "./auth-access";
import type { StackSummaryDTO } from "../common/types/stack";
import dayjs, { Dayjs } from "dayjs";
import { BASELINE_ARGUMENT_INDEX, BASELINE_EVENTS, BASELINE_PROTOCOL_VERSION, MIN_AGENT_PROTOCOL_VERSION } from "../common/agent-socket";
import { runInBackground } from "./background";
import { TERMINAL_CLIENT_HEADER, terminalClientKey } from "./terminal";

/**
 * Decide whether an agent is too old to talk to.
 *
 * A dockge2 agent states the generation of the agent protocol it speaks, and
 * that is what gets compared. Its release number is useless here: this fork
 * numbers releases from scratch, so 0.0.1 is a build far newer than upstream
 * 1.4.0 and a version comparison would disconnect every agent.
 *
 * An upstream Dockge sends no protocol field. There the release number does
 * mean something, because agents only exist from 1.4.0 on, so the old check
 * still applies to it.
 *
 * The first packet of a connection carries neither field on purpose - it is
 * sent before sign-in - and an agent is not judged on it.
 * @param info The `info` packet received from the agent
 * @returns true when the agent must be disconnected
 */
export function agentIsTooOld(info : { version? : unknown, agentProtocol? : unknown }) : boolean {
    if (typeof info.agentProtocol === "number") {
        return info.agentProtocol < MIN_AGENT_PROTOCOL_VERSION;
    }

    return typeof info.version === "string" && semver.satisfies(info.version, "< 1.4.0");
}

/**
 * Dockge Instance Manager
 * One AgentManager per Socket connection
 */
export class AgentManager {

    protected socket : DockgeSocket;
    protected agentSocketList : Record<string, SocketClient> = {};
    protected agentLoggedInList : Record<string, boolean> = {};
    /** Agent protocol generation each endpoint reported, so old ones keep working */
    protected agentProtocolList : Record<string, number> = {};
    protected _firstConnectTime : Dayjs = dayjs();

    constructor(socket: DockgeSocket) {
        this.socket = socket;
    }

    get firstConnectTime() : Dayjs {
        return this._firstConnectTime;
    }

    async test(url : string, username : string, password : string) : Promise<void> {
        const endpoint = new URL(url).host;
        if (this.agentSocketList[endpoint]) {
            throw new Error("The Dockge URL already exists");
        }
        await signInAgent(url, username, password);
    }

    /**
     *
     * @param url
     * @param username
     * @param password
    * @param name
     */
    async add(url: string, username: string, password: string, name: string): Promise<Agent> {
        return Agent.create(url, username, password, name);
    }

    /**
     *
    * @param url
     */
    async remove(url : string) {
        const agent = await Agent.deleteByUrl(url);

        if (agent) {
            invalidateAgentSession(agent.url, agent.username, agent.password);
            const endpoint = agent.endpoint;
            this.disconnect(endpoint);
            runInBackground("agent list", () => this.sendAgentList());
            delete this.agentSocketList[endpoint];
        } else {
            throw new Error("Agent not found");
        }
    }

    /**
     *
     * @param url
    * @param updatedName
     */
    async update(url: string, updatedName: string) {
        const agent = await Agent.updateName(url, updatedName);
        if (agent) {
            runInBackground("agent list", () => this.sendAgentList());
        } else {
            throw new Error("Agent not found");
        }
    }

    async connect(url : string, username : string, password : string) {
        let obj = new URL(url);
        let endpoint = obj.host;

        this.socket.emit("agentStatus", {
            endpoint: endpoint,
            status: "connecting",
        });

        if (!endpoint) {
            log.error("agent-manager", "Invalid endpoint: " + endpoint + " URL: " + url);
            return;
        }

        if (this.agentSocketList[endpoint]) {
            log.debug("agent-manager", "Already connected to the socket server: " + endpoint);
            return;
        }

        log.info("agent-manager", "Connecting to the socket server: " + endpoint);
        let cookie : string;
        try {
            cookie = await signInAgent(url, username, password);
        } catch (error) {
            this.socket.emit("agentStatus", { endpoint,
                status: "offline",
                msg: error instanceof Error && error.message.startsWith("auth") ? error.message : "authAgentLoginFailed" });
            return;
        }
        if (!this.socket.connected || this.agentSocketList[endpoint]) {
            return;
        }
        // Every user of this panel signs in with the same agent account, so the header
        // keeps their shells on the agent apart
        const terminalClient = terminalClientKey(String(this.socket.userID ?? ""));
        let client = io(url, {
            extraHeaders: {
                cookie,
                endpoint,
                [TERMINAL_CLIENT_HEADER]: terminalClient,
            }
        });

        client.on("connect", () => {
            log.info("agent-manager", "Connected to the socket server: " + endpoint);

        });

        client.on("authIdentity", () => {
            this.agentLoggedInList[endpoint] = true;
            this.socket.emit("agentStatus", { endpoint,
                status: "online" });
        });
        let renewing = false;
        const renewSession = async () => {
            if (renewing || !this.socket.connected) {
                return;
            }
            renewing = true;
            this.agentLoggedInList[endpoint] = false;
            invalidateAgentSession(url, username, password, cookie);
            client.disconnect();
            this.socket.emit("agentStatus", { endpoint,
                status: "connecting" });
            try {
                cookie = await signInAgent(url, username, password);
                if (this.socket.connected && this.agentSocketList[endpoint] === client) {
                    client.io.opts.extraHeaders = { endpoint,
                        cookie,
                        [TERMINAL_CLIENT_HEADER]: terminalClient };
                    client.connect();
                }
            } catch (error) {
                this.socket.emit("agentStatus", { endpoint,
                    status: "offline",
                    msg: error instanceof Error && error.message.startsWith("auth") ? error.message : "authAgentLoginFailed" });
            } finally {
                renewing = false;
            }
        };
        client.on("needAuth", renewSession);
        client.on("refresh", renewSession);

        client.on("connect_error", (err) => {
            log.error("agent-manager", "Error from the socket server: " + endpoint);
            this.socket.emit("agentStatus", {
                endpoint: endpoint,
                status: "offline",
            });
        });

        client.on("disconnect", (reason) => {
            this.agentLoggedInList[endpoint] = false;
            if (reason === "io server disconnect") {
                void renewSession();
                return;
            }
            log.info("agent-manager", "Disconnected from the socket server: " + endpoint);
            this.socket.emit("agentStatus", {
                endpoint: endpoint,
                status: "offline",
            });
        });

        client.on("agent", (...args : unknown[]) => {
            if (!this.socket.connected) {
                return;
            }
            if (this.socket.userRole === "viewer" && args[0] !== "stackList") {
                return;
            }
            if (this.socket.userRole === "viewer" && args[0] === "stackList") {
                // Off the wire: the peer says it speaks this protocol, the shape is its word
                const response = args[1] as { stackList? : Record<string, StackSummaryDTO> };
                if (response?.stackList) {
                    args[1] = { ...response,
                        stackList: Object.fromEntries(Object.entries(response.stackList).map(([ name, stack ]) => [ name, viewerStackSummary(stack) ])) };
                }
            }
            this.socket.emit("agent", ...args);
        });

        client.on("info", (res) => {
            log.debug("agent-manager", res);

            // What this agent understands decides which arguments may be sent to it
            this.agentProtocolList[endpoint] = typeof res?.agentProtocol === "number" ? res.agentProtocol : 1;

            if (!isDev && agentIsTooOld(res)) {
                this.socket.emit("agentStatus", {
                    endpoint: endpoint,
                    status: "offline",
                    msg: `${endpoint}: Unsupported version: ` + res.version,
                });
                client.disconnect();
            }
        });

        this.agentSocketList[endpoint] = client;
    }

    disconnect(endpoint : string) {
        let client = this.agentSocketList[endpoint];
        client?.disconnect();
    }

    async connectAll() {
        this._firstConnectTime = dayjs();

        if (this.socket.endpoint) {
            log.info("agent-manager", "This connection is connected as an agent, skip connectAll()");
            return;
        }

        let list : Record<string, Agent> = await Agent.getAgentList();

        if (Object.keys(list).length !== 0) {
            log.info("agent-manager", "Connecting to all instance socket server(s)...");
        }

        for (let endpoint in list) {
            let agent = list[endpoint];
            if (!agent) {
                continue;
            }
            this.connect(agent.url, agent.username, agent.password).catch(() => {
                this.socket.emit("agentStatus", { endpoint,
                    status: "offline",
                    msg: "authAgentLoginFailed" });
            });
        }
    }

    disconnectAll() {
        for (let endpoint in this.agentSocketList) {
            this.disconnect(endpoint);
        }
    }

    async emitToEndpoint(endpoint: string, eventName: string, ...args : unknown[]) {
        log.debug("agent-manager", "Emitting event to endpoint: " + endpoint);
        let client = this.agentSocketList[endpoint];

        if (!client) {
            log.error("agent-manager", "Socket client not found for endpoint: " + endpoint);
            throw new Error("Socket client not found for endpoint: " + endpoint);
        }

        if (!client.connected || !this.agentLoggedInList[endpoint]) {
            // Maybe the request is too quick, the socket is not connected yet, check firstConnectTime
            // If it is within 10 seconds, we should apply retry logic here
            let diff = dayjs().diff(this.firstConnectTime, "second");
            log.debug("agent-manager", endpoint + ": diff: " + diff);
            let ok = false;
            while (diff < 10) {
                if (client.connected && this.agentLoggedInList[endpoint]) {
                    log.debug("agent-manager", `${endpoint}: Connected & Logged in`);
                    ok = true;
                    break;
                }
                log.debug("agent-manager", endpoint + ": not ready yet, retrying in 1 second...");
                await sleep(1000);
                diff = dayjs().diff(this.firstConnectTime, "second");
            }

            if (!ok) {
                log.error("agent-manager", `${endpoint}: Socket client not connected`);
                throw new Error("Socket client not connected for endpoint: " + endpoint);
            }
        }

        // Waiting for a remote connection must not preserve permissions revoked meanwhile.
        await authorizeSocketEvent(this.socket, eventName, true);
        client.emit("agent", endpoint, eventName, ...this.forEndpoint(endpoint, eventName, args));
    }

    /**
     * Adapt the arguments of an event to what this agent understands.
     *
     * Only the baseline of a save is generation specific: an older agent expects its
     * acknowledgement where the baseline now sits, and would answer nobody at all.
     * @param endpoint Agent the event is going to
     * @param eventName Event being sent
     * @param args Arguments as the browser sent them
     * @returns Arguments this agent can read
     */
    protected forEndpoint(endpoint : string, eventName : string, args : unknown[]) : unknown[] {
        const protocol = this.agentProtocolList[endpoint] ?? 1;

        if (!BASELINE_EVENTS.has(eventName) || protocol >= BASELINE_PROTOCOL_VERSION || args.length <= BASELINE_ARGUMENT_INDEX) {
            return args;
        }

        if (typeof args[BASELINE_ARGUMENT_INDEX] === "function") {
            return args;
        }

        log.debug("agent-manager", `${endpoint}: agent protocol ${protocol}, saving without the conflict check`);
        return [ ...args.slice(0, BASELINE_ARGUMENT_INDEX), ...args.slice(BASELINE_ARGUMENT_INDEX + 1) ];
    }

    emitToAllEndpoints(eventName: string, ...args : unknown[]) {
        log.debug("agent-manager", "Emitting event to all endpoints");
        for (let endpoint in this.agentSocketList) {
            this.emitToEndpoint(endpoint, eventName, ...args).catch((e) => {
                log.warn("agent-manager", e.message);
            });
        }
    }

    async sendAgentList() {
        let list = await Agent.getAgentList();
        let result : Record<string, LooseObject> = {};

        // Myself
        result[""] = {
            url: "",
            username: "",
            endpoint: "",
            name: "",
            updatedName: "",
        };

        for (let endpoint in list) {
            let agent = list[endpoint];
            if (!agent) {
                continue;
            }
            result[endpoint] = this.socket.userRole === "admin" ? agent.toJSON() : { endpoint,
                name: agent.name };
        }

        this.socket.emit("agentList", {
            ok: true,
            agentList: result,
        });
    }
}
