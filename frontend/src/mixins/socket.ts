import { io } from "socket.io-client";
import { Socket } from "socket.io-client";
import { defineComponent } from "vue";
import { jwtDecode } from "jwt-decode";
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
    tokenRequired?: boolean;
    token?: string;
    endpoint?: string;
    msg?: string;
    [key: string]: unknown;
}

interface LoginCallback {
    (response: SocketResponse): void;
}

export default defineComponent({
    data() {
        return {
            socketIO: {
                token: null as string | null,
                firstConnect: true,
                connected: false,
                connectCount: 0,
                initedSocketIO: false,
                connectionErrorMsg: `${this.$t("Cannot connect to the socket server.")} ${this.$t("Reconnecting...")}`,
                showReverseProxyGuide: true,
                connecting: false,
            },
            info: {} as SocketInfo,
            remember: (localStorage.remember !== "0"),
            loggedIn: false,
            allowLoginDialog: false,
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

        remember() {
            localStorage.remember = (this.remember) ? "1" : "0";
        },

        // Reload the SPA if the server version is changed.
        "info.version"(to, from) {
            if (from && from !== to) {
                window.location.reload();
            }
        },
    },
    created() {
        this.initSocketIO();
    },
    mounted() {
        return;

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

            socket = io(url);

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
                const token = this.storage().token;

                if (token) {
                    if (token !== "autoLogin") {
                        console.log("Logging in by token");
                        this.loginByToken(token);
                    } else {
                        // Timeout if it is not actually auto login
                        setTimeout(() => {
                            if (! this.loggedIn) {
                                this.allowLoginDialog = true;
                                this.storage().removeItem("token");
                            }
                        }, 5000);
                    }
                } else {
                    this.allowLoginDialog = true;
                }

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
                this.loggedIn = true;
                this.storage().token = "autoLogin";
                this.socketIO.token = "autoLogin";
                this.allowLoginDialog = false;
                this.afterLogin();
            });

            socket.on("setup", () => {
                console.log("setup");
                this.$router.push("/setup");
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

        /**
         * The storage currently in use
         * @returns Current storage
         */
        storage() : Storage {
            return (this.remember) ? localStorage : sessionStorage;
        },

        getSocket() : Socket {
            return socket;
        },

        emitAgent(endpoint : string, eventName : string, ...args : unknown[]) {
            this.getSocket().emit("agent", endpoint, eventName, ...args);
        },

        /**
         * Get payload of JWT cookie
         * @returns {(object | undefined)} JWT payload
         */
        getJWTPayload() {
            const jwtToken = this.storage().token;

            if (jwtToken && jwtToken !== "autoLogin") {
                return jwtDecode<{ username?: string }>(jwtToken);
            }
            return undefined;
        },

        /**
         * Send request to log user in
         * @param {string} username Username to log in with
         * @param {string} password Password to log in with
         * @param {string} token User token
         * @param {loginCB} callback Callback to call with result
         * @returns {void}
         */
        login(username : string, password : string, token : string, callback: LoginCallback) {
            this.getSocket().emit("login", {
                username,
                password,
                token,
            }, (res: SocketResponse) => {
                if (res.tokenRequired) {
                    callback(res);
                }

                if (res.ok) {
                    if (typeof res.token !== "string") {
                        return;
                    }
                    this.storage().token = res.token;
                    this.socketIO.token = res.token;
                    this.loggedIn = true;
                    this.username = this.getJWTPayload()?.username ?? null;

                    this.afterLogin();

                    // Trigger Chrome Save Password
                    history.pushState({}, "");
                }

                callback(res);
            });
        },

        /**
         * Log in using a token
         * @param {string} token Token to log in with
         * @returns {void}
         */
        loginByToken(token : string) {
            socket.emit("loginByToken", token, (res: SocketResponse) => {
                this.allowLoginDialog = true;

                if (! res.ok) {
                    this.logout();
                } else {
                    this.loggedIn = true;
                    this.username = this.getJWTPayload()?.username ?? null;
                    this.afterLogin();
                }
            });
        },

        /**
         * Log out of the web application
         * @returns {void}
         */
        logout() {
            socket.emit("logout", () => { });
            this.storage().removeItem("token");
            this.socketIO.token = null;
            this.loggedIn = false;
            this.username = null;
            this.clearData();
        },

        /**
         * @returns {void}
         */
        clearData() {

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
