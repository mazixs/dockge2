// Console colors. Only the ones the log actually prints are kept: the rest came
// from upstream, where they were never used either, and an unused export reads
// as an offer to use it.
// https://stackoverflow.com/questions/9781218/how-to-change-node-jss-console-font-color
import { intHash, isDev } from "../common/util-common";
import dayjs from "dayjs";

const CONSOLE_STYLE_Reset = "\x1b[0m";

const CONSOLE_STYLE_FgRed = "\x1b[31m";
const CONSOLE_STYLE_FgGreen = "\x1b[32m";
const CONSOLE_STYLE_FgYellow = "\x1b[33m";
const CONSOLE_STYLE_FgBlue = "\x1b[34m";
const CONSOLE_STYLE_FgMagenta = "\x1b[35m";
const CONSOLE_STYLE_FgCyan = "\x1b[36m";
const CONSOLE_STYLE_FgGray = "\x1b[90m";
const CONSOLE_STYLE_FgOrange = "\x1b[38;5;208m";
const CONSOLE_STYLE_FgLightGreen = "\x1b[38;5;119m";
const CONSOLE_STYLE_FgLightBlue = "\x1b[38;5;117m";
const CONSOLE_STYLE_FgViolet = "\x1b[38;5;141m";
const CONSOLE_STYLE_FgBrown = "\x1b[38;5;130m";
const CONSOLE_STYLE_FgPink = "\x1b[38;5;219m";

const consoleModuleColors = [
    CONSOLE_STYLE_FgCyan,
    CONSOLE_STYLE_FgGreen,
    CONSOLE_STYLE_FgLightGreen,
    CONSOLE_STYLE_FgBlue,
    CONSOLE_STYLE_FgLightBlue,
    CONSOLE_STYLE_FgMagenta,
    CONSOLE_STYLE_FgOrange,
    CONSOLE_STYLE_FgViolet,
    CONSOLE_STYLE_FgBrown,
    CONSOLE_STYLE_FgPink,
];

const consoleLevelColors : Record<string, string> = {
    "INFO": CONSOLE_STYLE_FgCyan,
    "WARN": CONSOLE_STYLE_FgYellow,
    "ERROR": CONSOLE_STYLE_FgRed,
    "DEBUG": CONSOLE_STYLE_FgGray,
};

class Logger {

    /**
     * DOCKGE_HIDE_LOG=debug_monitor,info_monitor
     *
     * Example:
     *  [
     *     "debug_monitor",          // Hide all logs that level is debug and the module is monitor
     *     "info_monitor",
     *  ]
     */
    hideLog : Record<string, string[]> = {
        info: [],
        warn: [],
        error: [],
        debug: [],
    };

    /**
     *
     */
    constructor() {
        if (typeof process !== "undefined" && process.env.DOCKGE_HIDE_LOG) {
            const list = process.env.DOCKGE_HIDE_LOG.split(",").map(v => v.toLowerCase());

            for (const pair of list) {
                // split first "_" only
                const values = pair.split(/_(.*)/s);

                const moduleName = values[0];
                const message = values[1];
                if (moduleName && message) {
                    this.hideLog[moduleName]?.push(message);
                }
            }

            this.debug("server", "DOCKGE_HIDE_LOG is set");
            this.debug("server", this.hideLog);
        }
    }

    /**
     * Write a message to the log
     * @param module The module the log comes from
     * @param msg Message to write
     * @param level Log level. One of INFO, WARN, ERROR, DEBUG or can be customized.
     */
    log(module: string, msg: unknown, level: string) {
        if (level === "DEBUG" && !isDev) {
            return;
        }

        if (this.hideLog[level]?.includes(module.toLowerCase())) {
            return;
        }

        module = module.toUpperCase();
        level = level.toUpperCase();

        let now;
        if (dayjs.tz) {
            now = dayjs.tz(new Date()).format();
        } else {
            now = dayjs().format();
        }

        const levelColor = consoleLevelColors[level];
        const moduleColor = consoleModuleColors[intHash(module, consoleModuleColors.length)];

        let timePart = CONSOLE_STYLE_FgCyan + now + CONSOLE_STYLE_Reset;
        const modulePart = "[" + moduleColor + module + CONSOLE_STYLE_Reset + "]";
        const levelPart = levelColor + `${level}:` + CONSOLE_STYLE_Reset;

        if (level === "INFO") {
            console.info(timePart, modulePart, levelPart, msg);
        } else if (level === "WARN") {
            console.warn(timePart, modulePart, levelPart, msg);
        } else if (level === "ERROR") {
            let msgPart : unknown;
            if (typeof msg === "string") {
                msgPart = CONSOLE_STYLE_FgRed + msg + CONSOLE_STYLE_Reset;
            } else {
                msgPart = msg;
            }
            console.error(timePart, modulePart, levelPart, msgPart);
        } else if (level === "DEBUG") {
            if (isDev) {
                timePart = CONSOLE_STYLE_FgGray + now + CONSOLE_STYLE_Reset;
                let msgPart : unknown;
                if (typeof msg === "string") {
                    msgPart = CONSOLE_STYLE_FgGray + msg + CONSOLE_STYLE_Reset;
                } else {
                    msgPart = msg;
                }
                console.debug(timePart, modulePart, levelPart, msgPart);
            }
        } else {
            console.log(timePart, modulePart, msg);
        }
    }

    /**
     * Log an INFO message
     * @param module Module log comes from
     * @param msg Message to write
     */
    info(module: string, msg: unknown) {
        this.log(module, msg, "info");
    }

    /**
     * Log a WARN message
     * @param module Module log comes from
     * @param msg Message to write
     */
    warn(module: string, msg: unknown) {
        this.log(module, msg, "warn");
    }

    /**
     * Log an ERROR message
     * @param module Module log comes from
     * @param msg Message to write
     */
    error(module: string, msg: unknown) {
        this.log(module, msg, "error");
    }

    /**
     * Log a DEBUG message
     * @param module Module log comes from
     * @param msg Message to write
     */
    debug(module: string, msg: unknown) {
        this.log(module, msg, "debug");
    }

    /**
     * Log an exception as an ERROR
     * @param module Module log comes from
     * @param exception The exception to include
     * @param msg The message to write
     */
    exception(module: string, exception: unknown, msg: unknown) {
        let finalMessage = exception;

        if (msg) {
            finalMessage = `${msg}: ${exception}`;
        }

        this.log(module, finalMessage, "error");
    }
}

export const log = new Logger();
