import { TerminalBindings } from "../terminal-bindings";
import { reconcileSnapshot } from "../snapshot-identity";
import { io } from "socket.io-client";
import { Socket } from "socket.io-client";
import { defineComponent } from "vue";
import { authClient } from "../auth-client";
import { authErrorMessage, isTotpCode } from "../auth-messages";
import type { Terminal } from "@xterm/xterm";
import { createSessionBootstrap, reduceSessionBootstrap, sessionConnectionReady, type SessionBootstrapEvent } from "../session-bootstrap";
import { AgentRequests, type AgentRequestOptions } from "../agent-requests";
import { AgentSocket } from "../../../common/agent-socket";
import type { StackSummaryDTO, ViewerStackSummary } from "../../../common/types/stack";
import type { StandaloneContainer } from "../../../common/types/container";
import type {
    AgentBroadcastContract,
    AgentErrorResponse,
    AgentRequestArgs,
    AgentRequestName,
    AgentRequestResult,
} from "../../../common/agent-events";
import { PANEL_UPDATE_EVENTS } from "../../../common/panel-update";
import {
    PANEL_UPDATE_STORAGE_KEY,
    createPanelUpdateState,
    panelUpdateDeadline,
    panelUpdateRequestId,
    panelUpdateSuppressing as suppressingOf,
    panelUpdateView as viewOf,
    readPanelUpdateAck,
    readPanelUpdateRecord,
    readPanelUpdateStatus,
    reducePanelUpdate,
    type PanelUpdateAckResult,
    type PanelUpdateEffect,
    type PanelUpdateEvent,
    type PanelUpdateState,
} from "../panel-update-machine";

let socket : Socket;
let initializationDeadline : ReturnType<typeof setTimeout> | undefined;
let sessionRefresh : { generation : number; socketID : string | undefined; userID : string; promise : Promise<boolean> } | undefined;

const terminalMap = new TerminalBindings<Terminal>();

/** The one-second clock of the panel update, running only while a deadline is armed */
let panelUpdateClock : ReturnType<typeof setInterval> | undefined;

/** How long an acknowledgement of the panel update may take before it counts as lost */
const PANEL_UPDATE_ACK_MS = 60_000;

/** When the page last reloaded for a missing chunk, so a chunk that stays missing does not loop */
const PRELOAD_RELOAD_KEY = "dockge2.preloadReload";
const PRELOAD_RELOAD_GUARD_MS = 10_000;

/**
 * `sessionStorage` without its failures: a private window or blocked site data throws,
 * and the page then works from the server status alone
 * @param key Storage key
 * @param value Text to keep, null to remove, undefined to read
 * @returns The stored text when reading
 */
function sessionValue(key : string, value? : string | null) : string | null {
    try {
        if (value === undefined) {
            return sessionStorage.getItem(key);
        }
        if (value === null) {
            sessionStorage.removeItem(key);
        } else {
            sessionStorage.setItem(key, value);
        }
    } catch {
        // Nothing to resume from later, which the machine already allows for
    }
    return null;
}

/**
 * A request id for the helper labels; `randomUUID` is missing outside a secure context
 * @returns A version 4 UUID
 */
function newPanelUpdateRequestId() : string {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return panelUpdateRequestId(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Requests still waiting for their acknowledgement, and what happens when none comes.
 *
 * The transport is the socket of this module; the deadline, the single answer per
 * request and the ending of everything still waiting live in `AgentRequests`, where they
 * are tested without a browser.
 */
const agentRequests = new AgentRequests((endpoint, eventName, args, ack, timeoutMs) => {
    // Release Socket.IO's acknowledgement closure too, not only our waiting list.
    socket.timeout(timeoutMs).emit("agent", endpoint, eventName, ...args, (error : Error | null, response : AgentRequestResult<typeof eventName>) => {
        ack(error ? undefined : response);
    });
});

/**
 * Stacks of one endpoint, by their name.
 *
 * A viewer is sent rows without anything about files, so a screen that wants such a
 * field has to establish that it is there rather than assume it.
 */
export type StackList = Record<string, StackSummaryDTO | ViewerStackSummary>;

/** An agent as the settings list and the endpoint picker show it */
export interface AgentInfo {
    endpoint: string;
    name: string;
    /** Only the owner is sent the address an agent is reached at */
    url?: string;
    [key: string]: unknown;
}

/** What is known about the stacks of one agent */
export interface AgentInstance {
    stackList: StackList;
}

/** Containers of one server outside every compose project, and whether its owner lets them be controlled */
export interface HostContainers {
    standalone: StandaloneContainer[];
    containerControl: boolean;
}

/** What the server says about itself when a socket connects */
export interface SocketInfo {
    version?: string;
    /** Newest release this panel knows about, absent until it was asked */
    latestVersion?: string;
    /** Whether that release is newer than the one running, so there is news to show */
    updateAvailable?: boolean;
    /** Agent protocol this panel speaks, absent before sign-in */
    agentProtocol?: number;
    /** Whether the panel itself runs in a container */
    isContainer?: boolean;
    /** Hostname the links of a stack are built from, empty when nothing was set */
    primaryHostname?: string;
    [key: string]: unknown;
}

/** The answer of a request that does not go through the agent contract */
export interface SocketResponse {
    ok?: boolean;
    endpoint?: string;
    msg?: string;
    /** True when no answer arrived at all, so the caller may not say it failed */
    unknown?: boolean;
    [key: string]: unknown;
}

export default defineComponent({
    data() {
        return {
            socketIO: {
                firstConnect: true,
                connected: false,
                connectCount: 0,
                initedSocketIO: false,
                connectionErrorMsg: `${this.$t("socketCannotConnect")} ${this.$t("socketReconnecting")}`,
                showReverseProxyGuide: true,
                connecting: false,
            },
            info: {} as SocketInfo,
            loggedIn: false,
            sessionBootstrap: createSessionBootstrap(),
            allowLoginDialog: false,

            /** True when this instance runs with authentication switched off */
            authDisabled: false,

            /** Stack that was just created, so the list can point at it */
            freshStack: null as string | null,
            /** Когда последний раз приходил список стеков */
            stackListAt: 0,
            username: null as string | null,
            userID: null as string | null,
            userRole: "viewer" as "admin" | "operator" | "viewer",
            composeTemplate: "",
            /** Environment a new stack starts from, set by the screen that prepared it */
            envTemplate: "",

            stackList: {} as StackList,

            // All stack list from all agents
            allAgentStackList: {} as Record<string, AgentInstance>,

            /** By endpoint, "" for this server; absent for an agent too old to send them */
            hostContainers: {} as Record<string, HostContainers>,

            // online / offline / connecting
            agentStatusList: {} as Record<string, string>,

            // Agent List
            agentList: {} as Record<string, AgentInfo>,

            /** The update of this panel, kept here because screens unmount while it runs */
            panelUpdate: createPanelUpdateState() as PanelUpdateState,
        };
    },
    computed: {
        appReady() : boolean {
            return this.loggedIn && this.sessionBootstrap.ready;
        },
        sessionBootstrapping() : boolean {
            return !this.appReady && !this.allowLoginDialog && !this.sessionBootstrap.anonymous && !this.sessionBootstrap.error;
        },
        sessionBootstrapError() : string {
            return this.sessionBootstrap.error;
        },
        isAdmin() : boolean {
            return this.loggedIn && this.userRole === "admin";
        },
        canManageStacks() : boolean {
            return this.loggedIn && this.userRole !== "viewer";
        },

        agentCount() {
            return Object.keys(this.agentList).length;
        },

        completeStackList() : StackList {
            let list : StackList = {};

            for (let stackName in this.stackList) {
                const stack = this.stackList[stackName];
                if (stack) {
                    list[stackName + "_"] = stack;
                }
            }

            for (let endpoint in this.allAgentStackList) {
                let instance = this.allAgentStackList[endpoint];
                if (!instance) {
                    continue;
                }
                for (let stackName in instance.stackList) {
                    const stack = instance.stackList[stackName];
                    if (stack) {
                        list[stackName + "_" + endpoint] = stack;
                    }
                }
            }
            return list;
        },

        usernameFirstChar() {
            if (typeof this.username == "string" && this.username.length >= 1) {
                return this.username.charAt(0).toUpperCase();
            } else {
                return "🐬";
            }
        },

        /**
         *  Frontend Version
         *  It should be compiled to a static value while building the frontend.
         *  Please see ./frontend/vite.config.ts, it is defined via vite.js
         * @returns {string}
         */
        frontendVersion() {
            return FRONTEND_VERSION;
        },

        /**
         * Are both frontend and backend in the same version?
         * @returns {boolean}
         */
        isFrontendBackendVersionMatched() {
            if (typeof this.info.version !== "string") {
                return true;
            }
            return this.info.version === this.frontendVersion;
        },

        /** How the panel update is drawn: the overlay, a banner, or nothing */
        panelUpdateView() : "overlay" | "banner" | "none" {
            return viewOf(this.panelUpdate, { owner: this.isAdmin,
                signedIn: this.loggedIn });
        },

        /** While an update runs, the page neither reloads itself nor reports the lost connection */
        panelUpdateSuppressing() : boolean {
            return suppressingOf(this.panelUpdate);
        },

    },
    watch: {

        "socketIO.connected"() {
            if (this.socketIO.connected) {
                this.agentStatusList[""] = "online";
            } else {
                this.agentStatusList[""] = "offline";
            }
        },

        // Reload the SPA if the server version is changed.
        "info.version"(to, from) {
            // The first info packet of a connection deliberately carries no version, so
            // a reconnect must not be mistaken for a server that was upgraded
            if (from && to && from !== to && !this.panelUpdateSuppressing) {
                window.location.reload();
            }
        },
    },
    created() {
        this.dispatchPanelUpdate({ type: "BOOT",
            persisted: readPanelUpdateRecord(sessionValue(PANEL_UPDATE_STORAGE_KEY)),
            now: Date.now(),
            build: FRONTEND_VERSION });
        window.addEventListener("vite:preloadError", this.onPreloadError);
        window.addEventListener("beforeunload", this.onBeforeUnload);
        this.initSocketIO();
    },
    mounted() {
        // Nothing to do: the socket is created in `created()`
    },
    methods: {

        endpointDisplayFunction(endpoint : string) {
            for (const v of Object.values(this.$data.agentList)) {
                if (endpoint) {
                    if (endpoint === v["endpoint"] && v["name"] !== "") {
                        return v["name"];
                    }
                    if (endpoint === v["endpoint"] && v["name"] === "" ) {
                        return endpoint;
                    }
                }
            }
        },

        /**
         * Initialize connection to socket server
         * @param bypass Should the check for if we
         * are on a status page be bypassed?
         */
        initSocketIO(bypass = false) {
            // No need to re-init
            if (this.socketIO.initedSocketIO) {
                return;
            }

            this.socketIO.initedSocketIO = true;
            let url : string;
            const env = process.env.NODE_ENV || "production";
            if (env === "development" || localStorage.dev === "dev") {
                url = location.protocol + "//" + location.hostname + ":5001";
            } else {
                url = location.protocol + "//" + location.host;
            }

            this.socketIO.connecting = true;

            // withCredentials sends the session cookie during the handshake, which is how
            // the server identifies this client. No token is kept in the browser.
            socket = io(url, {
                withCredentials: true,
            });

            // Handling events from agents
            let agentSocket = new AgentSocket<AgentBroadcastContract>();
            socket.on("agent", (eventName : unknown, ...args : unknown[]) => {
                if (typeof eventName === "string") {
                    agentSocket.call(eventName, ...args);
                }
            });

            socket.on("connect", () => {
                console.log("Connected to the socket server");

                this.socketIO.connecting = false;
                this.applySessionBootstrap({ type: "connected" });
                const generation = this.sessionBootstrap.generation;
                clearTimeout(initializationDeadline);
                initializationDeadline = setTimeout(() => {
                    if (!sessionConnectionReady(this.sessionBootstrap)) {
                        this.applySessionBootstrap({ type: "failed",
                            generation,
                            message: "authConnectionFailed" });
                    }
                }, 30000);

                this.socketIO.connectCount++;
                this.socketIO.connected = true;
                this.socketIO.showReverseProxyGuide = false;

                // A transport connection does not yet identify its user or load its inventory.

                this.socketIO.firstConnect = false;
            });

            socket.on("disconnect", () => {
                console.log("disconnect");
                this.socketIO.connectionErrorMsg = `${this.$t("socketConnectionLost")}`;
                this.socketIO.connected = false;
                clearTimeout(initializationDeadline);

                // Nothing will answer these any more, and a screen waiting for an answer
                // that cannot arrive is the state this exists to prevent
                this.failPendingRequests();
                this.dispatchPanelUpdate({ type: "LINK_DOWN",
                    now: Date.now() });
            });

            socket.on("connect_error", (err: Error) => {
                console.error(`Failed to connect to the backend. Socket.io connect_error: ${err.message}`);
                this.socketIO.connectionErrorMsg = `${this.$t("socketCannotConnect")} [${err}] ${this.$t("socketReconnectingInline")}`;
                this.socketIO.showReverseProxyGuide = true;
                this.socketIO.connected = false;
                this.socketIO.firstConnect = false;
                this.socketIO.connecting = false;
                this.applySessionBootstrap({ type: "failed",
                    generation: this.sessionBootstrap.generation,
                    message: "authConnectionFailed" });
            });

            // Custom Events

            socket.on("info", (info: SocketInfo) => {
                this.info = info;
                // Without a release the notice switch is off; a manual check may still have found one
                if (typeof info?.latestVersion === "string") {
                    this.panelUpdateInfo(info.latestVersion, info.updateAvailable === true);
                }
            });

            socket.on(PANEL_UPDATE_EVENTS.status, (value : unknown) => {
                const status = readPanelUpdateStatus(value);
                if (status) {
                    this.dispatchPanelUpdate({ type: "STATUS",
                        status,
                        solicited: false,
                        ask: null,
                        now: Date.now() });
                }
            });

            socket.on("authIdentity", (identity: { userID: string; role: "admin" | "operator" | "viewer" }) => {
                if (this.userID && this.userID !== identity.userID) {
                    this.clearData();
                }
                this.applySessionBootstrap({ type: "identity",
                    userID: identity.userID });
                this.userID = identity.userID;
                this.userRole = identity.role;
                this.loggedIn = true;
                this.allowLoginDialog = false;
                void this.refreshSession();
                // The update status needs only a signed-in socket: a panel that restarted still
                // loading its stacks must not leave a followed update offline behind an inert page
                this.dispatchPanelUpdate({ type: "LINK_UP",
                    now: Date.now() });
            });

            socket.on("autoLogin", () => {
                // Authentication is disabled in the settings
                this.authDisabled = true;
                this.loggedIn = true;
                this.allowLoginDialog = false;
                this.username ||= this.$t("usersRole_admin");
                if (this.userID) {
                    this.applySessionBootstrap({ type: "profile",
                        generation: this.sessionBootstrap.generation,
                        userID: this.userID });
                }
            });

            socket.on("needAuth", () => {
                this.applySessionBootstrap({ type: "anonymous" });
                clearTimeout(initializationDeadline);
                this.authDisabled = false;
                this.loggedIn = false;
                this.username = null;
                this.userID = null;
                this.userRole = "viewer";
                this.clearData();
                this.allowLoginDialog = true;
                this.dispatchPanelUpdate({ type: "AUTH_LOST" });
            });

            socket.on("setup", () => {
                if (this.$router.currentRoute.value.path !== "/setup") {
                    this.$router.push("/setup");
                }
            });

            agentSocket.on("terminalWrite", (...args: unknown[]) => {
                const terminalName = args[0];
                const data = args[1];
                if (typeof terminalName !== "string" || (typeof data !== "string" && !(data instanceof Uint8Array))) {
                    return;
                }
                const terminal = terminalMap.get(terminalName);
                if (!terminal) {
                    //console.error("Terminal not found: " + terminalName);
                    return;
                }
                terminal.write(data);
            });

            agentSocket.on("stackList", (res) => {
                if (res.ok && Array.isArray(res.standalone)) {
                    this.hostContainers[res.endpoint ?? ""] = { standalone: res.standalone,
                        containerControl: res.containerControl === true };
                }
                if (res.ok && res.stackList && typeof res.stackList === "object") {
                    const stackList = res.stackList;
                    // Когда список пришел: шапка честно говорит, насколько он свежий
                    this.stackListAt = Date.now();
                    if (!res.endpoint) {
                        this.stackList = reconcileSnapshot(this.stackList, stackList);
                        this.applySessionBootstrap({ type: "stacks",
                            generation: this.sessionBootstrap.generation });
                    } else {
                        if (!this.allAgentStackList[res.endpoint]) {
                            this.allAgentStackList[res.endpoint] = {
                                stackList: {},
                            };
                        }
                        const instance = this.allAgentStackList[res.endpoint];
                        if (instance) {
                            instance.stackList = reconcileSnapshot(instance.stackList, stackList);
                        }
                    }
                }
            });

            socket.on("stackStatusList", (res: { ok?: boolean; stackStatusList?: Record<string, unknown> }) => {
                if (res.ok && res.stackStatusList) {
                    for (let stackName in res.stackStatusList) {
                        const stackObj = this.stackList[stackName];
                        const status = res.stackStatusList[stackName];
                        // A status is a number of `common/util-common.ts`; anything else
                        // is not a status this build knows, and a row keeps what it had
                        if (stackObj && typeof status === "number") {
                            stackObj.status = status;
                        }
                    }
                }
            });

            socket.on("agentStatus", (res: { endpoint: string; status: string; msg?: string }) => {
                this.agentStatusList[res.endpoint] = res.status;

                if (res.msg) {
                    const root = this.$root as unknown as { toastError: (message: string) => void };
                    root.toastError(res.msg);
                }
            });

            socket.on("agentList", (res: { ok?: boolean; agentList: Record<string, AgentInfo> }) => {
                if (res.ok) {
                    this.agentList = res.agentList;
                    for (const endpoint of Object.keys(res.agentList)) {
                        this.agentStatusList[endpoint] ??= endpoint ? "connecting" : "online";
                    }
                    this.applySessionBootstrap({ type: "agents",
                        generation: this.sessionBootstrap.generation });
                }
            });

            socket.on("refresh", () => {
                if (!this.panelUpdateSuppressing) {
                    location.reload();
                }
            });
        },

        getSocket() : Socket {
            return socket;
        },

        /**
         * Send an event to an agent without waiting for it.
         *
         * The name and the arguments come from the event contract, so an event this
         * build does not serve, or one sent with the wrong arguments, does not compile.
         * Nothing here bounds the wait: a caller that needs an answer uses
         * `emitAgentRequest` instead.
         * @param endpoint Agent the event goes to
         * @param eventName Event of the agent protocol
         * @param args Arguments of that event, with the acknowledgement last when the caller wants one
         */
        emitAgent<E extends AgentRequestName>(
            endpoint : string,
            eventName : E,
            ...args : [ ...AgentRequestArgs<E>, ack? : (response : AgentRequestResult<E>) => void ]
        ) {
            this.getSocket().emit("agent", endpoint, eventName, ...args);
        },

        /**
         * Ask an agent something and always get an answer.
         *
         * The plain emit above has no deadline: a lost acknowledgement leaves the caller
         * waiting for ever. Here every request ends - with the server's answer, or with
         * "the result is unknown" when the connection went away or the deadline passed.
         * The caller then shows what it knows and re-reads the state instead of guessing
         * or repeating a command the server may already have run.
         * @param endpoint Agent the request goes to
         * @param eventName Event of the agent protocol
         * @param args Arguments of that event, without the acknowledgement
         * @param options How long to wait
         * @returns The answer, or the unknown result
         */
        emitAgentRequest<E extends AgentRequestName>(
            endpoint : string,
            eventName : E,
            args : AgentRequestArgs<E>,
            options : AgentRequestOptions<AgentRequestResult<E>> = {},
        ) : Promise<AgentRequestResult<E>> {
            return agentRequests.request(endpoint, eventName, args, options);
        },

        /**
         * End every request that is still waiting, because nothing will answer it
         * @returns {void}
         */
        failPendingRequests() {
            agentRequests.failAll();
        },

        /**
         * Read the current session from the server and remember who is signed in
         * @returns {Promise<boolean>} Whether a session exists
         */
        async refreshSession() : Promise<boolean> {
            const generation = this.sessionBootstrap.generation;
            const userID = this.sessionBootstrap.confirmedUserID;
            const socketID = socket.id;
            if (!userID) {
                return false;
            }
            if (sessionRefresh?.generation === generation && sessionRefresh.socketID === socketID && sessionRefresh.userID === userID) {
                return sessionRefresh.promise;
            }
            const isCurrentConnection = () => socket.connected && socket.id === socketID && generation === this.sessionBootstrap.generation && userID === this.sessionBootstrap.confirmedUserID;
            const request = (async () => {
                try {
                    const { data, error } = await authClient.getSession();
                    if (!isCurrentConnection()) {
                        return false;
                    }
                    if (data?.user?.id === userID) {
                        this.authDisabled = false;
                        this.username = data.user.username || data.user.name || data.user.email;
                        this.applySessionBootstrap({ type: "profile",
                            generation,
                            userID });
                        return true;
                    }
                    // A cookie-less reverse-proxy deployment is confirmed by autoLogin.
                    // HTTP profile results never undo the socket's authoritative identity.
                    if (error && !this.authDisabled) {
                        this.applySessionBootstrap({ type: "failed",
                            generation,
                            message: "authConnectionFailed" });
                    }
                    return false;
                } catch {
                    if (isCurrentConnection() && !this.authDisabled) {
                        this.applySessionBootstrap({ type: "failed",
                            generation,
                            message: "authConnectionFailed" });
                    }
                    return false;
                }
            })();
            sessionRefresh = { generation,
                socketID,
                userID,
                promise: request };
            return request;
        },

        /** Publish the first complete snapshot once, and keep it mounted on reconnect. */
        applySessionBootstrap(event : SessionBootstrapEvent) {
            const wasReady = sessionConnectionReady(this.sessionBootstrap);
            this.sessionBootstrap = reduceSessionBootstrap(this.sessionBootstrap, event);
            if (!wasReady && sessionConnectionReady(this.sessionBootstrap)) {
                clearTimeout(initializationDeadline);
            }
        },

        /** Wait for actual initialization evidence, with a bounded failure timeout. */
        waitForSessionReady(timeoutMs = 30000) : Promise<boolean> {
            const generation = this.sessionBootstrap.generation;
            return new Promise((resolve) => {
                const finish = (ready : boolean) => {
                    clearTimeout(timer);
                    stop();
                    resolve(ready);
                };
                const check = () => {
                    const state = this.sessionBootstrap;
                    if (state.generation !== generation || state.anonymous || state.error) {
                        finish(false);
                    } else if (sessionConnectionReady(state)) {
                        finish(true);
                    }
                };
                const stop = this.$watch(() => this.sessionBootstrap, check);
                const timer = setTimeout(() => finish(false), timeoutMs);
                check();
            });
        },

        /**
         * Sign in with email and password.
         * The server sets an httpOnly session cookie, then the socket reconnects so the
         * handshake carries it.
         * @param {string} email Address of the account
         * @param {string} password Password of the account
         * @returns {Promise<object>} Result with `ok`, `msg` and `twoFactorRequired`
         */
        async signIn(email : string, password : string) : Promise<SocketResponse> {
            const identifier = email.trim();
            const { data, error } = identifier.includes("@")
                ? await authClient.signIn.email({ email: identifier,
                    password })
                : await authClient.signIn.username({ username: identifier,
                    password });

            if (error) {
                return {
                    ok: false,
                    msg: authErrorMessage(error),
                };
            }

            // With two factor on, the password alone only opens a challenge
            if ((data as { twoFactorRedirect? : boolean } | null)?.twoFactorRedirect) {
                return {
                    ok: false,
                    twoFactorRequired: true,
                };
            }

            return this.finishSignIn();
        },

        /**
         * Answer the two factor challenge of a sign-in that is already under way.
         *
         * A code of six digits is a TOTP code, everything else is treated as a backup
         * code, which is what the setup dialog hands out for a lost authenticator.
         * @param {string} code Code the user typed
         * @returns {Promise<object>} Result with `ok` and `msg`
         */
        async verifyTwoFactor(code : string) : Promise<SocketResponse> {
            const trimmed = code.trim();

            const { error } = isTotpCode(trimmed)
                ? await authClient.twoFactor.verifyTotp({ code: trimmed })
                : await authClient.twoFactor.verifyBackupCode({ code: trimmed });

            if (error) {
                return {
                    ok: false,
                    twoFactorRequired: true,
                    msg: authErrorMessage(error),
                };
            }

            return this.finishSignIn();
        },

        /**
         * Hand the fresh session to the socket and await its complete initial snapshot.
         * @returns {Promise<object>} Result with `ok` and `msg`
         */
        async finishSignIn() : Promise<SocketResponse> {
            const connected = await this.reconnectSocket();

            if (!connected) {
                return {
                    ok: false,
                    msg: "reconnectFailed",
                };
            }

            const ready = await this.waitForSessionReady();
            return ready ? { ok: true } : { ok: false,
                msg: this.sessionBootstrapError || "authConnectionFailed" };
        },

        /**
         * Reconnect the socket, so the handshake runs again with the current cookie.
         * A server that went away must not leave the caller waiting forever, so this
         * gives up after a few seconds and reports the failure.
         * @param {number} timeoutMs How long to wait for the connection
         * @returns {Promise<boolean>} Whether the socket is connected again
         */
        reconnectSocket(timeoutMs = 10000) : Promise<boolean> {
            socket.disconnect();
            socket.connect();

            return new Promise<boolean>((resolve) => {
                if (socket.connected) {
                    resolve(true);
                    return;
                }

                const done = (connected : boolean) => {
                    clearTimeout(timer);
                    socket.off("connect", onConnect);
                    socket.off("connect_error", onError);
                    resolve(connected);
                };

                const onConnect = () => done(true);
                const onError = () => done(false);
                const timer = setTimeout(() => done(socket.connected), timeoutMs);

                socket.once("connect", onConnect);
                socket.once("connect_error", onError);
            });
        },

        /**
         * Log out of the web application
         * @returns {void}
         */
        async logout() : Promise<SocketResponse> {
            const { error } = await authClient.signOut();

            if (error) {
                // The cookie is still valid, so pretending to be signed out would be a lie
                return {
                    ok: false,
                    msg: authErrorMessage(error),
                };
            }

            this.applySessionBootstrap({ type: "anonymous" });
            clearTimeout(initializationDeadline);
            this.authDisabled = false;
            this.loggedIn = false;
            this.username = null;
            this.allowLoginDialog = true;
            this.clearData();

            // The socket must lose its session as well
            await this.reconnectSocket();

            return { ok: true };
        },

        /**
         * Point the list at a stack that was just created.
         * A highlighted row answers "where is it among the twenty seven" better than
         * a toast that disappears after a few seconds.
         * @param {string} name Name of the stack
         * @param {number} durationMs How long the row stays marked
         * @returns {void}
         */
        markStackFresh(name : string, durationMs = 60_000) {
            this.freshStack = name;

            setTimeout(() => {
                if (this.freshStack === name) {
                    this.freshStack = null;
                }
            }, durationMs);
        },

        /**
         * Drop everything that belonged to the session that just ended, so the next
         * user of this browser does not see the previous stack list for a moment
         * @returns {void}
         */
        clearData() {
            this.userRole = "viewer";
            this.userID = null;
            for (const terminal of terminalMap.values()) {
                terminal.clear();
            }
            terminalMap.clear();
            this.stackList = {};
            this.allAgentStackList = {};
            this.hostContainers = {};
            this.agentList = {};
            this.agentStatusList = {};
            this.composeTemplate = "";
            this.freshStack = null;
        },

        /**
         * Advance the panel update and perform what it asks for
         * @param event What happened
         */
        dispatchPanelUpdate(event : PanelUpdateEvent) {
            const step = reducePanelUpdate(this.panelUpdate, event);
            this.panelUpdate = step.state;
            for (const effect of step.effects) {
                this.runPanelUpdateEffect(effect);
            }
            const armed = panelUpdateDeadline(this.panelUpdate) !== null;
            if (armed && !panelUpdateClock) {
                panelUpdateClock = setInterval(() => this.dispatchPanelUpdate({ type: "TICK",
                    now: Date.now() }), 1000);
            } else if (!armed && panelUpdateClock) {
                clearInterval(panelUpdateClock);
                panelUpdateClock = undefined;
            }
        },

        /**
         * One effect of the panel update. The password of an apply exists only in its emit.
         * @param effect What the machine asked for
         */
        runPanelUpdateEffect(effect : PanelUpdateEffect) {
            switch (effect.type) {
                case "emit": {
                    const kind = effect.kind;
                    const requestId = effect.args[0];
                    this.emitPanelUpdate(PANEL_UPDATE_EVENTS[kind], effect.args, (result) => this.dispatchPanelUpdate({ type: "ACK",
                        kind,
                        requestId,
                        result,
                        now: Date.now() }));
                    break;
                }
                case "requestStatus": {
                    const ask = effect.ask;
                    this.emitPanelUpdate(PANEL_UPDATE_EVENTS.status, [], (result) => this.dispatchPanelUpdate({ type: "ACK",
                        kind: "status",
                        ask,
                        result,
                        now: Date.now() }));
                    break;
                }
                case "persist":
                    sessionValue(PANEL_UPDATE_STORAGE_KEY, JSON.stringify(effect.record));
                    break;
                case "clearPersist":
                    sessionValue(PANEL_UPDATE_STORAGE_KEY, null);
                    break;
                case "reload":
                    window.location.reload();
                    break;
            }
        },

        /**
         * Send a panel update event and always end with an answer. Offline nothing is sent:
         * socket.io would buffer the emit and deliver it after reconnecting, when the page
         * has already treated it as lost.
         * @param event Event name
         * @param args Arguments without the acknowledgement
         * @param done Receives the answer, or "lost"
         */
        emitPanelUpdate(event : string, args : readonly unknown[], done : (result : PanelUpdateAckResult) => void) {
            if (!socket?.connected) {
                setTimeout(() => done({ kind: "lost" }), 0);
                return;
            }
            socket.timeout(PANEL_UPDATE_ACK_MS).emit(event, ...args, (error : Error | null, ack : unknown) => {
                done(error ? { kind: "lost" } : readPanelUpdateAck(ack));
            });
        },

        /**
         * The newest release, from the server's info or from a manual check
         * @param latestVersion Newest release
         * @param updateAvailable Whether it is newer than the running one
         */
        panelUpdateInfo(latestVersion : string, updateAvailable : boolean) {
            this.dispatchPanelUpdate({ type: "INFO",
                latestVersion,
                updateAvailable });
        },

        /** Start the dry run of the newest release */
        panelUpdateCheck() {
            this.dispatchPanelUpdate({ type: "CHECK",
                owner: this.isAdmin,
                requestId: newPanelUpdateRequestId() });
        },

        /** Open the password dialog of a ready dry run */
        panelUpdateConfirm() {
            this.dispatchPanelUpdate({ type: "CONFIRM",
                owner: this.isAdmin });
        },

        /**
         * Start the update
         * @param password The owner's password, sent once and kept nowhere
         */
        panelUpdateSubmit(password : string) {
            this.dispatchPanelUpdate({ type: "SUBMIT",
                owner: this.isAdmin,
                password,
                requestId: newPanelUpdateRequestId(),
                now: Date.now() });
        },

        /** Cancel while the new version is still being fetched */
        panelUpdateCancel() {
            this.dispatchPanelUpdate({ type: "CANCEL",
                owner: this.isAdmin });
        },

        /** Close a finished update for everyone: the panel removes its helper */
        panelUpdateDismiss() {
            this.dispatchPanelUpdate({ type: "DISMISS",
                owner: this.isAdmin,
                now: Date.now() });
        },

        /** Close the dialog, the dry run or a result on this page only */
        panelUpdateClose() {
            this.dispatchPanelUpdate({ type: "CLOSE" });
        },

        /**
         * A chunk of the previous build is gone after an update. Outside an update the page
         * reloads once to get the current build; while one runs the panel may be down, and a
         * reload would land on the browser's error page.
         * @param event The cancelable Vite event
         */
        onPreloadError(event : Event) {
            if (this.panelUpdateSuppressing) {
                return;
            }
            const last = Number(sessionValue(PRELOAD_RELOAD_KEY));
            const now = Date.now();
            if (Number.isFinite(last) && now - last >= 0 && now - last < PRELOAD_RELOAD_GUARD_MS) {
                return;
            }
            sessionValue(PRELOAD_RELOAD_KEY, String(now));
            if (sessionValue(PRELOAD_RELOAD_KEY) !== String(now)) {
                // Storage is off: the next page could not tell it already reloaded, and would again
                return;
            }
            event.preventDefault();
            window.location.reload();
        },

        /**
         * Warn before leaving while an update runs and the panel does not answer: the browser
         * could not load the page again until the panel is back
         * @param event The unload event
         */
        onBeforeUnload(event : BeforeUnloadEvent) {
            if (this.panelUpdate.node.name === "running" && this.panelUpdate.ctx.link.kind === "offline") {
                event.preventDefault();
                // Browsers that predate preventDefault here ask only when this is set
                event.returnValue = "";
            }
        },

        bindTerminal(endpoint : string, terminalName : string, terminal : Terminal) {
            const token = terminalMap.begin(terminalName);
            // A late acknowledgement must not resurrect an unmounted renderer.
            // The buffer ends where the server answered, so the renderer is bound in that
            // same task: output right after the answer may already be the next event.
            this.emitAgentRequest(endpoint, "terminalJoin", [ terminalName ], { onAnswer: (res) => {
                if (res.ok) {
                    if (terminalMap.accept(terminalName, token, terminal)) {
                        terminal.write(res.buffer);
                    }
                } else if (terminalMap.reject(terminalName, token)) {
                    const root = this.$root as unknown as { toastRes: (response: AgentErrorResponse) => void };
                    root.toastRes(res);
                }
            } });
        },

        unbindTerminal(terminalName : string) {
            terminalMap.delete(terminalName);
        },

    }
});
