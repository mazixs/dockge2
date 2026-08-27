import { io } from "socket.io-client";
import { Socket } from "socket.io-client";
import { defineComponent } from "vue";
import { authClient } from "../auth-client";
import { authErrorMessage, isTotpCode } from "../auth-messages";
import { Terminal } from "@xterm/xterm";
import { AgentSocket } from "../../../common/agent-socket";

let socket : Socket;

let terminalMap : Map<string, Terminal> = new Map();

interface StackInfo {
    [key: string]: unknown;
}

type StackList = Record<string, StackInfo>;

interface AgentInfo {
    endpoint: string;
    name: string;
    [key: string]: unknown;
}

interface AgentInstance {
    stackList: StackList;
}

interface SocketInfo {
    version?: string;
    [key: string]: unknown;
}

interface SocketResponse {
    ok?: boolean;
    endpoint?: string;
    msg?: string;
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
                connectionErrorMsg: `${this.$t("Cannot connect to the socket server.")} ${this.$t("Reconnecting...")}`,
                showReverseProxyGuide: true,
                connecting: false,
            },
            info: {} as SocketInfo,
            loggedIn: false,
            allowLoginDialog: false,

            /** True when this instance runs with authentication switched off */
            authDisabled: false,

            /** Stack that was just created, so the list can point at it */
            freshStack: null as string | null,
            username: null as string | null,
            composeTemplate: "",

            stackList: {} as StackList,

            // All stack list from all agents
            allAgentStackList: {} as Record<string, AgentInstance>,

            // online / offline / connecting
            agentStatusList: {} as Record<string, string>,

            // Agent List
            agentList: {} as Record<string, AgentInfo>,
        };
    },
    computed: {

        agentCount() {
            return Object.keys(this.agentList).length;
        },

        completeStackList() {
            let list : Record<string, object> = {};

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
            if (from && to && from !== to) {
                window.location.reload();
            }
        },
    },
    created() {
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

            let connectingMsgTimeout = setTimeout(() => {
                this.socketIO.connecting = true;
            }, 1500);

            // withCredentials sends the session cookie during the handshake, which is how
            // the server identifies this client. No token is kept in the browser.
            socket = io(url, {
                withCredentials: true,
            });

            // Handling events from agents
            let agentSocket = new AgentSocket();
            socket.on("agent", (eventName : unknown, ...args : unknown[]) => {
                if (typeof eventName === "string") {
                    agentSocket.call(eventName, ...args);
                }
            });

            socket.on("connect", () => {
                console.log("Connected to the socket server");

                clearTimeout(connectingMsgTimeout);
                this.socketIO.connecting = false;

                this.socketIO.connectCount++;
                this.socketIO.connected = true;
                this.socketIO.showReverseProxyGuide = false;

                // The server tells us through `needAuth` or by acting as a logged in
                // client, so the UI only has to read the session for its display name
                this.refreshSession();

                this.socketIO.firstConnect = false;
            });

            socket.on("disconnect", () => {
                console.log("disconnect");
                this.socketIO.connectionErrorMsg = `${this.$t("Lost connection to the socket server. Reconnecting...")}`;
                this.socketIO.connected = false;
            });

            socket.on("connect_error", (err: Error) => {
                console.error(`Failed to connect to the backend. Socket.io connect_error: ${err.message}`);
                this.socketIO.connectionErrorMsg = `${this.$t("Cannot connect to the socket server.")} [${err}] ${this.$t("reconnecting...")}`;
                this.socketIO.showReverseProxyGuide = true;
                this.socketIO.connected = false;
                this.socketIO.firstConnect = false;
                this.socketIO.connecting = false;
            });

            // Custom Events

            socket.on("info", (info: SocketInfo) => {
                this.info = info;
            });

            socket.on("autoLogin", () => {
                // Authentication is disabled in the settings
                this.authDisabled = true;
                this.loggedIn = true;
                this.allowLoginDialog = false;
                this.afterLogin();
            });

            socket.on("needAuth", () => {
                this.authDisabled = false;
                this.loggedIn = false;
                this.username = null;
                this.allowLoginDialog = true;
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

            agentSocket.on("stackList", (...args: unknown[]) => {
                const res = args[0] as SocketResponse | undefined;
                if (res?.ok && res.stackList && typeof res.stackList === "object") {
                    const stackList = res.stackList as StackList;
                    if (!res.endpoint) {
                        this.stackList = stackList;
                    } else {
                        if (!this.allAgentStackList[res.endpoint]) {
                            this.allAgentStackList[res.endpoint] = {
                                stackList: {},
                            };
                        }
                        const instance = this.allAgentStackList[res.endpoint];
                        if (instance) {
                            instance.stackList = stackList;
                        }
                    }
                }
            });

            socket.on("stackStatusList", (res: { ok?: boolean; stackStatusList?: Record<string, unknown> }) => {
                if (res.ok && res.stackStatusList) {
                    for (let stackName in res.stackStatusList) {
                        const stackObj = this.stackList[stackName];
                        if (stackObj) {
                            stackObj.status = res.stackStatusList[stackName];
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
                }
            });

            socket.on("refresh", () => {
                location.reload();
            });
        },

        getSocket() : Socket {
            return socket;
        },

        emitAgent(endpoint : string, eventName : string, ...args : unknown[]) {
            this.getSocket().emit("agent", endpoint, eventName, ...args);
        },

        /**
         * Read the current session from the server and remember who is signed in
         * @returns {Promise<boolean>} Whether a session exists
         */
        async refreshSession() : Promise<boolean> {
            const { data, error } = await authClient.getSession();

            if (data?.user) {
                this.authDisabled = false;
                this.loggedIn = true;
                this.username = data.user.name || data.user.email;
                this.allowLoginDialog = false;
                this.afterLogin();
                return true;
            }

            // An instance with authentication switched off has no session by design,
            // and a failed request must not throw the user out of a working session
            if (this.authDisabled || error) {
                return false;
            }

            this.loggedIn = false;
            this.username = null;
            this.allowLoginDialog = true;
            return false;
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
            const { data, error } = await authClient.signIn.email({
                email,
                password,
            });

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
         * Hand the fresh session to the socket and remember who is signed in.
         * Doing it here rather than in the `connect` handler keeps the login form from
         * staying on screen while a second request is still in flight.
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

            await this.refreshSession();

            return { ok: true };
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
            this.stackList = {};
            this.allAgentStackList = {};
            this.agentList = {};
            this.agentStatusList = {};
            this.composeTemplate = "";
            this.freshStack = null;
        },

        afterLogin() {

        },

        bindTerminal(endpoint : string, terminalName : string, terminal : Terminal) {
            // Load terminal, get terminal screen
            this.emitAgent(endpoint, "terminalJoin", terminalName, (res: SocketResponse) => {
                if (res.ok) {
                    const buffer = res.buffer;
                    if (typeof buffer === "string" || buffer instanceof Uint8Array) {
                        terminal.write(buffer);
                    }
                    terminalMap.set(terminalName, terminal);
                } else {
                    const root = this.$root as unknown as { toastRes: (response: SocketResponse) => void };
                    root.toastRes(res);
                }
            });
        },

        unbindTerminal(terminalName : string) {
            terminalMap.delete(terminalName);
        },

    }
});
