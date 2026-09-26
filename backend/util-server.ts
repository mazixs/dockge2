import { OperationError } from "./operation-error";
import { Socket } from "socket.io";
import { Terminal } from "./terminal";
import { log } from "./log";
import { ERROR_TYPE_VALIDATION } from "../common/util-common";
import fs from "fs";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth, getSessionFromHeaders, resolveSocketIdentity, verifyAccountPassword } from "./auth";
import { AgentManager } from "./agent-manager";
import type { AgentBroadcastArgs, AgentBroadcastName } from "../common/agent-events";

export interface DockgeSocket extends Socket {
    /** Identifier of the signed in user, empty when the socket has no session */
    userID: string;
    userRole? : import("./auth-runtime").UserRole;
    consoleTerminal? : Terminal;
    instanceManager : AgentManager;
    endpoint : string;
    /**
     * Tell the browser something without being asked.
     *
     * The name and the arguments come from the broadcast contract, so a message this
     * build does not send, or one sent with the wrong arguments, does not compile.
     */
    emitAgent : <E extends AgentBroadcastName>(eventName : E, ...args : AgentBroadcastArgs<E>) => void;
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
}

// Some config values are required
export interface Config extends Arguments {
    dataDir : string;
    stacksDir : string;
    port : number;
}

export function checkLogin(socket : DockgeSocket) {
    if (!socket.userID) {
        throw new Error("notLoggedIn");
    }
}

export class ValidationError extends Error {
    /** Values the catalogue entry interpolates, when it takes any. */
    readonly values? : Record<string, string>;

    /**
     * @param key Catalogue key describing what is wrong with the request
     * @param values Values the entry interpolates
     */
    constructor(key : string, values? : Record<string, string>) {
        super(key);
        if (values) {
            this.values = values;
        }
    }
}

/**
 * The message an error sends to the browser: a catalogue key, with values when it has them.
 * @param error Error being reported
 * @returns Key alone, or key and values for the catalogue entry to interpolate
 */
function errorMessage(error : Error) : string | { key : string, values : Record<string, string> } {
    const values = (error as { values? : unknown }).values;
    if (values && typeof values === "object") {
        return { key: error.message,
            values: values as Record<string, string> };
    }
    return error.message;
}

export function callbackError(error : unknown, callback : unknown) {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }

    if (error instanceof OperationError) {
        callback({ ok: false,
            code: error.code,
            unknown: error.unknown,
            msg: error.message,
            msgi18n: true });
    } else if (error instanceof ValidationError) {
        callback({
            ok: false,
            type: ERROR_TYPE_VALIDATION,
            msg: errorMessage(error),
            msgi18n: true,
        });
    } else if (error instanceof Error) {
        callback({
            ok: false,
            msg: errorMessage(error),
            msgi18n: true,
        });
    } else {
        log.debug("console", "Unknown error: " + error);
        callback({ ok: false,
            msg: "operationUnexpectedError",
            msgi18n: true });
    }
}

/**
 * What an acknowledgement expects to be answered with.
 *
 * An acknowledgement that came off the socket untyped answers `unknown`, so a handler
 * that has not been brought under the event contract yet still compiles.
 * @template C Type of the acknowledgement
 */
type ResponseOf<C> = C extends (response : infer R) => void ? R : unknown;

/**
 * Answer a request.
 *
 * The shape of the answer comes from the acknowledgement, so it is checked against the
 * event contract rather than against itself: a renamed or forgotten field of the payload
 * does not compile.
 * @param result What to answer with
 * @param callback Acknowledgement of the request
 * @returns Nothing: a caller that sent no acknowledgement is only logged
 */
export function callbackResult<C>(result : ResponseOf<C>, callback : C) : void {
    if (typeof(callback) !== "function") {
        log.error("console", "Callback is not a function");
        return;
    }
    callback(result);
}

/**
 * A packet middleware that checks packets side by side and admits them in the order they
 * arrived. A check takes a varying number of turns of the event loop, and a packet let
 * through as soon as its own check finished overtook the one before it: in a terminal, a
 * key typed second reached the shell first.
 * @param check Settles when the packet may pass, rejects with the reason it may not
 * @param deny Tells the client why its packet did not pass
 * @returns Middleware for `socket.use`
 */
export function admitInOrder<P>(check : (packet : P) => Promise<void>, deny : (packet : P, error : unknown) => void) : (packet : P, next : () => void) => void {
    let admitted : Promise<void> = Promise.resolve();

    return (packet, next) => {
        // Settled at once, so a refusal waiting for its turn is not an unhandled rejection
        const outcome = Promise.resolve().then(() => check(packet)).then(() => null, (error : unknown) => ({ error }));
        admitted = admitted.then(() => outcome).then((refused) => {
            if (refused) {
                deny(packet, refused.error);
            } else {
                next();
            }
        }).catch((error) => log.error("server", String(error)));
    };
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

        throw new ValidationError("incorrectCurrentPassword");
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
