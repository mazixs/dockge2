import "dotenv/config";
import { MainRouter } from "./routers/main-router";
import * as fs from "node:fs";
import { PackageJson } from "type-fest";
import { Database } from "./database";
import packageJSON from "../package.json";
import { log } from "./log";
import * as socketIO from "socket.io";
import express, { Express } from "express";
import { mountMcp } from "./mcp-server";
import { parse } from "ts-command-line-args";
import https from "https";
import http from "http";
import { Router } from "./router";
import { Socket } from "socket.io";
import { authorizeSocketEvent, normalizeRole, viewerStackSummary } from "./auth-access";
import { UsersSocketHandler } from "./socket-handlers/users-socket-handler";
import { MainSocketHandler } from "./socket-handlers/main-socket-handler";
import { SocketHandler } from "./socket-handler";
import { Settings } from "./settings";
import checkVersion from "./check-version";
import dayjs from "dayjs";
import { isDev, LooseObject } from "../common/util-common";
import { Arguments, Config, DockgeSocket, dropRevokedSessions } from "./util-server";
import { GitSocketHandler } from "./agent-socket-handlers/git-socket-handler";
import { StabilitySocketHandler } from "./agent-socket-handlers/stability-socket-handler";
import { observeContainerStability } from "./stability";
import { DockerSocketHandler } from "./agent-socket-handlers/docker-socket-handler";
import expressStaticGzip from "express-static-gzip";
import path from "path";
import { TerminalSocketHandler } from "./agent-socket-handlers/terminal-socket-handler";
import { Stack } from "./stack";
import { recordScan } from "./observations";
import { Cron } from "croner";
import gracefulShutdown from "http-graceful-shutdown";
import { spawn } from "./child-process";
import { AgentManager } from "./agent-manager";
import { AgentProxySocketHandler } from "./socket-handlers/agent-proxy-socket-handler";
import { AgentSocketHandler } from "./agent-socket-handler";
import { AgentSocket, AGENT_PROTOCOL_VERSION } from "../common/agent-socket";
import { ManageAgentSocketHandler } from "./socket-handlers/manage-agent-socket-handler";
import { Terminal } from "./terminal";
import { toNodeHandler } from "better-auth/node";
import { AUTH_BASE_PATH, CLIENT_IP_HEADER, countUsers, getAuth, initAuth, resolveSocketIdentity, resolveTrustedOrigins, trustsProxyHeaders } from "./auth";

export class DockgeServer {
    app : Express;
    httpServer : http.Server;
    packageJSON : PackageJson;
    io : socketIO.Server;
    config : Config;
    indexHTML : string = "";

    /**
     * List of express routers
     */
    routerList : Router[] = [
        new MainRouter(),
    ];

    /**
     * List of socket handlers (no agent support)
     */
    socketHandlerList : SocketHandler[] = [
        new MainSocketHandler(),
        new UsersSocketHandler(),
        new ManageAgentSocketHandler(),
    ];

    agentProxySocketHandler = new AgentProxySocketHandler();

    /**
     * List of socket handlers (support agent)
     */
    agentSocketHandlerList : AgentSocketHandler[] = [
        new DockerSocketHandler(),
        new StabilitySocketHandler(),
        new GitSocketHandler(),
        new TerminalSocketHandler(),
    ];

    /**
     * Show Setup Page
     */
    needSetup = false;

    stacksDir : string = "";

    /**
     *
     */
    constructor() {
        // Catch unexpected errors here
        let unexpectedErrorHandler = (error : unknown) => {
            console.trace(error);
            console.error("If you keep encountering errors, please report to https://github.com/mazixs/dockge2");
        };
        process.addListener("unhandledRejection", unexpectedErrorHandler);
        process.addListener("uncaughtException", unexpectedErrorHandler);

        if (!process.env.NODE_ENV) {
            process.env.NODE_ENV = "production";
        }

        // Log NODE ENV
        log.info("server", "NODE_ENV: " + process.env.NODE_ENV);

        // Default stacks directory
        let defaultStacksDir;
        if (process.platform === "win32") {
            defaultStacksDir = "./stacks";
        } else {
            defaultStacksDir = "/opt/stacks";
        }

        // Define all possible arguments
        let args = parse<Arguments>({
            sslKey: {
                type: String,
                optional: true,
            },
            sslCert: {
                type: String,
                optional: true,
            },
            sslKeyPassphrase: {
                type: String,
                optional: true,
            },
            port: {
                type: Number,
                optional: true,
            },
            hostname: {
                type: String,
                optional: true,
            },
            dataDir: {
                type: String,
                optional: true,
            },
            stacksDir: {
                type: String,
                optional: true,
            },
            enableConsole: {
                type: Boolean,
                optional: true,
                defaultValue: false,
            }
        });

        this.config = args as Config;

        // Load from environment variables or default values if args are not set
        this.config.sslKey = args.sslKey || process.env.DOCKGE_SSL_KEY || undefined;
        this.config.sslCert = args.sslCert || process.env.DOCKGE_SSL_CERT || undefined;
        this.config.sslKeyPassphrase = args.sslKeyPassphrase || process.env.DOCKGE_SSL_KEY_PASSPHRASE || undefined;
        this.config.port = args.port || Number(process.env.DOCKGE_PORT) || 5001;
        this.config.hostname = args.hostname || process.env.DOCKGE_HOSTNAME || undefined;
        this.config.dataDir = args.dataDir || process.env.DOCKGE_DATA_DIR || "./data/";
        this.config.stacksDir = args.stacksDir || process.env.DOCKGE_STACKS_DIR || defaultStacksDir;
        this.config.enableConsole = args.enableConsole || process.env.DOCKGE_ENABLE_CONSOLE === "true" || false;
        this.stacksDir = this.config.stacksDir;

        // The passphrase of the TLS key must not reach the log, even in development
        log.debug("server", {
            ...this.config,
            sslKeyPassphrase: this.config.sslKeyPassphrase ? "<hidden>" : undefined,
        });

        this.packageJSON = packageJSON as PackageJson;

        try {
            this.indexHTML = fs.readFileSync("./frontend-dist/index.html").toString();
        } catch (e) {
            // "dist/index.html" is not necessary for development
            if (process.env.NODE_ENV !== "development") {
                log.error("server", "Error: Cannot find 'frontend-dist/index.html', did you install correctly?");
                process.exit(1);
            }
        }

        // Create express
        this.app = express();

        // Create HTTP server
        if (this.config.sslKey && this.config.sslCert) {
            log.info("server", "Server Type: HTTPS");
            this.httpServer = https.createServer({
                key: fs.readFileSync(this.config.sslKey),
                cert: fs.readFileSync(this.config.sslCert),
                passphrase: this.config.sslKeyPassphrase,
            }, this.app);
        } else {
            log.info("server", "Server Type: HTTP");
            this.httpServer = http.createServer(this.app);
        }

        // The auth handler has to see the raw body, so it is mounted before any parser
        this.app.all(`${AUTH_BASE_PATH}/*`, (request, response, next) => {
            // The address the auth layer counts attempts by comes from the connection,
            // never from a header the caller could have written
            delete request.headers[CLIENT_IP_HEADER];
            request.headers[CLIENT_IP_HEADER] = this.resolveClientAddress(request);

            // The UI and the backend do not always share an origin: the Vite dev server
            // runs on its own port, and a deployment can be proxied under another host.
            // Such a request carries the session cookie, so it needs an explicit origin
            // and credentials allowance, and only trusted origins get one.
            const browserOrigins = new Set(resolveTrustedOrigins(this, {
                host: request.headers.host,
                forwardedHost: firstHeaderValue(request.headers["x-forwarded-host"]),
                forwardedProto: firstHeaderValue(request.headers["x-forwarded-proto"]),
            }));

            const origin = request.headers.origin;
            const allowed = Boolean(origin) && browserOrigins.has(origin as string);

            // Always, so a cached answer without CORS headers is not served to an
            // origin that would have been allowed
            response.setHeader("Vary", "Origin");

            if (allowed) {
                response.setHeader("Access-Control-Allow-Origin", origin as string);
                response.setHeader("Access-Control-Allow-Credentials", "true");
            }

            // The preflight never reaches the auth handler, which answers it with a 404
            if (request.method === "OPTIONS") {
                if (!allowed) {
                    response.sendStatus(403);
                    return;
                }

                response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                response.setHeader("Access-Control-Allow-Headers", "content-type");
                response.setHeader("Access-Control-Max-Age", "600");
                response.sendStatus(204);
                return;
            }

            toNodeHandler(getAuth())(request, response)
                .then(() => dropRevokedSessions(this.io.sockets.sockets.values() as Iterable<DockgeSocket>))
                .catch(next);
        });

        mountMcp(this);

        // Binding Routers
        for (const router of this.routerList) {
            this.app.use(router.create(this.app, this));
        }

        // Static files. Имя файла в /assets/ содержит хеш содержимого, поэтому
        // ответ можно объявить неизменяемым: другое содержимое - другое имя, и
        // браузер не переспрашивает про каждый файл при каждой загрузке
        this.app.use("/assets", expressStaticGzip("frontend-dist/assets", {
            enableBrotli: true,
            serveStatic: {
                immutable: true,
                maxAge: "1y",
            },
        }));

        // Все остальное - index.html, manifest.json, иконки - имя не меняет.
        // Долгий срок оставил бы браузеру прежнюю версию после обновления панели
        this.app.use("/", expressStaticGzip("frontend-dist", {
            enableBrotli: true,
        }));

        // Universal Route Handler, must be at the end of all express routes.
        this.app.get("*", async (_request, response) => {
            // index.html имени не меняет и ссылается на хешированные ассеты,
            // поэтому браузер обязан спрашивать его заново: иначе после
            // обновления панели он открыл бы старую страницу с мертвыми ссылками
            response.set("Cache-Control", "no-cache");
            response.send(this.indexHTML);
        });

        // In development the UI is served from the Vite port, so the socket is cross origin.
        // The handshake carries the session cookie, and a credentialed request may not use
        // a wildcard origin, so the trusted origins are listed explicitly.
        let cors : socketIO.ServerOptions["cors"];
        if (isDev) {
            cors = {
                origin: resolveTrustedOrigins(this),
                credentials: true,
            };
        }

        // Create Socket.io
        const socketOptions: Partial<socketIO.ServerOptions> = {
            allowRequest: (req, callback) => {
                let isOriginValid = true;
                const bypass = isDev || process.env.DOCKGE_WS_ORIGIN_CHECK === "bypass";

                if (!bypass) {
                    // If this is set, it means the request is from the browser
                    const origin = req.headers.origin;

                    if (!origin) {
                        log.info("auth", `Origin is not set, IP: ${req.socket.remoteAddress}`);
                    } else if (!isHandshakeOriginTrusted(this, req.headers)) {
                        isOriginValid = false;
                        log.error("auth", `Origin (${origin}) is not trusted, IP: ${req.socket.remoteAddress}`);
                    }
                } else {
                    log.debug("auth", "Origin check is bypassed");
                }

                callback(null, isOriginValid);
            }
        };
        if (cors) {
            socketOptions.cors = cors;
        }
        this.io = new socketIO.Server(this.httpServer, socketOptions);

        this.io.on("connection", async (socket: Socket) => {
            let dockgeSocket = socket as DockgeSocket;
            const identityReady = resolveSocketIdentity(socket.request.headers).then((identity) => {
                dockgeSocket.userID = identity.userID ?? "";
                dockgeSocket.userRole = identity.role ?? "viewer";
                return identity;
            });
            dockgeSocket.instanceManager = new AgentManager(dockgeSocket);
            // Default deny at the transport boundary, including future handlers.
            dockgeSocket.use(async (packet, next) => {
                const [ event, ...args ] = packet;
                if (event === "needsSetup") {
                    next();
                    return;
                }
                try {
                    await identityReady;
                    if (event === "agent") {
                        if (typeof args[1] !== "string") {
                            throw new Error("authPermissionDenied");
                        }
                        await authorizeSocketEvent(dockgeSocket, args[1], true);
                    } else {
                        await authorizeSocketEvent(dockgeSocket, event);
                    }
                    next();
                } catch (error) {
                    const callback = args[args.length - 1];
                    if (typeof callback === "function") {
                        callback({ ok: false,
                            msg: error instanceof Error ? error.message : "authPermissionDenied",
                            msgi18n: true });
                    }
                    // Do not call next: a denied packet must not reach its handler.
                }
            });
            dockgeSocket.emitAgent = (event : string, ...args : unknown[]) => {
                if (!dockgeSocket.connected || (dockgeSocket.userRole === "viewer" && event !== "stackList")) {
                    return;
                }
                let obj = args[0];
                if (typeof(obj) === "object") {
                    let obj2 = obj as LooseObject;
                    obj2.endpoint = dockgeSocket.endpoint;
                }
                dockgeSocket.emit("agent", event, ...args);
            };

            if (typeof(socket.request.headers.endpoint) === "string") {
                dockgeSocket.endpoint = socket.request.headers.endpoint;
            } else {
                dockgeSocket.endpoint = "";
            }

            if (dockgeSocket.endpoint) {
                log.info("server", "Socket connected (agent), as endpoint " + dockgeSocket.endpoint);
            } else {
                log.info("server", "Socket connected (direct)");
            }

            this.sendInfo(dockgeSocket, true);

            // Asked per connection, not from a flag decided at start up: the account is
            // created through the auth endpoints, so the server would otherwise keep
            // sending every new socket to the setup screen after setup was done
            this.needSetup = await this.shouldShowSetup();

            if (this.needSetup) {
                log.info("server", "Redirect to setup page");
                dockgeSocket.emit("setup");
            }

            // Create socket handlers (original, no agent support)
            for (const socketHandler of this.socketHandlerList) {
                socketHandler.create(dockgeSocket, this);
            }

            // Create Agent Socket
            let agentSocket = new AgentSocket();

            // Create agent socket handlers
            for (const socketHandler of this.agentSocketHandlerList) {
                socketHandler.create(dockgeSocket, this, agentSocket);
            }

            // Create agent proxy socket handlers
            this.agentProxySocketHandler.create2(dockgeSocket, this, agentSocket);

            // ***************************
            // Better do anything after added all socket handlers here
            // ***************************

            // Who this socket is comes from the session cookie of the handshake,
            // verified by better-auth. There is no login event on the socket any more.
            const identity = await identityReady;

            if (identity.userID) {
                if (identity.autoLogin) {
                    log.info("auth", "Disabled Auth: acting as the owner account");
                }

                dockgeSocket.userRole = identity.role ?? "viewer";
                await this.afterLogin(dockgeSocket, identity.userID);

                if (identity.autoLogin) {
                    dockgeSocket.emit("autoLogin");
                }
            } else {
                log.debug("auth", "No session, the client has to sign in");
                dockgeSocket.emit("needAuth");
            }

            // Socket disconnect
            dockgeSocket.on("disconnect", () => {
                log.info("server", "Socket disconnected!");
                dockgeSocket.instanceManager.disconnectAll();
            });

        });

        this.io.on("disconnect", () => {

        });

        if (isDev) {
            setInterval(() => {
                log.debug("terminal", "Terminal count: " + Terminal.getTerminalCount());
            }, 5000);
        }
    }

    /**
     * Whether the UI has to offer the setup screen.
     *
     * Read from the database on every question rather than kept in a flag: the account
     * is created through the auth endpoints, and a stale flag would send the owner back
     * to the setup screen on every reconnect.
     * @returns Whether this instance still has no account
     */
    async shouldShowSetup() : Promise<boolean> {
        return await countUsers() === 0;
    }

    /**
     * Everything a socket needs once its user is known
     * @param socket Client socket
     * @param userID Identifier of the signed in user
     */
    async afterLogin(socket : DockgeSocket, userID : string) {
        socket.userID = userID;
        socket.join(userID);
        socket.userRole = normalizeRole(socket.userRole);
        socket.emit("authIdentity", { userID,
            role: socket.userRole });

        this.sendInfo(socket);

        try {
            await this.sendStackList();
        } catch (e) {
            log.error("server", e);
        }

        socket.instanceManager.sendAgentList();

        // Also connect to other dockge instances
        socket.instanceManager.connectAll();
    }

    /**
     *
     */
    async serve() {
        // Create all the necessary directories
        this.initDataDir();

        // Connect to database
        try {
            await Database.init(this);
            await initAuth(this);
        } catch (e) {
            if (e instanceof Error) {
                log.error("server", "Failed to prepare your database: " + e.message);
            }
            process.exit(1);
        }

        // First time setup if needed: the account itself is created through the auth
        // endpoints, this only decides whether the UI shows the setup screen
        this.needSetup = await this.shouldShowSetup();

        if (this.needSetup) {
            log.info("server", "No account yet, the UI will ask to create one");
        }

        // Listen
        this.httpServer.listen(this.config.port, this.config.hostname, () => {
            if (this.config.hostname) {
                log.info( "server", `Listening on ${this.config.hostname}:${this.config.port}`);
            } else {
                log.info("server", `Listening on ${this.config.port}`);
            }

            // Run every 10 seconds
            new Cron("*/10 * * * * *", {
                protect: true,  // Enabled over-run protection.
            }, async () => {
                await this.observeStacks().catch((e) => log.error("observations", e));
                await this.sendStackList(true);

                // A socket is identified once, during its handshake, so a session that
                // was signed out or revoked elsewhere has to lose its open sockets here
                await dropRevokedSessions(this.io.sockets.sockets.values() as Iterable<DockgeSocket>)
                    .catch((e) => log.error("auth", e));
            });

            checkVersion.startInterval();
        });

        gracefulShutdown(this.httpServer, {
            signals: "SIGINT SIGTERM",
            timeout: 30000,                   // timeout: 30 secs
            development: false,               // not in dev mode
            forceExit: true,                  // triggers process.exit() at the end of shutdown process
            onShutdown: this.shutdownFunction,     // shutdown function (async) - e.g. for cleanup DB, ...
            finally: this.finalFunction,            // finally function (sync) - e.g. for logging
        });

    }

    /**
     * Emits the version information to the client.
     * @param socket Socket.io socket instance
     * @param hideVersion Should we hide the version information in the response?
     * @returns
     */
    async sendInfo(socket : Socket, hideVersion = false) {
        let versionProperty;
        let latestVersionProperty;
        let isContainer;
        let agentProtocolProperty;

        if (!hideVersion) {
            versionProperty = packageJSON.version;
            latestVersionProperty = checkVersion.latestVersion;
            isContainer = (process.env.DOCKGE_IS_CONTAINER === "1");
            // Said alongside the version, not instead of it: a panel connecting to
            // this one as an agent decides on the protocol, while the version is
            // what a person reads. Both stay hidden before sign-in
            agentProtocolProperty = AGENT_PROTOCOL_VERSION;
        }

        socket.emit("info", {
            version: versionProperty,
            latestVersion: latestVersionProperty,
            agentProtocol: agentProtocolProperty,
            isContainer,
            primaryHostname: await Settings.get("primaryHostname"),
            //serverTimezone: await this.getTimezone(),
            //serverTimezoneOffset: this.getTimezoneOffset(),
        });
    }

    /**
     * Address an HTTP request came from.
     *
     * The connection is the source of truth. A proxy header is only read when the
     * operator declared that there is a proxy in front, because otherwise the caller
     * writes that header itself and would choose its own rate limit bucket.
     * @param request Incoming request
     * @returns Address of the client
     */
    resolveClientAddress(request : express.Request) : string {
        if (trustsProxyHeaders()) {
            const forwardedFor = firstHeaderValue(request.headers["x-forwarded-for"]);
            const realIP = firstHeaderValue(request.headers["x-real-ip"]);
            const forwarded = forwardedFor?.split(",")[0]?.trim() || realIP?.trim();

            if (forwarded) {
                return forwarded;
            }
        }

        return (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "") || "unknown";
    }

    /**
     * Get the IP of the client connected to the socket
     * @param {Socket} socket Socket to query
     * @returns IP of client
     */
    async getClientIP(socket : Socket) : Promise<string> {
        let clientIP = socket.client.conn.remoteAddress;

        if (clientIP === undefined) {
            clientIP = "";
        }

        if (trustsProxyHeaders() || await Settings.get("trustProxy")) {
            const forwardedFor = socket.client.conn.request.headers["x-forwarded-for"];

            if (typeof forwardedFor === "string") {
                return forwardedFor.split(",")[0]?.trim() || "";
            } else if (typeof socket.client.conn.request.headers["x-real-ip"] === "string") {
                return socket.client.conn.request.headers["x-real-ip"];
            }
        }
        return clientIP.replace(/^::ffff:/, "");
    }

    /**
     * Attempt to get the current server timezone
     * If this fails, fall back to environment variables and then make a
     * guess.
     * @returns {Promise<string>} Current timezone
     */
    async getTimezone() {
        // From process.env.TZ
        try {
            if (process.env.TZ) {
                this.checkTimezone(process.env.TZ);
                return process.env.TZ;
            }
        } catch (e) {
            if (e instanceof Error) {
                log.warn("timezone", e.message + " in process.env.TZ");
            }
        }

        const timezone = await Settings.get("serverTimezone");

        // From Settings
        try {
            log.debug("timezone", "Using timezone from settings: " + timezone);
            if (timezone) {
                this.checkTimezone(timezone);
                return timezone;
            }
        } catch (e) {
            if (e instanceof Error) {
                log.warn("timezone", e.message + " in settings");
            }
        }

        // Guess
        try {
            const guess = dayjs.tz.guess();
            log.debug("timezone", "Guessing timezone: " + guess);
            if (guess) {
                this.checkTimezone(guess);
                return guess;
            } else {
                return "UTC";
            }
        } catch (e) {
            // Guess failed, fall back to UTC
            log.debug("timezone", "Guessed an invalid timezone. Use UTC as fallback");
            return "UTC";
        }
    }

    /**
     * Get the current offset
     * @returns {string} Time offset
     */
    getTimezoneOffset() {
        return dayjs().format("Z");
    }

    /**
     * Throw an error if the timezone is invalid
     * @param {string} timezone Timezone to test
     * @returns {void}
     * @throws The timezone is invalid
     */
    checkTimezone(timezone : string) {
        try {
            dayjs.utc("2013-11-18 11:55").tz(timezone).format();
        } catch (e) {
            throw new Error("Invalid timezone:" + timezone, { cause: e });
        }
    }

    /**
     * Initialize the data directory
     */
    initDataDir() {
        if (! fs.existsSync(this.config.dataDir)) {
            fs.mkdirSync(this.config.dataDir, { recursive: true });
        }

        // Check if a directory
        if (!fs.lstatSync(this.config.dataDir).isDirectory()) {
            throw new Error(`Fatal error: ${this.config.dataDir} is not a directory`);
        }

        // Create data/stacks directory
        if (!fs.existsSync(this.stacksDir)) {
            fs.mkdirSync(this.stacksDir, { recursive: true });
        }

        log.info("server", `Data Dir: ${this.config.dataDir}`);
    }

    /**
     * Send stack list to all connected sockets
     * @param useCache
     */
    /**
     * Записать состояние всех стеков в историю.
     *
     * Отдельно от рассылки списка: доступность обязана считаться и тогда, когда панель
     * никто не открыл, иначе процент описывал бы не работу стека, а время, которое
     * владелец смотрел в экран.
     * @returns void
     */
    async observeStacks() : Promise<void> {
        const stackList = await Stack.getStackList(this, true);

        await recordScan([ ...stackList.values() ].map((stack) => ({
            name: stack.name,
            endpoint: "",
            status: stack.status,
        })));
        await observeContainerStability(stackList, await Stack.getOwnProjectName());
    }

    async sendStackList(useCache = false) {
        let socketList = this.io.sockets.sockets.values();

        let stackList;

        for (let socket of socketList) {
            let dockgeSocket = socket as DockgeSocket;

            // Check if the room is a number (user id)
            if (dockgeSocket.userID) {

                // Get the list only if there is a logged in user
                if (!stackList) {
                    stackList = await Stack.getStackList(this, useCache);
                    await Stack.fillAvailability(stackList);
                }

                let map : Map<string, object> = new Map();

                for (let [ stackName, stack ] of stackList) {
                    const summary = stack.toSimpleJSON(dockgeSocket.endpoint);
                    map.set(stackName, dockgeSocket.userRole === "viewer" ? viewerStackSummary(summary) : summary);
                }

                log.debug("server", "Send stack list to user: " + dockgeSocket.id + " (" + dockgeSocket.endpoint + ")");
                dockgeSocket.emitAgent("stackList", {
                    ok: true,
                    stackList: Object.fromEntries(map),
                });
            }
        }
    }

    async getDockerNetworkList() : Promise<string[]> {
        let res = await spawn("docker", [ "network", "ls", "--format", "{{.Name}}" ], {
            encoding: "utf-8",
            maxBuffer: 1024 * 1024,
            timeoutMs: 30_000,
        });

        if (!res.stdout) {
            return [];
        }

        let list = res.stdout.toString().split("\n");

        // Remove empty string item
        list = list.filter((item) => {
            return item !== "";
        }).sort((a, b) => {
            return a.localeCompare(b);
        });

        return list;
    }

    async getDockerStats() : Promise<Map<string, object>> {
        let stats = new Map<string, object>();

        try {
            let res = await spawn("docker", [ "stats", "--format", "json", "--no-stream" ], {
                encoding: "utf-8",
                maxBuffer: 4 * 1024 * 1024,
                timeoutMs: 30_000,
            });

            if (!res.stdout) {
                return stats;
            }

            let lines = res.stdout?.toString().split("\n");

            for (let line of lines) {
                try {
                    let obj = JSON.parse(line);
                    stats.set(obj.Name, obj);
                } catch (e) {
                }
            }

            return stats;
        } catch (e) {
            log.error("getDockerStats", e);
            return stats;
        }
    }

    get stackDirFullPath() {
        return path.resolve(this.stacksDir);
    }

    /**
     * Shutdown the application
     * Stops all monitors and closes the database connection.
     * @param signal The signal that triggered this function to be called.
     */
    async shutdownFunction(signal : string | undefined) {
        log.info("server", "Shutdown requested");
        log.info("server", "Called signal: " + signal);

        // TODO: Close all terminals?

        await Database.close();
        Settings.stopCacheCleaner();
    }

    /**
     * Final function called before application exits
     */
    finalFunction() {
        log.info("server", "Graceful shutdown successful!");
    }

    /**
     * Force connected sockets of a user to refresh and disconnect.
     * Used for resetting password.
     * @param {string} userID
     * @param {string?} currentSocketID
     */
    disconnectAllSocketClients(userID: string | undefined, currentSocketID? : string) {
        for (const rawSocket of this.io.sockets.sockets.values()) {
            let socket = rawSocket as DockgeSocket;
            if ((!userID || socket.userID === userID) && socket.id !== currentSocketID) {
                try {
                    socket.instanceManager?.disconnectAll();
                    socket.emit("refresh");
                    socket.disconnect();
                } catch (e) {

                }
            }
        }
    }

    isSSL() {
        return this.config.sslKey && this.config.sslCert;
    }

    /**
     * Origin the server is reachable at, used as the auth base URL
     * @returns Base URL without a trailing slash
     */
    getBaseURL() {
        const protocol = this.isSSL() ? "https" : "http";
        const host = this.config.hostname || "localhost";
        return `${protocol}://${host}:${this.config.port}`;
    }

    getLocalWebSocketURL() {
        const protocol = this.isSSL() ? "wss" : "ws";
        const host = this.config.hostname || "localhost";
        return `${protocol}://${host}:${this.config.port}`;
    }

}

/**
 * Whether a socket handshake may proceed.
 * The address the browser used is not always the `Host` this process sees: a reverse
 * proxy usually rewrites it. Comparing the origin to that one header refused every
 * websocket behind a proxy, although the page itself had already loaded, and the only
 * way out was to switch the check off completely. The same set of trusted origins that
 * guards the authentication endpoints decides here.
 * @param server Server the handshake arrived at
 * @param headers Headers of the handshake request
 * @returns True when the origin may open a socket
 */
export function isHandshakeOriginTrusted(server : DockgeServer, headers : http.IncomingHttpHeaders) : boolean {
    const origin = headers.origin;

    // Not a browser: there is nothing to compare, and the session still decides
    if (!origin) {
        return true;
    }

    const trusted = new Set(resolveTrustedOrigins(server, {
        host: headers.host,
        forwardedHost: firstHeaderValue(headers["x-forwarded-host"]),
        forwardedProto: firstHeaderValue(headers["x-forwarded-proto"]),
    }));

    return trusted.has(origin);
}

/**
 * First value of a header that may arrive several times
 * @param value Header value as Node reports it
 * @returns Single value, or undefined when the header is absent
 */
function firstHeaderValue(value : string | string[] | undefined) : string | undefined {
    if (Array.isArray(value)) {
        return value[0];
    }

    return value;
}
