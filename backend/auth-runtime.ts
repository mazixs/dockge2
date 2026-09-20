import type { IncomingHttpHeaders } from "http";

/**
 * The layer everything about permissions stands on.
 *
 * The role vocabulary and the two operations the access rules need from the
 * authentication library live here, below both of them. Without this the rules import
 * the runtime and the runtime imports the rules, and the order in which the two modules
 * finish loading decides whether the server starts.
 */

/** What an account is allowed to do, in three steps */
export type UserRole = "admin" | "operator" | "viewer";

/**
 * Read a role as it came out of the database or off a socket.
 * @param role Value to read
 * @returns The role it names; an unknown value never grants privileges
 */
export function normalizeRole(role : unknown) : UserRole {
    return role === "admin" || role === "operator" ? role : "viewer";
}

/** Who a socket belongs to, decided from its handshake headers */
export interface SocketIdentity {
    /** Identifier of the account, absent when the client has to sign in */
    userID? : string;

    /** True when the client is signed in only because authentication is disabled */
    autoLogin? : boolean;

    /** Effective permissions read from the database */
    role? : UserRole;
}

/**
 * What the access rules use from the authentication library.
 *
 * Deliberately two operations and nothing else: hashing a password the way the library
 * stores it, and saying who a request comes from. Anything wider would put the whole
 * library back in front of the rules.
 */
export interface AuthRuntime {
    /**
     * Hash a password in the format the account table stores
     * @param password Plain password
     * @returns The stored form
     */
    hashPassword(password : string) : Promise<string>;

    /**
     * Decide who a request comes from
     * @param headers Headers of the request
     * @returns Identity of the client
     */
    identify(headers : IncomingHttpHeaders) : Promise<SocketIdentity>;
}

let runtime : AuthRuntime | undefined;

/**
 * Publish the running authentication, or take it away again.
 *
 * Called when the library is ready and when a test throws its instance away, so nothing
 * keeps working against a database that is already gone.
 * @param next The running authentication, or undefined to forget it
 * @returns {void}
 */
export function setAuthRuntime(next : AuthRuntime | undefined) : void {
    runtime = next;
}

/**
 * The running authentication
 * @returns The published runtime
 * @throws {Error} If authentication is not initialised yet
 */
export function getAuthRuntime() : AuthRuntime {
    if (!runtime) {
        throw new Error("Authentication is not initialised");
    }

    return runtime;
}
