/*
 * Common utilities for backend and frontend
 */
import yaml, { Pair, isCollection, isNode, isPair, isScalar, type Node } from "yaml";
import type { DotenvParseOutput } from "dotenv";

// Init dayjs. The plugins are named with their extension because dayjs publishes no
// "exports" map: a bundler finds them either way, but Node resolving this package as
// the ES module it declares itself to be only finds the file that is actually there
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import relativeTime from "dayjs/plugin/relativeTime.js";
import { replaceVariablesSync } from "@inventage/envsubst";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);

export interface LooseObject {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any
}

export interface BaseRes {
    ok: boolean;
    msg?: string;
}

/**
 * How long a new stack name may be.
 *
 * The name becomes a directory and Compose repeats it in front of every container,
 * network and volume of the stack, so it is read far more often than it is typed. The
 * form and the server both use this one number: a form that accepts what the server
 * refuses is a rejection the user only meets after waiting for a clone.
 */
export const MAX_STACK_NAME_LENGTH = 64;

let randomBytes : (numBytes: number) => Uint8Array;
initRandomBytes();

async function initRandomBytes() {
    if (typeof window !== "undefined" && window.crypto) {
        randomBytes = function randomBytes(numBytes: number) {
            const bytes = new Uint8Array(numBytes);
            for (let i = 0; i < numBytes; i += 65536) {
                window.crypto.getRandomValues(bytes.subarray(i, i + Math.min(numBytes - i, 65536)));
            }
            return bytes;
        };
    } else {
        randomBytes = (await import("node:crypto")).randomBytes;
    }
}

export const ALL_ENDPOINTS = "##ALL_DOCKGE_ENDPOINTS##";

// Stack Status
export const UNKNOWN = 0;
export const CREATED_FILE = 1;
export const CREATED_STACK = 2;
export const RUNNING = 3;
export const EXITED = 4;
export const ATTENTION = 5;

/**
 * Состояние стека как имя токена состояния, а не как вариант Bootstrap.
 *
 * Синий в системе означает только интерактив, поэтому "работает" не может быть
 * `primary`: имена здесь совпадают с токенами `--state-*` из tokens.scss.
 * @param status Числовое состояние стека
 * @returns Имя состояния: running, attention, stopped, failed или unknown
 */
export function statusStateName(status : number) : string {
    switch (status) {
        case CREATED_FILE:
        case CREATED_STACK:
            return "stopped";
        case RUNNING:
            return "running";
        case EXITED:
            return "failed";
        case ATTENTION:
            return "attention";
        default:
            return "unknown";
    }
}

export const isDev = process.env.NODE_ENV === "development";
export const TERMINAL_COLS = 105;
export const TERMINAL_ROWS = 10;
export const PROGRESS_TERMINAL_ROWS = 8;

export const COMBINED_TERMINAL_COLS = 58;
export const COMBINED_TERMINAL_ROWS = 20;

export const ERROR_TYPE_VALIDATION = 1;

export const acceptedComposeFileNames = [
    "compose.yaml",
    "docker-compose.yaml",
    "docker-compose.yml",
    "compose.yml",
];

/**
 * Generate a decimal integer number from a string
 * @param str Input
 * @param length Default is 10 which means 0 - 9
 */
export function intHash(str : string, length = 10) : number {
    // A simple hashing function (you can use more complex hash functions if needed)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash += str.charCodeAt(i);
    }
    // Normalize the hash to the range [0, 10]
    return (hash % length + length) % length; // Ensure the result is non-negative
}

/**
 * Delays for specified number of seconds
 * @param ms Number of milliseconds to sleep for
 */
export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a random alphanumeric string of fixed length
 * @param length Length of string to generate
 * @returns string
 */
export function genSecret(length = 64) {
    let secret = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const charsLength = chars.length;
    for ( let i = 0; i < length; i++ ) {
        secret += chars.charAt(getCryptoRandomInt(0, charsLength - 1));
    }
    return secret;
}

/**
 * Get a random integer suitable for use in cryptography between upper
 * and lower bounds.
 * @param min Minimum value of integer
 * @param max Maximum value of integer
 * @returns Cryptographically suitable random integer
 */
export function getCryptoRandomInt(min: number, max: number):number {
    // synchronous version of: https://github.com/joepie91/node-random-number-csprng

    const range = max - min;
    if (range >= Math.pow(2, 32)) {
        console.log("Warning! Range is too large.");
    }

    let tmpRange = range;
    let bitsNeeded = 0;
    let bytesNeeded = 0;
    let mask = 1;

    while (tmpRange > 0) {
        if (bitsNeeded % 8 === 0) {
            bytesNeeded += 1;
        }
        bitsNeeded += 1;
        mask = mask << 1 | 1;
        tmpRange = tmpRange >>> 1;
    }

    const bytes = randomBytes(bytesNeeded);
    let randomValue = 0;

    for (let i = 0; i < bytesNeeded; i++) {
        randomValue |= (bytes[i] ?? 0) << 8 * i;
    }

    randomValue = randomValue & mask;

    if (randomValue <= range) {
        return min + randomValue;
    } else {
        return getCryptoRandomInt(min, max);
    }
}

export function getComposeTerminalName(endpoint : string, stack : string) {
    return "compose-" + endpoint + "-" + stack;
}

export function getCombinedTerminalName(endpoint : string, stack : string) {
    return "combined-" + endpoint + "-" + stack;
}

export function getContainerTerminalName(endpoint : string, container : string) {
    return "container-" + endpoint + "-" + container;
}

/** Shells a container terminal may start, an allow-list on purpose */
export const CONTAINER_SHELLS = [ "sh", "bash" ] as const;

export type ContainerShell = typeof CONTAINER_SHELLS[number];

/**
 * Check that a value is one of the allowed container shells
 * @param value Value to check
 * @returns True for an allowed shell
 */
export function isContainerShell(value : unknown) : value is ContainerShell {
    return typeof value === "string" && (CONTAINER_SHELLS as readonly string[]).includes(value);
}

/**
 * Name of a container exec terminal.
 * The shell is part of the identity, so switching between sh and bash starts a new
 * session instead of attaching to the PTY of the other shell.
 * @param endpoint Agent endpoint
 * @param stackName Stack name
 * @param container Service name
 * @param shell Shell of the session
 * @param index Session index for the same service
 * @returns Terminal name
 */
export function getContainerExecTerminalName(endpoint : string, stackName : string, container : string, shell : ContainerShell = "sh", index : number = 0) {
    return "container-exec-" + endpoint + "-" + stackName + "-" + container + "-" + shell + "-" + index;
}

/**
 * Possible Inputs:
 * ports:
 *   - "3000"
 *   - "3000-3005"
 *   - "8000:8000"
 *   - "9090-9091:8080-8081"
 *   - "49100:22"
 *   - "8000-9000:80"
 *   - "127.0.0.1:8001:8001"
 *   - "127.0.0.1:5000-5010:5000-5010"
 *   - "0.0.0.0:8080->8080/tcp"
 *   - "6060:6060/udp"
 * @param input
 * @param hostname
 */
export function parseDockerPort(input : string, hostname : string) {
    let port;
    let display;

    const parts = input.split("/");
    let part1 = parts[0] ?? "";
    let protocol = parts[1] || "tcp";

    // coming from docker ps, split host part
    const arrow = part1.indexOf("->");
    if (arrow >= 0) {
        part1 = part1.split("->")[0] ?? "";
        const colon = part1.indexOf(":");
        if (colon >= 0) {
            part1 = part1.split(":")[1] ?? "";
        }
    }

    // Split the last ":"
    const lastColon = part1.lastIndexOf(":");

    if (lastColon === -1) {
        // No colon, so it's just a port or port range
        // Check if it's a port range
        const dash = part1.indexOf("-");
        if (dash === -1) {
            // No dash, so it's just a port
            port = part1;
        } else {
            // Has dash, so it's a port range, use the first port
            port = part1.substring(0, dash);
        }

        display = part1;

    } else {
        // Has colon, so it's a port mapping
        let hostPart = part1.substring(0, lastColon);
        display = hostPart;

        // Check if it's a port range
        const dash = part1.indexOf("-");

        if (dash !== -1) {
            // Has dash, so it's a port range, use the first port
            hostPart = part1.substring(0, dash);
        }

        // Check if it has a ip (ip:port)
        const colon = hostPart.indexOf(":");

        if (colon !== -1) {
            // Has colon, so it's a ip:port
            hostname = hostPart.substring(0, colon);
            port = hostPart.substring(colon + 1);
        } else {
            // No colon, so it's just a port
            port = hostPart;
        }
    }

    const portInt = parseInt(port, 10);

    if (portInt == 443) {
        protocol = "https";
    } else if (protocol === "tcp") {
        protocol = "http";
    }

    return {
        url: protocol + "://" + hostname + ":" + portInt,
        display: display,
    };
}

export function envsubst(string : string, variables : LooseObject) : string {
    return replaceVariablesSync(string, variables)[0];
}

/**
 * Traverse all values in the yaml and for each value, if there are template variables, replace it environment variables
 * Emulates the behavior of how docker-compose handles environment variables in yaml files
 * @param content Yaml string
 * @param env Environment variables
 * @returns string Yaml string with environment variables replaced
 */
export function envsubstYAML(content : string, env : DotenvParseOutput) : string {
    const doc = yaml.parseDocument(content);
    if (doc.contents && isNode(doc.contents)) {
        traverseYAML(doc.contents, env);
    }
    return doc.toString();
}

/**
 * Used for envsubstYAML(...)
 * @param pair
 * @param env
 */
function traverseYAML(node : Node | Pair, env : DotenvParseOutput) : void {
    if (isPair(node)) {
        if (node.value && isNode(node.value)) {
            traverseYAML(node.value, env);
        }
        return;
    }

    if (isCollection(node)) {
        for (const item of node.items) {
            if (isPair(item) || isNode(item)) {
                traverseYAML(item, env);
            }
        }
        return;
    }

    if (isScalar(node) && typeof node.value === "string") {
        node.value = envsubst(node.value, env);
    }
}
