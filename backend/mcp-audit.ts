import { z } from "zod";
import { Database } from "./database";
import { log } from "./log";

/** How a recorded MCP event ended */
export type McpAuditOutcome = "allowed" | "denied" | "invalid" | "refused";

/** One row of the MCP log. Arguments, secrets and results are never part of it. */
export interface McpAuditEntry {
    tool : string;
    outcome : McpAuditOutcome;
    key_id? : string | null;
    duration_ms? : number;
    server_id? : string;
    stack_id? : string;
    request_id? : string;
    action? : string;
    client_name? : string | null;
    client_version? : string | null;
    protocol_version? : string | null;
    address? : string | null;
    reason? : string | null;
    detail? : string | null;
}

/** What a client said about itself */
export interface McpClientInfo {
    name : string | null;
    version : string | null;
    protocol : string | null;
}

interface Group {
    entry : McpAuditEntry;
    id : number | null;
    startedAt : number;
    lastAt : number;
    attempts : number;
    written : number;
    timer : NodeJS.Timeout | null;
    chain : Promise<void>;
}

const RETENTION_MS = 30 * 86_400_000;
const HISTORY_ROWS = 10_000;
const REFUSED_ROWS = 1_000;
const WINDOW_MS = 60_000;
const FLUSH_MS = 5_000;
const MAX_GROUPS = 1_000;

const groups = new Map<string, Group>();
const unwritten = new Set<Group>();
const clients = new Map<string, McpClientInfo>();

/**
 * Keep a value a client chose printable and short: the log is read by people, and
 * control or direction characters would let a client rewrite what they see.
 * @param value Untrusted value
 * @param max Longest kept length
 * @returns Clean text, or null when nothing is left
 */
export function auditText(value : unknown, max = 64) : string | null {
    if (typeof value !== "string") {
        return null;
    }
    const text = value.normalize("NFKC").replace(/\p{Zs}/gu, " ").replace(/[^\p{L}\p{N} ._@/+:()#,-]/gu, "").trim().slice(0, max);
    return text || null;
}

/**
 * The reason slug of a failed tool call, derived from the internal error code.
 * @param error Why the call failed
 * @returns For example `approval_required`, `invalid_arguments` or `error`
 */
export function auditReason(error : unknown) : string {
    if (error instanceof z.ZodError) {
        return "invalid_arguments";
    }
    const code = error instanceof Error ? error.message : "";
    return /^mcp[A-Z][A-Za-z]{1,60}$/.test(code) ? code.slice(3).replace(/[A-Z]/g, (letter, index) => (index ? "_" : "") + letter.toLowerCase()) : "error";
}

/**
 * Remember what a key's client announced, so the calls of a 2025 client, which names
 * itself only in `initialize`, can still be attributed.
 * @param keyId Key the client used
 * @param info What it announced
 * @returns {void}
 */
export function rememberClient(keyId : string, info : McpClientInfo) : void {
    clients.delete(keyId);
    clients.set(keyId, info);
    if (clients.size > 1000) {
        clients.delete(clients.keys().next().value as string);
    }
}

/**
 * What the key's client last announced.
 * @param keyId Key the client used
 * @returns The announcement, if there was one
 */
export function recalledClient(keyId : string) : McpClientInfo | undefined {
    return clients.get(keyId);
}

function row(entry : McpAuditEntry) {
    return { key_id: entry.key_id ?? null,
        tool: entry.tool,
        outcome: entry.outcome,
        duration_ms: entry.duration_ms ?? 0,
        server_id: entry.server_id ?? null,
        stack_id: entry.stack_id ?? null,
        request_id: entry.request_id ?? null,
        action: entry.action ?? null,
        client_name: auditText(entry.client_name),
        client_version: auditText(entry.client_version, 32),
        protocol_version: auditText(entry.protocol_version, 16),
        address: typeof entry.address === "string" ? entry.address.replace(/[^0-9a-fA-F:.]/g, "").slice(0, 64) || null : null,
        reason: typeof entry.reason === "string" && /^[a-z_]{1,64}$/.test(entry.reason) ? entry.reason : null,
        detail: auditText(entry.detail, 128) };
}

/**
 * Drop rows older than the retention period and keep refusals capped apart from the
 * rest, so a flood of refused requests cannot push call history out of the log.
 * @param refused Which of the two caps to enforce
 * @returns {void}
 */
async function prune(refused : boolean) : Promise<void> {
    const knex = Database.getKnex();
    const scope = (query : ReturnType<typeof knex>) => refused ? query.where({ outcome: "refused" }) : query.whereNot({ outcome: "refused" });

    await knex("mcp_audit").where("at", "<", Date.now() - RETENTION_MS).delete();
    const cutoff = await scope(knex("mcp_audit")).orderBy("id", "desc").offset((refused ? REFUSED_ROWS : HISTORY_ROWS) - 1).first("id");
    if (cutoff) {
        await scope(knex("mcp_audit")).where("id", "<", cutoff.id).delete();
    }
}

/**
 * Write one event down. A failure to write is reported, never thrown: the event
 * already happened, and the caller's answer must not be lost to the log.
 * @param entry What happened
 * @returns {void}
 */
export async function recordMcpAudit(entry : McpAuditEntry) : Promise<void> {
    try {
        await Database.getKnex()("mcp_audit").insert({ at: Date.now(),
            ...row(entry) });
        await prune(entry.outcome === "refused");
    } catch (error) {
        log.error("mcp", `The MCP log could not be written: ${error instanceof Error ? error.message : error}`);
    }
}

async function write(group : Group) : Promise<void> {
    const attempts = group.attempts;
    if (group.written === attempts) {
        unwritten.delete(group);
        return;
    }
    try {
        const knex = Database.getKnex();
        if (group.id === null) {
            const [ id ] = await knex("mcp_audit").insert({ at: group.lastAt,
                ...row(group.entry),
                attempts });
            group.id = Number(id);
            await prune(group.entry.outcome === "refused");
        } else {
            await knex("mcp_audit").where({ id: group.id }).update({ at: group.lastAt,
                attempts });
        }
        group.written = attempts;
    } catch (error) {
        log.error("mcp", `The MCP log could not be written: ${error instanceof Error ? error.message : error}`);
        group.written = attempts;
    }
    if (!group.timer) {
        unwritten.delete(group);
    }
}

function schedule(group : Group) : void {
    unwritten.add(group);
    if (group.timer) {
        return;
    }
    group.timer = setTimeout(() => {
        group.timer = null;
        group.chain = group.chain.then(() => write(group));
    }, group.id === null ? 0 : FLUSH_MS);
    group.timer.unref();
}

/**
 * Record a repeating event once per source and minute, counting the repeats.
 *
 * The first occurrence is written at once; repeats update the same row at most every
 * few seconds. A refusal therefore costs no database write per request, and a burst
 * from one address reads as one line with a count.
 * @param key What makes two events the same, for example address and reason
 * @param entry The event
 * @returns {void}
 */
export function recordMcpRepeated(key : string, entry : McpAuditEntry) : void {
    const now = Date.now();
    let group = groups.get(key);
    if (!group || now - group.startedAt >= WINDOW_MS) {
        for (const [ name, item ] of groups) {
            if (now - item.startedAt >= WINDOW_MS) {
                groups.delete(name);
            }
        }
        if (groups.size >= MAX_GROUPS) {
            return;
        }
        group = { entry,
            id: null,
            startedAt: now,
            lastAt: now,
            attempts: 0,
            written: 0,
            timer: null,
            chain: Promise.resolve() };
        groups.set(key, group);
    }
    group.attempts++;
    group.lastAt = now;
    schedule(group);
}

/**
 * Write every counted repeat now, for example before the log is read.
 * @returns {void}
 */
export async function flushMcpAudit() : Promise<void> {
    await Promise.all([ ...unwritten ].map(group => {
        if (group.timer) {
            clearTimeout(group.timer);
            group.timer = null;
            group.chain = group.chain.then(() => write(group));
        }
        return group.chain;
    }));
}

/**
 * Flush and forget all counters, used when the database changes underneath.
 * @returns {void}
 */
export async function resetMcpAudit() : Promise<void> {
    await flushMcpAudit();
    groups.clear();
    unwritten.clear();
    clients.clear();
}
