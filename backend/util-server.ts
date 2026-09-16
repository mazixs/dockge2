import { Socket } from "socket.io";
import { Terminal } from "./terminal";
import { log } from "./log";
import { ERROR_TYPE_VALIDATION } from "../common/util-common";
import fs from "fs";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth, getSessionFromHeaders, resolveSocketIdentity, verifyAccountPassword } from "./auth";
import { AgentManager } from "./agent-manager";

export interface DockgeSocket extends Socket {
    /** Identifier of the signed in user, empty when the socket has no session */
    userID: string;
    userRole? : import("./auth-access").UserRole;
    consoleTerminal? : Terminal;
    instanceManager : AgentManager;
    endpoint : string;
    emitAgent : (eventName : string, ...args : unknown[]) => void;
}

// For command line arguments, so they are nullable
export interface Arguments {
    sslKey? : string | undefined;
    sslCert? : string | undefined;
    sslKeyPassphrase? : string | undefined;
    port? : number | undefined;
    hostname? : string | undefined;
    dataDir? : string | undefined;
    stacksDir? : string | undefined;
    enableConsole? : boolean | undefined;
}

// Some config values are required
export interface Config extends Arguments {
    dataDir : string;
    stacksDir : string;
    port : number;
    enableConsole : boolean;
}

export function checkLogin(socket : DockgeSocket) {
    if (!socket.userID) {
        throw new Error("You are not logged in.");
    }
}

export class ValidationError extends Error {
    constructor(message : string) {
        super(message);
    }
}

export function callbackError(error : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }

    if (error instanceof ValidationError) {
        callback({
            ok: false,
            type: ERROR_TYPE_VALIDATION,
            msg: error.message,
            msgi18n: true,
        });
    } else if (error instanceof Error) {
        callback({
            ok: false,
            msg: error.message,
            msgi18n: true,
        });
    } else {
        log.debug("console", "Unknown error: " + error);
    }
}

export function callbackResult(result : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }
    callback(result);
}

/** How many wrong passwords a client may offer before it has to wait */
const PASSWORD_ATTEMPT_LIMIT = 5;

/**
 * How long the wait lasts.
 * Kept short on purpose: the panel has a single account, so a long lock would let a
 * client with a stolen session keep the owner from confirming anything at all, while a
 * minute is already enough to make guessing hopeless.
 */
const PASSWORD_LOCK_MS = 60 * 1000;

/** Failed confirmations per client, so the socket cannot be used to guess the password */
const passwordAttempts = new Map<string, { failures : number, until : number }>();

/**
 * Key a client is counted under.
 * The user identifier is used when it is known, so opening new sockets does not reset
 * the counter, and the socket id covers the anonymous case.
 * @param socket Client socket
 * @returns Key of the counter
 */
function passwordAttemptKey(socket : DockgeSocket) : string {
    return socket.userID ? `user:${socket.userID}` : `socket:${socket.id}`;
}

/**
 * Forget the failures of a client, used after a correct password and by the tests
 * @param socket Client socket
 * @returns {void}
 */
export function clearPasswordAttempts(socket : DockgeSocket) {
    passwordAttempts.delete(passwordAttemptKey(socket));
}

/**
 * Confirm a dangerous action with the password of the account behind this socket.
 *
 * The auth endpoints have their own rate limit, but this path calls the API directly,
 * so guessing is counted here as well: without it a stolen session could try passwords
 * as fast as the socket allows and then reveal secrets or turn authentication off.
 * @param socket Client socket
 * @param currentPassword Password the client offered
 * @returns {Promise<void>}
 */
export async function doubleCheckPassword(socket : DockgeSocket, currentPassword : unknown) {
    if (typeof currentPassword !== "string") {
        throw new ValidationError("Wrong data type?");
    }

    const key = passwordAttemptKey(socket);
    const record = passwordAttempts.get(key);
    const now = Date.now();

    if (record && record.until > now && record.failures >= PASSWORD_ATTEMPT_LIMIT) {
        throw new ValidationError("tooManyPasswordAttempts");
    }

    if (record && record.until <= now) {
        passwordAttempts.delete(key);
    }

    if (!await verifyCurrentPassword(socket, currentPassword)) {
        const failures = (passwordAttempts.get(key)?.failures ?? 0) + 1;
        passwordAttempts.set(key, {
            failures,
            until: now + PASSWORD_LOCK_MS,
        });

        if (failures >= PASSWORD_ATTEMPT_LIMIT) {
            log.warn("auth", `Too many wrong password confirmations from ${key}, locked for ${PASSWORD_LOCK_MS / 1000} seconds`);
        }

        throw new ValidationError("Incorrect current password");
    }

    passwordAttempts.delete(key);
}

/**
 * Check the password of the client behind this socket.
 *
 * With a session, better-auth verifies against the account of that session, so a client
 * cannot confirm an action for somebody else. An instance with authentication disabled
 * has no session at all, and there the password of the account the socket acts as is
 * checked directly, otherwise secrets could never be read on such a deployment.
 * @param socket Client socket
 * @param currentPassword Password the client offered
 * @returns Whether the password was correct
 */
async function verifyCurrentPassword(socket : DockgeSocket, currentPassword : string) : Promise<boolean> {
    const session = await getSessionFromHeaders(socket.request.headers);

    if (session?.user) {
        const response = await getAuth().api.verifyPassword({
            body: { password: currentPassword },
            headers: fromNodeHeaders(socket.request.headers),
            asResponse: true,
        });

        return response.ok;
    }

    if (socket.userID) {
        return verifyAccountPassword(socket.userID, currentPassword);
    }

    return false;
}

/**
 * Disconnect the clients whose session no longer exists.
 *
 * A socket is identified once, during its handshake, so signing out elsewhere, changing
 * the password or revoking a session would otherwise leave an already open socket with
 * full access until the browser reconnects on its own.
 * @param sockets Connected sockets
 * @returns Number of clients that were dropped
 */
export async function dropRevokedSessions(sockets : Iterable<DockgeSocket>) : Promise<number> {
    let dropped = 0;

    for (const socket of sockets) {
        if (!socket.userID) {
            continue;
        }

        const identity = await resolveSocketIdentity(socket.request.headers);

        if (identity.userID === socket.userID && (!socket.userRole || identity.role === socket.userRole)) {
            continue;
        }

        log.info("auth", "The session of a connected client is gone, disconnecting it");
        clearPasswordAttempts(socket);

        try {
            socket.instanceManager?.disconnectAll();
            socket.emit("needAuth");
            socket.disconnect();
        } catch (e) {
            log.debug("auth", `Could not disconnect a client with a revoked session: ${e}`);
        }

        dropped += 1;
    }

    return dropped;
}

export function fileExists(file : string) {
    return fs.promises.access(file, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
}
