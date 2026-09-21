import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import type { Knex } from "knex";
import { z } from "zod";
import { hashKey, validScope } from "./mcp-policy";
import type { DockgeServer } from "./dockge-server";
import { Stack } from "./stack";
import { Database } from "./database";
import { Settings } from "./settings";
import { MCP_ACTIONS, type McpMode } from "../common/mcp";

const issueKeySchema = z.object({
    name: z.string().trim().min(1).max(80),
    userId: z.string().min(1).max(128),
    role: z.enum([ "viewer", "operator" ]).default("viewer"),
    actions: z.array(z.enum(MCP_ACTIONS)).max(MCP_ACTIONS.length).default([]),
    mode: z.enum([ "readonly", "automatic", "approval" ]).default("readonly"),
    resources: z.record(z.string().regex(/^[a-zA-Z0-9-]{1,64}$/), z.array(z.string().uuid()).min(1).max(100)).optional(),
    servers: z.array(z.string().regex(/^[a-zA-Z0-9-]{1,64}$/)).min(1).max(20).default([ "local" ]),
    stacks: z.array(z.string().uuid()).min(1).max(100),
    days: z.number().int().min(1).max(90).default(30),
}).strict();

export interface MachineIdentity {
    keyId : string;
    userId : string;
    role : "viewer" | "operator";
    actions : string[];
    mode : McpMode;
    resources : Record<string, string[]>;
    servers : string[];
    stacks : string[];
    policyVersion : number;
}

/** All lookups join the current account; disabling browser auth never bypasses this. */
export class McpKeys {
    constructor(private knex : Knex) {}

    /** Return metadata only; the secret hash is deliberately excluded. */
    async list() {
        return this.knex("mcp_key").select("id", "name", "user_id", "role", "servers", "stacks", "resources", "actions", "mode", "created_at", "expires_at", "revoked_at", "last_used_at").orderBy("created_at", "desc");
    }

    /** Create a bounded, individually revocable key and return its secret once. */
    async issue(value : unknown, remoteResources : Record<string, string[]> = {}) {
        const data = issueKeySchema.parse(value);
        if (!validScope(data.servers, data.stacks)) {
            throw new Error("mcpInvalidScope");
        }
        const user = await this.knex("user").where({ id: data.userId,
            suspended: 0 }).first();
        if (!user) {
            throw new Error("mcpInvalidUser");
        }
        const resources = data.resources ?? { local: data.stacks };
        if (data.role === "viewer" && (data.actions.length > 0 || data.mode !== "readonly") || data.role === "operator" && ![ "admin", "operator" ].includes(user.role)) {
            throw new Error("mcpInvalidRole");
        }
        const known = await this.knex("mcp_stack_identity").select("id");
        const catalog : Record<string, string[]> = { ...remoteResources,
            local: known.map((row) => row.id) };
        if (!data.servers.every((id) => resources[id]?.length && resources[id]!.every((stack) => catalog[id]?.includes(stack))) || Object.keys(resources).some((id) => !data.servers.includes(id)) || data.stacks.some((id) => !Object.values(resources).flat().includes(id)) || Object.values(resources).flat().some((id) => !data.stacks.includes(id))) {
            throw new Error("mcpInvalidScope");
        }
        const id = randomBytes(16).toString("hex");
        const secret = `dg2_${id}.${randomBytes(32).toString("hex")}`;
        await this.knex("mcp_key").insert({ id,
            name: data.name,
            user_id: data.userId,
            secret_hash: hashKey(secret),
            role: data.role,
            servers: JSON.stringify(data.servers),
            stacks: JSON.stringify(data.stacks),
            resources: JSON.stringify(resources),
            actions: JSON.stringify(data.actions),
            mode: data.mode,
            created_at: Date.now(),
            expires_at: Date.now() + data.days * 86_400_000,
            policy_version: 1 });
        await this.knex("mcp_audit").insert({ at: Date.now(),
            key_id: id,
            tool: "key_issue",
            outcome: "allowed",
            duration_ms: 0 });
        return { id,
            secret };
    }

    /** Existing keys can only lose permissions, resources or lifetime; new authority needs a new secret. */
    async reduce(id : string, value : unknown) {
        const data = issueKeySchema.parse(value);
        const row = await this.knex("mcp_key").where({ id }).first();
        if (!row || row.revoked_at !== null || row.user_id !== data.userId || data.role === "operator" && row.role !== "operator") {
            throw new Error("mcpInvalidReduction");
        }
        const oldResources : Record<string, string[]> = JSON.parse(row.resources);
        const oldActions : string[] = JSON.parse(row.actions);
        const resources = data.resources ?? { local: data.stacks };
        if (!validScope(data.servers, data.stacks) || Object.keys(resources).some(server => !data.servers.includes(server) || !resources[server]!.every(stack => oldResources[server]?.includes(stack))) || data.servers.some(server => !resources[server]?.length) || data.actions.some(action => !oldActions.includes(action)) || data.stacks.some(stack => !Object.values(resources).flat().includes(stack)) || Object.values(resources).flat().some(stack => !data.stacks.includes(stack)) || row.mode !== "automatic" && data.mode === "automatic" || row.mode === "readonly" && data.mode !== "readonly" || data.role === "viewer" && (data.actions.length || data.mode !== "readonly")) {
            throw new Error("mcpInvalidReduction");
        }
        await this.knex("mcp_key").where({ id }).update({ name: data.name,
            role: data.role,
            servers: JSON.stringify(data.servers),
            stacks: JSON.stringify(data.stacks),
            resources: JSON.stringify(resources),
            actions: JSON.stringify(data.actions),
            mode: data.mode,
            expires_at: Math.min(Number(row.expires_at), Date.now() + data.days * 86_400_000),
            policy_version: Number(row.policy_version) + 1 });
        await this.knex("mcp_audit").insert({ at: Date.now(),
            key_id: id,
            tool: "key_reduce",
            outcome: "allowed",
            duration_ms: 0 });
    }

    /** Revocation is read directly from the database on every request and response. */
    async revoke(id : string) {
        await this.knex("mcp_key").where({ id }).update({ revoked_at: Date.now() });
        await this.knex("mcp_audit").insert({ at: Date.now(),
            key_id: id,
            tool: "key_revoke",
            outcome: "allowed",
            duration_ms: 0 });
    }

    /** Validate secret, expiry and current owner access without any session cache. */
    async authenticate(secret : string | null) : Promise<MachineIdentity> {
        // Новые ключи несут имя продукта, но выпущенные до переименования
        // продолжают работать: отзыв ключа - решение владельца, а не побочный
        // эффект правки подписи
        const match = /^dg2?_([a-f0-9]{32})\.[a-f0-9]{64}$/.exec(secret ?? "");
        if (!secret || !match) {
            throw new Error("mcpUnauthorized");
        }
        const id = match[1] as string;
        const row = await this.knex("mcp_key").where({ id }).first();
        if (!row || row.revoked_at !== null || Number(row.expires_at) <= Date.now() || row.secret_hash.length !== 64 || !timingSafeEqual(Buffer.from(row.secret_hash, "hex"), Buffer.from(hashKey(secret), "hex"))) {
            throw new Error("mcpUnauthorized");
        }
        return this.resolveIdentity(id);
    }

    /** Internal revalidation by public ID does not authenticate an HTTP caller. */
    async resolveIdentity(id : string) : Promise<MachineIdentity> {
        const row = await this.knex("mcp_key").where({ id }).first();
        if (!row || row.revoked_at !== null || Number(row.expires_at) <= Date.now()) {
            throw new Error("mcpUnauthorized");
        }
        const user = await this.knex("user").where({ id: row.user_id }).first();
        if (!user || user.suspended || ![ "admin", "operator", "viewer" ].includes(user.role) || ![ "viewer", "operator" ].includes(row.role)) {
            throw new Error("mcpUnauthorized");
        }
        const servers : string[] = JSON.parse(row.servers);
        const stacks : string[] = JSON.parse(row.stacks);
        const resources : Record<string, string[]> = JSON.parse(row.resources);
        if (!validScope(servers, stacks) || servers.some((server) => !Array.isArray(resources[server]) || resources[server]!.some((stack) => !stacks.includes(stack)))) {
            throw new Error("mcpUnauthorized");
        }
        const role = row.role === "operator" && user.role !== "viewer" ? "operator" : "viewer";
        const actions = role === "operator" ? JSON.parse(row.actions) as string[] : [];
        if (actions.some((action) => !(MCP_ACTIONS as readonly string[]).includes(action))) {
            throw new Error("mcpUnauthorized");
        }
        await this.knex("mcp_key").where({ id }).update({ last_used_at: Date.now() });
        return { keyId: id,
            userId: user.id,
            role,
            actions,
            mode: role === "viewer" ? "readonly" : row.mode,
            resources,
            servers,
            stacks,
            policyVersion: Number(row.policy_version) };
    }

}

/** Bind grants to the directory instance, never implicitly inherit a deleted stack name. */
export async function synchronizeStackIdentities(knex : Knex, server : DockgeServer) {
    const names = await readdir(server.stacksDir);
    const identities : Array<{ id : string; name : string; createdAt : number; reserved? : boolean }> = [];
    for (const name of names) {
        let directory : string;
        try {
            directory = Stack.getSafePath(server, name);
        } catch {
            continue;
        }
        const stat = await lstat(directory).catch(() => null);
        if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
            continue;
        }
        if (!await Stack.composeFileExists(server.stacksDir, name)) {
            continue;
        }
        const fingerprint = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        await knex.transaction(async (trx) => {
            const row = await trx("mcp_stack_identity").where({ name: name }).first();
            if (row?.fingerprint === fingerprint) {
                identities.push({ id: row.id,
                    name,
                    createdAt: Number(row.created_at) });
                return;
            }
            await trx("mcp_stack_identity").where({ name: name }).delete();
            const id = randomUUID();
            await trx("mcp_stack_identity").insert({ id,
                name: name,
                fingerprint,
                created_at: Date.now() });
            identities.push({ id,
                name,
                createdAt: Date.now() });
        });
    }
    const reservations = await knex("mcp_stack_identity").where({ fingerprint: "reserved" });
    for (const row of reservations) {
        if (!identities.some(item => item.name === row.name)) {
            identities.push({ id: row.id,
                name: row.name,
                createdAt: Number(row.created_at),
                reserved: true });
        }
    }
    return identities;
}

/** Reserve an explicit future stack name for scoped clone, without creating user files. */
export async function reserveMcpStack(server : DockgeServer, name : string) {
    const directory = Stack.getSafePath(server, name);
    if (await lstat(directory).catch(() => null)) {
        throw new Error("mcpStackExists");
    }
    const id = randomUUID();
    await Database.getKnex()("mcp_stack_identity").insert({ id,
        name,
        fingerprint: "reserved",
        created_at: Date.now() });
    return { id,
        name,
        reserved: true };
}

/** Re-check revocation and current rights immediately before a queued effect. */
export async function revalidateMcpIdentity(keyId : string) : Promise<MachineIdentity> {
    const config = await Settings.get("mcpConfig");
    if (!config?.enabled) {
        throw new Error("mcpUnauthorized");
    }
    return new McpKeys(Database.getKnex()).resolveIdentity(keyId);
}
