import { DockgeServer } from "./dockge-server";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import { LimitQueue } from "./utils/limit-queue";
import { sleep } from "../common/util-common";
import { DockgeSocket } from "./util-server";
import {
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_COLS,
    TERMINAL_ROWS
} from "../common/util-common";
import { log } from "./log";

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
 * Terminal for running commands, no user interaction
 */
export class Terminal {
    protected static terminalMap : Map<string, Terminal> = new Map();

    protected _ptyProcess? : pty.IPty;
    protected server : DockgeServer;
    protected buffer : LimitQueue<string> = new LimitQueue(100);
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

    constructor(server : DockgeServer, name : string, file : string, args : string | string[], cwd : string) {
        this.server = server;
        this._name = name;
        //this._name = "terminal-" + Date.now() + "-" + getCryptoRandomInt(0, 1000000);
        this.file = file;
        this.args = args;
        this.cwd = cwd;

        Terminal.terminalMap.set(this.name, this);
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
                const exitCode = Number(error.message.split(" ").pop());
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
        if (Terminal.terminalMap.get(this.name) === this) {
            Terminal.terminalMap.delete(this.name);
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
        if (this.buffer.length === 0) {
            return "";
        }
        return this.buffer.join("");
    }

    close() {
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
        clearInterval(this.keepAliveInterval);
        clearInterval(this.kickDisconnectedClientsInterval);

        try {
            this._ptyProcess?.kill();
        } catch (e) {
            if (e instanceof Error) {
                log.debug("Terminal", "Failed to kill terminal " + this.name + ": " + e.message);
            }
        }

        // The exit handler removes the entry as well, this covers a process that never started
        this.forgetSelf();
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

        // Taken out of the registry right away, so a client that reconnects during the
        // grace period gets a fresh session instead of one that is about to die
        this.forgetSelf();

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
     * @param name
     */
    public static getTerminal(name : string) : Terminal | undefined {
        return Terminal.terminalMap.get(name);
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
            if (Terminal.terminalMap.has(terminalName)) {
                reject("Another operation is already running, please try again later.");
                return;
            }

            let terminal = new Terminal(server, terminalName, file, args, cwd);
            terminal.rows = PROGRESS_TERMINAL_ROWS;

            if (socket) {
                terminal.join(socket);
            }

            terminal.onExit((exitCode : number) => {
                resolve(exitCode);
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
        const terminals = [ ...Terminal.terminalMap.values() ];

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
    constructor(server : DockgeServer, name : string) {
        let shell;

        // Throw an error if console is not enabled
        if (!server.config.enableConsole) {
            throw new Error("Console is not enabled.");
        }

        if (os.platform() === "win32") {
            if (commandExistsSync("pwsh.exe")) {
                shell = "pwsh.exe";
            } else {
                shell = "powershell.exe";
            }
        } else {
            shell = "bash";
        }
        super(server, name, shell, [], server.stacksDir);
    }

    public write(input : string) {
        super.write(input);
    }
}
