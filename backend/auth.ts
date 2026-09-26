import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { fromNodeHeaders } from "better-auth/node";
import { twoFactor, username } from "better-auth/plugins";
import { accessPlugin, initializeAccess } from "./auth-access";
import { normalizeRole, setAuthRuntime, type SocketIdentity } from "./auth-runtime";
import type { IncomingHttpHeaders } from "http";
import { Database as DockgeDatabase } from "./database";
import { log } from "./log";
import { Settings } from "./settings";
import { genSecret } from "../common/util-common";
import type { DockgeServer } from "./dockge-server";

/** Where the auth endpoints live, the frontend client uses the same path */
export const AUTH_BASE_PATH = "/api/auth";

/** Sessions last a week, the cookie is refreshed while the user keeps working */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

let instance : Auth | undefined;

/**
 * Read the auth secret, generating and storing one on first start.
 * The secret signs session cookies, so it has to survive a restart.
 * @returns Secret string
 */
async function resolveSecret() : Promise<string> {
    if (process.env.DOCKGE_AUTH_SECRET) {
        return process.env.DOCKGE_AUTH_SECRET;
    }

    const stored = await Settings.get("authSecret");

    if (typeof stored === "string" && stored.length >= 32) {
        return stored;
    }

    const secret = genSecret(64);
    await Settings.set("authSecret", secret, "internal");
    log.info("auth", "Generated a new auth secret and stored it in the database");

    return secret;
}

/**
 * Whether session cookies carry the `Secure` flag.
 *
 * Dockge often runs behind a proxy that terminates TLS, so the server itself speaks
 * plain HTTP while the browser speaks HTTPS. In that setup the flag has to be forced
 * with `DOCKGE_SECURE_COOKIES=true`, otherwise the cookie would also travel over an
 * accidental plain HTTP request.
 * @param server Dockge server
 * @returns Whether to mark cookies as secure
 */
function resolveSecureCookies(server : DockgeServer) : boolean {
    const configured = (process.env.DOCKGE_SECURE_COOKIES ?? "").trim().toLowerCase();

    if (configured === "true" || configured === "1") {
        return true;
    }

    if (configured === "false" || configured === "0") {
        return false;
    }

    return Boolean(server.isSSL()) || Boolean(process.env.DOCKGE_PUBLIC_URL && new URL(process.env.DOCKGE_PUBLIC_URL).protocol === "https:");
}

/** Header our own middleware fills with the address the connection really came from */
export const CLIENT_IP_HEADER = "x-dockge-client-ip";

/**
 * Whether headers of a reverse proxy may be believed.
 * Without a proxy in front, those headers come straight from the client and must not
 * decide anything, so this stays off unless the operator turns it on.
 * @returns Whether `X-Forwarded-*` is trusted
 */
export function trustsProxyHeaders() : boolean {
    const configured = (process.env.DOCKGE_TRUST_PROXY ?? "").trim().toLowerCase();
    return configured === "true" || configured === "1";
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
export function resolveRequestAddress(request : { headers : Record<string, string | string[] | undefined>; socket : { remoteAddress? : string | undefined } }) : string {
    if (trustsProxyHeaders()) {
        const forwardedFor = [ request.headers["x-forwarded-for"] ].flat()[0];
        const realIP = [ request.headers["x-real-ip"] ].flat()[0];
        const forwarded = forwardedFor?.split(",")[0]?.trim() || realIP?.trim();

        if (forwarded) {
            return forwarded;
        }
    }

    return (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "") || "unknown";
}

/** What a request tells about the address the browser used */
export interface RequestOrigins {
    /** `Host` header, the address the browser actually asked for */
    host? : string | undefined;

    /** `X-Forwarded-Host`, only meaningful behind a trusted proxy */
    forwardedHost? : string | undefined;

    /** `X-Forwarded-Proto` of that same proxy */
    forwardedProto? : string | undefined;
}

/**
 * Origins the browser may call the auth endpoints from.
 *
 * A self hosted panel has no fixed public address: people reach it by LAN address, by
 * container name, or through a domain on a proxy. The origin of the request is therefore
 * accepted when it matches the host the browser itself asked for, which is the ordinary
 * same origin rule - a page on another site sends its own origin and does not match.
 * Everything else has to be listed in `DOCKGE_TRUSTED_ORIGINS`.
 * @param server Dockge server
 * @param request What the current request says about the address used, if there is one
 * @returns Trusted origin list
 */
export function resolveTrustedOrigins(server : DockgeServer, request : RequestOrigins = {}) : string[] {
    const origins = new Set<string>();
    if (process.env.DOCKGE_PUBLIC_URL) {
        origins.add(new URL(process.env.DOCKGE_PUBLIC_URL).origin);
    }

    for (const origin of (process.env.DOCKGE_TRUSTED_ORIGINS ?? "").split(",")) {
        if (origin.trim() !== "") {
            origins.add(origin.trim());
        }
    }

    if (process.env.NODE_ENV === "development") {
        // The Vite dev server runs on its own port
        origins.add("http://localhost:5000");
        origins.add("http://127.0.0.1:5000");
    }

    const scheme = server.isSSL() ? "https" : "http";
    const host = server.config.hostname || "localhost";
    origins.add(`${scheme}://${host}:${server.config.port}`);

    if (request.host) {
        // The scheme is not in the Host header, and a proxy may have terminated TLS
        origins.add(`http://${request.host}`);
        origins.add(`https://${request.host}`);
    }

    if (trustsProxyHeaders() && request.forwardedHost) {
        const forwardedScheme = request.forwardedProto?.split(",")[0]?.trim() || "https";
        origins.add(`${forwardedScheme}://${request.forwardedHost}`);
    }

    return [ ...origins ];
}

/**
 * Read what a fetch style request says about the address the browser used
 * @param request Request handed to the auth handler
 * @returns Origin hints of that request
 */
function requestOrigins(request? : Request) : RequestOrigins {
    if (!request) {
        return {};
    }

    // A fetch style request carries no Host header: the address the browser asked for
    // ends up in the URL, which the Node adapter builds from that very header
    let host = request.headers.get("host") ?? undefined;

    if (!host) {
        try {
            host = new URL(request.url).host;
        } catch {
            host = undefined;
        }
    }

    return {
        host,
        forwardedHost: request.headers.get("x-forwarded-host") ?? undefined,
        forwardedProto: request.headers.get("x-forwarded-proto") ?? undefined,
    };
}

/**
 * Number of accounts that exist.
 * Setup creates the first owner; later accounts are issued by an owner.
 * Public signup stays disabled, including before setup.
 * @returns Account count
 */
export async function countUsers() : Promise<number> {
    const row = await DockgeDatabase.getKnex()("user").count("id as count").first();
    return Number(row?.count ?? 0);
}

/**
 * Build the auth instance and apply its database schema.
 * Called once, after the Dockge database is connected.
 * @param server Dockge server
 * @returns Auth instance
 */
export async function initAuth(server : DockgeServer) : Promise<Auth> {
    if (process.env.DOCKGE_PUBLIC_URL) {
        const publicURL = new URL(process.env.DOCKGE_PUBLIC_URL);
        if (![ "http:", "https:" ].includes(publicURL.protocol) || publicURL.username || publicURL.password || publicURL.pathname !== "/" || publicURL.search || publicURL.hash) {
            throw new Error("DOCKGE_PUBLIC_URL must be an HTTP(S) origin without credentials or a path");
        }
        if (publicURL.protocol === "https:" && /^(false|0)$/i.test((process.env.DOCKGE_SECURE_COOKIES ?? "").trim())) {
            throw new Error("HTTPS public URL requires secure cookies");
        }
    }
    const secret = await resolveSecret();
    const auth = buildAuth(server, secret);

    const hadRoles = await DockgeDatabase.getKnex().schema.hasColumn("user", "role");
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();

    instance = auth;
    // The access rules reach the library through this port and never import it back
    setAuthRuntime({
        hashPassword: async (password) => (await auth.$context).password.hash(password),
        identify: resolveSocketIdentity,
    });
    await initializeAccess(server.config.dataDir, hadRoles);

    // The auth connection opens its own write ahead log, which holds the same pages
    DockgeDatabase.restrictSQLiteAccess();

    log.info("auth", "Authentication is ready");

    return auth;
}

/**
 * Build the auth instance.
 * Kept separate so its exact type can be derived, because betterAuth() is generic
 * over the options that are passed in.
 * @param server Dockge server
 * @param secret Secret that signs session cookies
 * @returns Auth instance
 */
function buildAuth(server : DockgeServer, secret : string) {
    // A second connection to the same SQLite file: the database runs in WAL mode,
    // and better-auth needs its own driver instance for its Kysely dialect
    const authDatabase = new Database(DockgeDatabase.sqlitePath);
    authDatabase.pragma("journal_mode = WAL");

    return betterAuth({
        appName: "Dockge",
        database: authDatabase,
        secret,
        basePath: AUTH_BASE_PATH,
        baseURL: process.env.DOCKGE_PUBLIC_URL || server.getBaseURL(),
        trustedOrigins: (request) => resolveTrustedOrigins(server, requestOrigins(request)),
        emailAndPassword: {
            enabled: true,
            disableSignUp: true,
            minPasswordLength: 10,
            // Nothing sends mail from a self hosted panel
            requireEmailVerification: false,
            autoSignIn: true,
        },
        user: {
            additionalFields: {
                role: { type: "string",
                    defaultValue: "viewer",
                    input: false },
                suspended: { type: "boolean",
                    defaultValue: false,
                    input: false },
            },
        },
        session: {
            expiresIn: SESSION_EXPIRES_IN_SECONDS,
            updateAge: SESSION_UPDATE_AGE_SECONDS,
        },
        advanced: {
            useSecureCookies: resolveSecureCookies(server),
            defaultCookieAttributes: {
                httpOnly: true,
                sameSite: "lax",
            },
            // Only the address our own middleware wrote is believed. The library would
            // otherwise read `X-Forwarded-For` from the client itself, which lets a
            // caller invent a new rate limit bucket per attempt, or exhaust the bucket
            // of everybody else by leaving the header out.
            ipAddress: {
                ipAddressHeaders: [ CLIENT_IP_HEADER ],
            },
            trustedProxyHeaders: trustsProxyHeaders(),
        },
        rateLimit: {
            enabled: true,
            window: 60,
            max: 60,
            customRules: {
                // Guessing a password has to stay expensive
                // Ten a minute per client address: still hopeless for guessing a password
                // of the required length, and it leaves room for a person who mistypes
                "/sign-in/email": { window: 60,
                    max: 10 },
                "/sign-in/username": { window: 60,
                    max: 10 },
                "/bootstrap": { window: 60,
                    max: 3 },
                "/sign-up/email": { window: 60,
                    max: 3 },
                "/two-factor/verify-totp": { window: 60,
                    max: 5 },
                // Reading one's own session guesses nothing: the cookie is the secret, and the
                // socket handshake does the same lookup unlimited. Limited, it locked everyone
                // behind one address, such as a proxy without DOCKGE_TRUST_PROXY, out of the page
                "/get-session": false,
            },
        },
        databaseHooks: {
            session: {
                create: {
                    before: async (session) => {
                        const user = await DockgeDatabase.getKnex()("user").where("id", session.userId).first();
                        return user && !user.suspended ? undefined : false;
                    },
                },
            },
        },
        plugins: [
            accessPlugin(),
            username(),
            twoFactor({
                issuer: "Dockge",
            }),
        ],

    });
}

export type Auth = ReturnType<typeof buildAuth>;

/**
 * The auth instance, once initAuth() has run
 * @returns Auth instance
 * @throws {Error} If authentication is not initialised yet
 */
export function getAuth() : Auth {
    if (!instance) {
        throw new Error("Authentication is not initialised");
    }

    return instance;
}

/**
 * Forget the auth instance.
 * Used by the tests, so a fixture cannot keep working against a database that the
 * previous fixture already deleted.
 * @returns {void}
 */
export function resetAuth() {
    instance = undefined;
    setAuthRuntime(undefined);
}

/**
 * Resolve the session of a raw Node request, used by Express routes and by the
 * Socket.IO handshake. The cookie is verified by better-auth, never trusted as is.
 * @param headers Incoming request headers
 * @returns Session and user, or null when there is none
 */
export async function getSessionFromHeaders(headers : IncomingHttpHeaders) {
    try {
        return await getAuth().api.getSession({
            headers: fromNodeHeaders(headers),
        });
    } catch (e) {
        if (e instanceof Error) {
            log.debug("auth", "Cannot read the session: " + e.message);
        }
        return null;
    }
}

/**
 * Decide who a socket belongs to.
 *
 * A valid session cookie wins. Without one, an instance that deliberately disabled
 * authentication acts as an active owner account, which is how a reverse proxy setup works.
 * Everything else stays anonymous and has to sign in.
 * @param headers Headers of the handshake request
 * @returns Identity of the client
 */
export async function resolveSocketIdentity(headers : IncomingHttpHeaders) : Promise<SocketIdentity> {
    const session = await getSessionFromHeaders(headers);

    if (session?.user) {
        const user = await DockgeDatabase.getKnex()("user").where("id", session.user.id).first();
        if (user && !user.suspended) {
            return { userID: user.id,
                role: normalizeRole(user.role) };
        }
        return {};
    }

    if (await Settings.get("disableAuth")) {
        const user = await DockgeDatabase.getKnex()("user").where({ role: "admin",
            suspended: 0 }).first();

        if (user) {
            return {
                userID: user.id,
                autoLogin: true,
                role: "admin",
            };
        }
    }

    return {};
}

/**
 * Check the password of an account without a session.
 *
 * An instance that runs with authentication disabled has no session cookie, so the
 * ordinary verify endpoint has nothing to work with, and the actions that ask for a
 * password (revealing or writing a secret) would be impossible there.
 * @param userID Account whose password is checked
 * @param password Password the client offered
 * @returns Whether the password belongs to that account
 */
export async function verifyAccountPassword(userID : string, password : string) : Promise<boolean> {
    const context = await getAuth().$context;
    const accounts = await context.internalAdapter.findAccounts(userID);
    const credential = accounts.find((account) => account.providerId === "credential" && account.password);

    if (!credential?.password) {
        return false;
    }

    return context.password.verify({
        password,
        hash: credential.password,
    });
}
