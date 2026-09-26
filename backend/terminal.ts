import { OperationError } from "./operation-error";
import { DockgeServer } from "./dockge-server";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { TerminalBuffer } from "./utils/terminal-buffer";
import { sleep } from "../common/util-common";
import { DockgeSocket } from "./util-server";
import {
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_COLS,
    TERMINAL_ROWS
} from "../common/util-common";
import { log } from "./log";
import { Settings } from "./settings";

function commandExistsSync(command : string) {
    try {
        execFileSync(process.platform === "win32" ? "where.exe" : "which", [ command ], {
            stdio: "ignore",
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Whose private session a terminal is. Shells are private: sharing one let the next user
 * inherit the history and environment of the previous one, or type into a live shell.
 */
export interface TerminalOwner {
    /** Account the socket signed in as */
    user : string;
    /**
     * Person behind a panel that connects as an agent: every user of that panel signs in
     * with the same agent account, so the panel names them in a header
     */
    client : string;
}

/** Header a panel names its user with when it connects to an agent */
export const TERMINAL_CLIENT_HEADER = "x-dockge-terminal-client";

/**
 * The value a panel sends in TERMINAL_CLIENT_HEADER for one of its users
 * @param userID Account on the panel
 * @returns A stable key that does not reveal the account ID to the agent
 */
export function terminalClientKey(userID : string) : string {
    return createHash("sha256").update(userID).digest("hex").slice(0, 16);
}

/**
 * Who a socket's private sessions belong to. The header only divides the sessions of one
 * account, so a client that forges it never reaches the sessions of another account.
 * @param socket Client socket
 * @returns Owner of the sessions this socket opens
 */
export function terminalOwner(socket : DockgeSocket) : TerminalOwner {
    const client = socket.request?.headers?.[TERMINAL_CLIENT_HEADER];
    return { user: String(socket.userID ?? ""),
        client: typeof client === "string" && /^[a-f0-9]{16}$/.test(client) ? client : "" };
}

/**
 * Terminal for running commands, no user interaction
 */
export class Terminal {
    protected static terminalMap : Map<string, Terminal> = new Map();

    protected _ptyProcess? : pty.IPty;
    protected server : DockgeServer;
    protected buffer = new TerminalBuffer();
    protected _name : string;

    protected file : string;
    protected args : string | string[];
    protected cwd : string;
    protected callback? : (exitCode : number) => void;

    protected _rows : number = TERMINAL_ROWS;
    protected _cols : number = TERMINAL_COLS;

    public enableKeepAlive : boolean = false;
    protected keepAliveInterval? : NodeJS.Timeout;
    protected kickDisconnectedClientsInterval? : NodeJS.Timeout;

    protected socketList : Record<string, DockgeSocket> = {};

    /** True once this terminal started shutting down, so it is never revived */
    protected ending : boolean = false;

    /** True once the process of this terminal exited */
    protected _exited : boolean = false;

    private executionError : OperationError | undefined;
    private commandExecution = false;

    /** Owner of a private session; output that everyone allowed may watch has none */
    readonly owner : TerminalOwner | undefined;

    constructor(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string, owner? : TerminalOwner) {
        this.server = server;
        this._name = name;
        //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
        this.file = file;
        this.args = args;
        this.cwd = cwd;
        this.owner = owner;

        Terminal.terminalMap.set(this.key, this);
    }

    /**
     * Registry key. A private session is filed under its owner, so the same name asked for
     * by somebody else never reaches it; the encoding keeps a crafted name from colliding.
     * @param name Name the client uses
     * @param owner Owner of a private session
     * @returns Key in the registry
     */
    private static keyOf(name : string, owner? : TerminalOwner) : string {
        return JSON.stringify(owner ? [ owner.user, owner.client, name ] : [ name ]);
    }

    private get key() : string {
        return Terminal.keyOf(this.name, this.owner);
    }

    get rows() {
        return this._rows;
    }

    set rows(rows : number) {
        this._rows = rows;
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    get cols() {
        return this._cols;
    }

    set cols(cols : number) {
        this._cols = cols;
        log.debug("Terminal", `Terminal cols: ${this._cols}`); // Added to check if cols is being set when changing terminal size.
        try {
            this.ptyProcess?.resize(this.cols, this.rows);
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to resize terminal: " + e.message);
            }
        }
    }

    public start() {
        if (this._ptyProcess) {
            return;
        }

        this.kickDisconnectedClientsInterval = setInterval(() => {
            for (const socketID in this.socketList) {
                const socket = this.socketList[socketID];
                if (!socket) {
                    continue;
                }
                if (!socket.connected) {
                    log.debug("Terminal", "Kicking disconnected client " + socket.id + " from terminal " + this.name);
                    this.leave(socket);
                }
            }

            // A closed browser tab never sends terminalLeave, so an abandoned container
            // shell has to be ended here, otherwise `docker exec` lives on forever
            if (this.clientCount === 0 && this.name.startsWith("container-exec-")) {
                log.debug("Terminal", "Terminal " + this.name + " lost all clients, ending it");
                void this.end();
            }
        }, 60 * 1000);

        if (this.enableKeepAlive) {
            log.debug("Terminal", "Keep alive enabled for terminal " + this.name);

            // Close if there is no clients
            this.keepAliveInterval = setInterval(() => {
                const numClients = Object.keys(this.socketList).length;

                if (numClients === 0) {
                    log.debug("Terminal", "Terminal " + this.name + " has no client, closing...");
                    this.close();
                } else {
                    log.debug("Terminal", "Terminal " + this.name + " has " + numClients + " client(s)");
                }
            }, 60 * 1000);
        } else {
            log.debug("Terminal", "Keep alive disabled for terminal " + this.name);
        }

        try {
            if (this.commandExecution && !commandExistsSync(this.file)) {
                this.executionError = new OperationError("spawn", "operationSpawnFailed");
                this.exit({ exitCode: 1 });
                return;
            }
            this._ptyProcess = pty.spawn(this.file, this.args, {
                name: this.name,
                cwd: this.cwd,
                cols: this.cols,
                rows: this.rows,
            });

            // On Data
            this._ptyProcess.onData((data) => {
                this.buffer.pushItem(data);

                for (const socketID in this.socketList) {
                    const socket = this.socketList[socketID];
                    if (!socket) {
                        continue;
                    }
                    socket.emitAgent("terminalWrite", this.name, data);
                }
            });

            // On Exit
            this._ptyProcess.onExit(this.exit);
        } catch (error) {
            if (error instanceof Error) {
                clearInterval(this.keepAliveInterval);

                log.error("Terminal", "Failed to start terminal: " + error.message);
                this.executionError = new OperationError("spawn", "operationSpawnFailed");
                const exitCode = 1;
                this.exit({
                    exitCode,
                });
            }
        }
    }

    /**
     * Exit event handler
     * @param res
     */
    protected exit = (res : {exitCode: number, signal?: number | undefined}) => {
        for (const socketID in this.socketList) {
            const socket = this.socketList[socketID];
            if (!socket) {
                continue;
            }
            socket.emitAgent("terminalExit", this.name, res.exitCode);
        }

        // Remove all clients
        this.socketList = {};

        this._exited = true;
        this.forgetSelf();
        log.debug("Terminal", "Terminal " + this.name + " exited with code " + res.exitCode);

        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        if (this.callback) {
            if (!this.executionError && (this.ending || res.signal)) {
                this.executionError = new OperationError("interrupted", "operationInterrupted", true);
            }
            this.callback(res.exitCode);
        }
    };

    public onExit(callback : (exitCode : number) => void) {
        this.callback = callback;
    }

    /**
     * Remove this terminal from the registry, but only when the entry is still this object.
     * A late shutdown must not delete the entry of a terminal that was opened again.
     */
    protected forgetSelf() {
        if (Terminal.terminalMap.get(this.key) === this) {
            Terminal.terminalMap.delete(this.key);
        }
    }

    public join(socket : DockgeSocket) {
        this.socketList[socket.id] = socket;
    }

    /**
     * Whether a client is currently attached to this terminal
     * @param socket Client socket
     * @returns True when the client joined this terminal
     */
    public hasClient(socket : DockgeSocket) : boolean {
        return this.socketList[socket.id] !== undefined;
    }

    public leave(socket : DockgeSocket) {
        delete this.socketList[socket.id];
    }

    /** Number of clients currently attached to this terminal */
    public get clientCount() : number {
        return Object.keys(this.socketList).length;
    }

    public get ptyProcess() {
        return this._ptyProcess;
    }

    public get name() {
        return this._name;
    }

    /**
     * Get the terminal output string
     */
    getBuffer() : string {
        return this.buffer.read();
    }

    close() {
        if (this.commandExecution) {
            this.executionError = new OperationError("interrupted", "operationInterrupted", true);
        }
        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);
        // Send Ctrl+C to the terminal
        this.ptyProcess?.write("\x03");
    }

    /**
     * Kill the local process of this terminal.
     * For a container shell this is the last resort: killing `docker exec` does not end the
     * process inside the container, so end() is the method to use for those.
     */
    kill() {
        if (this.commandExecution) {
            this.executionError = new OperationError("interrupted", "operationInterrupted", true);
        }
        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        try {
            this._ptyProcess?.kill();
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to kill terminal " + this.name + ": " + e.message);
            }
        }

        // Command executions remain locked until their exit is observed.
        if (!this.commandExecution || !this._ptyProcess) {
            this.forgetSelf();
        }
    }

    /**
     * End the session for good.
     *
     * A shell sitting at an idle prompt survives Ctrl+C, and killing `docker exec` leaves the
     * shell running inside the container. So the shell is asked to exit first, and only a
     * session that ignores that is killed.
     * @param graceMs How long the shell may take to exit on its own
     */
    async end(graceMs = 3000) : Promise<void> {
        // A second call must not start another shutdown of the same session
        if (this.ending) {
            return;
        }

        this.ending = true;
        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        // Interactive sessions allow a fresh reconnect during shutdown. A command
        // keeps its stack locked until the old process has actually exited.
        if (!this.commandExecution) {
            this.forgetSelf();
        }

        if (!this._ptyProcess) {
            return;
        }

        try {
            // Cancel whatever is on the prompt, then leave the shell, then send EOF
            this._ptyProcess.write("\x03");
            this._ptyProcess.write("exit\r");
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to ask terminal " + this.name + " to exit: " + e.message);
            }
        }

        const started = Date.now();
        let sentEOF = false;

        while (Date.now() - started < graceMs) {
            if (this.exited) {
                return;
            }

            // Halfway through, try EOF as well: a shell reading input takes it as a hangup
            if (!sentEOF && Date.now() - started > graceMs / 2) {
                sentEOF = true;
                try {
                    this._ptyProcess.write("\x04");
                } catch (e) {
                    // Nothing more to do, the kill below is the fallback
                }
            }

            await sleep(100);
        }

        log.debug("Terminal", "Terminal " + this.name + " did not exit on its own, killing it");
        this.kill();
    }

    /** Whether the process of this terminal already exited */
    public get exited() : boolean {
        return this._exited;
    }

    /**
     * Get a running and non-exited terminal
     * @param name Name the client uses
     * @param owner Owner, for a private session
     */
    public static getTerminal(name : string, owner? : TerminalOwner) : Terminal | undefined {
        return Terminal.terminalMap.get(Terminal.keyOf(name, owner));
    }

    /**
     * The terminal a client means by a name: its own private session, otherwise shared
     * output. A private session of somebody else is never returned, whatever the name.
     * @param socket Client socket
     * @param name Name the client uses
     */
    public static forClient(socket : DockgeSocket, name : string) : Terminal | undefined {
        return Terminal.getTerminal(name, terminalOwner(socket)) ?? Terminal.getTerminal(name);
    }

    public static getOrCreateTerminal(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) : Terminal {
        // Since exited terminal will be removed from the map, it is safe to get the terminal from the map
        let terminal = Terminal.getTerminal(name);
        if (!terminal) {
            terminal = new Terminal(server, name, file, args, cwd);
        }
        return terminal;
    }

    public static exec(server : DockgeServer, socket : DockgeSocket | undefined, terminalName : string, file : string, args : string | string[], cwd : string) : Promise<number> {
        return new Promise((resolve, reject) => {
            // check if terminal exists
            if (Terminal.getTerminal(terminalName)) {
                reject(new OperationError("busy", "operationBusy"));
                return;
            }

            let terminal = new Terminal(server, terminalName, file, args, cwd);
            terminal.commandExecution = true;
            terminal.rows = PROGRESS_TERMINAL_ROWS;

            if (socket) {
                terminal.join(socket);
            }

            terminal.onExit((exitCode : number) => {
                if (terminal.executionError) {
                    reject(terminal.executionError);
                } else {
                    resolve(exitCode);
                }
            });
            terminal.start();
        });
    }

    public static getTerminalCount() {
        return Terminal.terminalMap.size;
    }

    /**
     * End every session this process owns.
     *
     * Shells are asked to exit and killed if they will not, the same way a single session
     * ends. One session that will not go must not keep the others open, so the failures
     * are collected rather than thrown.
     * @param graceMs How long each shell may take to exit on its own
     */
    public static async endAll(graceMs = 3000) : Promise<void> {
        await Terminal.endWhere(() => true, graceMs);
    }

    /**
     * End the private sessions of an account, whose access just changed: cutting its
     * connections alone left its shells running
     * @param userID Account
     */
    public static async endOwnedBy(userID : string) : Promise<void> {
        await Terminal.endWhere((terminal) => terminal.owner?.user === userID);
    }

    /**
     * End the sessions that match, the way endAll ends every session
     * @param match Which sessions to end
     * @param graceMs How long each shell may take to exit on its own
     */
    public static async endWhere(match : (terminal : Terminal) => boolean, graceMs = 3000) : Promise<void> {
        const terminals = [ ...Terminal.terminalMap.values() ].filter(match);

        await Promise.all(terminals.map(async (terminal) => {
            try {
                await terminal.end(graceMs);
            } catch (e) {
                log.debug("Terminal", "Failed to end terminal " + terminal.name + ": " + (e instanceof Error ? e.message : String(e)));
            }
        }));
    }
}

/**
 * Interactive terminal
 * Mainly used for container exec
 */
export class InteractiveTerminal extends Terminal {
    public write(input : string) {
        this.ptyProcess?.write(input);
    }

    resetCWD() {
        const cwd = process.cwd();
        this.ptyProcess?.write(`cd "${cwd}"\r`);
    }
}

/**
 * User interactive terminal that use bash or powershell with limited commands such as docker, ls, cd, dir
 */
export class MainTerminal extends InteractiveTerminal {
    /** Name of the console; every user has their own session under it */
    static readonly NAME = "console";

    /** Setting the owner turns the console on with */
    static readonly SETTING = "consoleEnabled";

    /**
     * The console runs commands next to the Docker socket of the host, so it stays off
     * until the owner turns it on in the settings.
     * @returns Whether it may be opened
     */
    static async enabled() : Promise<boolean> {
        return await Settings.get(MainTerminal.SETTING) === true;
    }

    /**
     * The console session of this client, started on first use. Every user has their own,
     * and nothing else creates one, so no path skips the check.
     * @param server Server the console belongs to
     * @param socket Client that opens it
     * @returns The session
     */
    static async open(server : DockgeServer, socket : DockgeSocket) : Promise<Terminal> {
        if (!await MainTerminal.enabled()) {
            throw new Error("consoleOff");
        }

        const owner = terminalOwner(socket);
        let terminal = Terminal.getTerminal(MainTerminal.NAME, owner);
        if (!terminal) {
            terminal = new MainTerminal(server, MainTerminal.NAME, owner);
            terminal.rows = 50;
        }
        return terminal;
    }

    /**
     * End console sessions: turning the console off or narrowing it must not leave one open
     * @param keepUsers Accounts whose sessions stay, because they may still open the console
     */
    static async closeSessions(keepUsers : ReadonlySet<string> = new Set()) : Promise<void> {
        await Terminal.endWhere((terminal) => terminal instanceof MainTerminal && !keepUsers.has(terminal.owner?.user ?? ""));
    }

    private constructor(server : DockgeServer, name : string, owner : TerminalOwner) {
        let shell;

        if (os.platform() === "win32") {
            if (commandExistsSync("pwsh.exe")) {
                shell = "pwsh.exe";
            } else {
                shell = "powershell.exe";
            }
        } else {
            shell = "bash";
        }
        super(server, name, shell, [], server.stacksDir, owner);
    }

    public write(input : string) {
        super.write(input);
    }
}
