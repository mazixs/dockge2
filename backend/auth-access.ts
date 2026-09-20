import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalAccountIssuer } from "better-auth/db";
import { APIError, createAuthEndpoint, formCsrfMiddleware, originCheckMiddleware } from "better-auth/api";
import { Database } from "./database";
import { getAuthRuntime, type UserRole } from "./auth-runtime";
import type { DockgeSocket } from "./util-server";
import type { StackSummaryDTO, ViewerStackSummary } from "../common/types/stack";

let bootstrapPath = "";

/** Preserve the existing owner and prepare a local, one-use setup credential. */
export async function initializeAccess(dataDir : string, hadRoles : boolean) {
    const knex = Database.getKnex();
    if (!hadRoles) {
        // The previous version permitted exactly one account. Sessions are untouched.
        await knex("user").update({ role: "admin" });
    }
    if (!await knex.schema.hasTable("auth_bootstrap")) {
        await knex.schema.createTable("auth_bootstrap", (table) => {
            table.integer("id").primary();
            table.string("userId").notNullable();
        });
    }
    bootstrapPath = path.join(dataDir, "bootstrap-token");
    if (await knex("user").first()) {
        await unlink(bootstrapPath).catch(() => undefined);
        return;
    }
    if (process.env.DOCKGE_BOOTSTRAP_TOKEN) {
        if (process.env.DOCKGE_BOOTSTRAP_TOKEN.length < 32) {
            throw new Error("DOCKGE_BOOTSTRAP_TOKEN must contain at least 32 characters");
        }
        return;
    }
    try {
        await writeFile(bootstrapPath, randomBytes(32).toString("hex") + "\n", { mode: 0o600,
            flag: "wx" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    }
    await chmod(bootstrapPath, 0o600);
}

export interface NewUser {
    name : string;
    email : string;
    username : string;
    password : string;
    role : UserRole;
}

/** Validate owner-issued credentials consistently for setup and later accounts. */
export function validateNewUser(data : unknown) : NewUser {
    const input = data as Partial<NewUser> | null;
    if (!input || typeof input.username !== "string" || !/^[a-zA-Z0-9_.]{3,30}$/.test(input.username)) {
        throw new Error("authInvalidUsername");
    }
    if (typeof input.email !== "string" || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
        throw new Error("authInvalidEmail");
    }
    if (typeof input.password !== "string" || input.password.length < 10 || input.password.length > 128) {
        throw new Error("authPasswordLength");
    }
    if (![ "admin", "operator", "viewer" ].includes(input.role ?? "")) {
        throw new Error("authInvalidRole");
    }
    return {
        name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 100) : input.username,
        username: input.username.toLowerCase(),
        email: input.email.toLowerCase(),
        password: input.password,
        role: input.role as UserRole,
    };
}

/** Issue a credential account atomically using better-auth's password format. */
export async function issueUser(input : unknown, bootstrap = false) {
    const data = validateNewUser(input);
    const password = await getAuthRuntime().hashPassword(data.password);
    const id = randomUUID();
    const now = Date.now();
    await Database.getKnex().transaction(async (trx) => {
        if (bootstrap) {
            // The UNIQUE primary key is claimed in the same transaction as both rows.
            // Concurrent processes cannot both become the first owner.
            await trx("auth_bootstrap").insert({ id: 1,
                userId: id });
            if (await trx("user").first()) {
                throw new Error("authSetupComplete");
            }
        }
        await trx("user").insert({ id,
            name: data.name,
            username: data.username,
            displayUsername: data.username,
            email: data.email,
            emailVerified: 0,
            createdAt: now,
            updatedAt: now,
            role: data.role,
            suspended: 0,
            twoFactorEnabled: 0 });
        await trx("account").insert({ id: randomUUID(),
            accountId: id,
            providerId: "credential",
            issuer: createLocalAccountIssuer("credential"),
            userId: id,
            password,
            createdAt: now,
            updatedAt: now });
    });
    return { id,
        name: data.name,
        username: data.username,
        email: data.email,
        role: data.role };
}

/** Setup shares better-auth's origin, JSON and request rate protections. */
export function accessPlugin() {
    return {
        id: "dockge-access",
        endpoints: {
            bootstrap: createAuthEndpoint("/bootstrap", { method: "POST",
                use: [ formCsrfMiddleware, originCheckMiddleware ] }, async (ctx) => {
                if (await Database.getKnex()("user").first()) {
                    throw new APIError("FORBIDDEN", { code: "SETUP_COMPLETE",
                        message: "authSetupComplete" });
                }
                const body = ctx.body as Record<string, unknown> | undefined;
                const expected = process.env.DOCKGE_BOOTSTRAP_TOKEN || await readFile(bootstrapPath, "utf8").catch(() => "");
                const token = typeof body?.token === "string" ? body.token.trim() : "";
                const secret = expected.trim();
                if (!secret || Buffer.byteLength(token) !== Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
                    throw new APIError("FORBIDDEN", { code: "INVALID_BOOTSTRAP_TOKEN",
                        message: "authInvalidBootstrapToken" });
                }
                try {
                    await issueUser({ ...body,
                        role: "admin" }, true);
                    await unlink(bootstrapPath).catch(() => undefined);
                    return ctx.json({ ok: true });
                } catch (error) {
                    const message = error instanceof Error && error.message.startsWith("auth") ? error.message : "authAccountExists";
                    throw new APIError("BAD_REQUEST", { message });
                }
            }),
        },
    };
}

/** Agent events a status-only account may send */
export const VIEWER_EVENTS = new Set([ "requestStackList", "serviceStatusList", "stackAvailability", "stabilityOverview" ]);
/** Agent events an operator may send, a viewer being allowed a part of them */
export const OPERATOR_EVENTS = new Set([
    ...VIEWER_EVENTS, "gitCloneStack", "gitListBranches", "gitPreviewUpdate", "gitApplyUpdate", "deployStack", "saveStack", "deleteStack", "getStack", "startStack", "stopStack",
    "restartStack", "updateStack", "downStack", "stackUpdatePreview", "abortCompose", "getStackFiles",
    "setStackFiles", "saveEnvFile", "listSecrets", "revealSecret", "saveSecret", "deleteSecret",
    "bindSecret", "unbindSecret", "dockerStats", "startService", "stopService", "restartService",
    "getDockerNetworkList", "terminalInput", "mainTerminal", "checkMainTerminal", "interactiveTerminal",
    "terminalJoin", "terminalLeave", "joinCombinedTerminal", "leaveCombinedTerminal", "terminalResize",
]);
const ACCOUNT_EVENTS = new Set([ "getSettings", "disconnectOtherSocketClients" ]);
const ADMIN_EVENTS = new Set([ "setSettings", "addAgent", "removeAgent", "updateAgent", "usersList", "usersCreate", "usersUpdate", "usersResetPassword", "usersDelete" ]);

/** Explicit allowlists cover both direct and forwarded agent operations. */
export function roleAllowsEvent(role : UserRole, event : string, agent = false) : boolean {
    if (agent) {
        return (role === "viewer" ? VIEWER_EVENTS : OPERATOR_EVENTS).has(event);
    }
    return ACCOUNT_EVENTS.has(event) || (event === "composerize" && role !== "viewer") || (role === "admin" && ADMIN_EVENTS.has(event));
}

/** Revalidate the cookie and current role before every protected operation. */
export async function authorizeSocketEvent(socket : DockgeSocket, event : string, agent = false) : Promise<void> {
    const identity = await getAuthRuntime().identify(socket.request.headers);
    if (!identity.userID || identity.userID !== socket.userID) {
        throw new Error("authSessionExpired");
    }
    if (socket.userRole && socket.userRole !== identity.role) {
        socket.instanceManager?.disconnectAll();
        socket.emit("needAuth");
        socket.disconnect();
        throw new Error("authSessionExpired");
    }
    socket.userRole = identity.role ?? "viewer";
    if (!roleAllowsEvent(socket.userRole, event, agent)) {
        throw new Error("authPermissionDenied");
    }
}

/** Public account metadata for the owner; credentials never leave the database. */
export async function listUsers() {
    return Database.getKnex()("user").select("id", "name", "email", "username", "role", "suspended", "twoFactorEnabled").orderBy("createdAt");
}

/** Update access or remove an account while preserving an active owner. */
export async function changeUserAccess(id : unknown, change : { role? : unknown; suspended? : unknown; remove? : boolean }) {
    if (typeof id !== "string" || !id) {
        throw new Error("authUnknownUser");
    }
    if (change.role !== undefined && (typeof change.role !== "string" || ![ "admin", "operator", "viewer" ].includes(change.role))) {
        throw new Error("authInvalidRole");
    }
    if (change.suspended !== undefined && typeof change.suspended !== "boolean") {
        throw new Error("authInvalidUserData");
    }
    await Database.getKnex().transaction(async (trx) => {
        // Acquire SQLite's write lock before reading the number of owners, so two
        // simultaneous removals cannot each rely on the owner removed by the other.
        await trx("user").where("id", id).update({ updatedAt: Date.now() });
        const user = await trx("user").where("id", id).first();
        if (!user) {
            throw new Error("authUnknownUser");
        }
        const losesOwner = change.remove || change.suspended === true || (change.role !== undefined && change.role !== "admin");
        if (user.role === "admin" && !user.suspended && losesOwner) {
            const count = await trx("user").where({ role: "admin",
                suspended: 0 }).count("id as count").first();
            if (Number(count?.count) <= 1) {
                throw new Error("authLastOwner");
            }
        }
        // Revocation also applies to cookies obtained before the permission change.
        await trx("session").where("userId", id).delete();
        if (change.remove) {
            await trx("account").where("userId", id).delete();
            await trx("twoFactor").where("userId", id).delete();
            await trx("user").where("id", id).delete();
        } else {
            await trx("user").where("id", id).update({
                role: change.role ?? user.role,
                suspended: change.suspended === undefined ? user.suspended : Number(change.suspended),
            });
        }
    });
}

/** Replace the credential hash and revoke every existing login of that account. */
export async function resetUserPassword(id : unknown, password : unknown) {
    if (typeof id !== "string" || !id) {
        throw new Error("authUnknownUser");
    }
    if (typeof password !== "string" || password.length < 10 || password.length > 128) {
        throw new Error("authPasswordLength");
    }
    const hash = await getAuthRuntime().hashPassword(password);
    await Database.getKnex().transaction(async (trx) => {
        const updated = await trx("account").where({ userId: id,
            providerId: "credential" }).update({ password: hash,
            updatedAt: Date.now() });
        if (!updated) {
            throw new Error("authUnknownUser");
        }
        await trx("session").where("userId", id).delete();
    });
}

/**
 * Keep viewer broadcasts restricted to status fields, including remote agent data.
 *
 * The summary of a remote agent arrives over the network, so the two lists are copied
 * only when they are lists: another build may send something else, and a viewer row is
 * no place to find that out.
 * @param input Full summary, either built here or received from an agent
 * @returns The same stack without anything about its files
 */
export function viewerStackSummary(input : StackSummaryDTO) : ViewerStackSummary {
    return {
        name: input.name,
        status: input.status,
        endpoint: input.endpoint,
        isManagedByDockge: input.isManagedByDockge,
        availability: input.availability,
        services: Array.isArray(input.services) ? input.services.map((service) => ({ name: service.name,
            state: service.state,
            isOneShot: service.isOneShot })) : [],
        issues: Array.isArray(input.issues) ? input.issues.map((issue) => ({ service: issue.service,
            name: issue.name,
            reason: issue.reason })) : [],
    };
}

/** Local recovery command only; this operation is never exposed over HTTP or sockets. */
export async function resetInstanceAccounts() {
    await Database.getKnex().transaction(async (trx) => {
        await trx("session").delete();
        await trx("account").delete();
        for (const table of [ "twoFactor", "verification", "auth_bootstrap" ]) {
            if (await trx.schema.hasTable(table)) {
                await trx(table).delete();
            }
        }
        await trx("user").delete();
    });
}
