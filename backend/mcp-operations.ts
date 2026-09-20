import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import YAML from "yaml";
import type { StackFileConfig } from "../common/types/stack";
import { acceptedComposeFileNames } from "../common/util-common";
import { lstat, readdir, open } from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";
import { z } from "zod";
import type { DockgeServer } from "./dockge-server";
import { Database } from "./database";
import { revalidateMcpIdentity, synchronizeStackIdentities, type MachineIdentity } from "./mcp-keys";
import { Stack } from "./stack";
import { ContainerOperations, containerOperationFingerprint } from "./container-operations";
import { readDockerRuntime } from "./stability";
import { spawn } from "./child-process";

export interface PreparedMcpAction {
    serverId: string;
    stackId: string;
    fingerprint: string;
    /** A fixed safe description, never file text, command output or credentials. */
    summary: string;
    /** Owner review stays volatile and is never exposed through operation_status. */
    ownerReview?: Record<string, unknown>;
    revalidate: () => Promise<boolean>;
    /** Return only explicit outcome metadata, never raw stderr or file contents. */
    execute: (guard: () => Promise<void>) => Promise<Record<string, unknown>>;
}
export interface McpActionHandler {
    requiredAction: string;
    schema: z.ZodType;
    prepare: (identity: MachineIdentity, args: unknown) => Promise<PreparedMcpAction>;
}
const prepareSchema = z.object({ action: z.string().min(1).max(64),
    request_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    parameters: z.record(z.string(), z.unknown()) }).strict();
const applySchema = z.object({ operation_id: z.string().uuid(),
    parameters_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const statusSchema = z.object({ operation_id: z.string().uuid() }).strict();

/** Canonical JSON binds a request to values rather than property insertion order. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return "[" + value.map(canonical).join(",") + "]";
    }
    if (value && typeof value === "object") {
        return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
    }
    return JSON.stringify(value);
}

/** Recheck current authority, including the per-server resource relation. */
function access(identity: MachineIdentity, permission: string, serverId: string, stackId: string): void {
    if (identity.role !== "operator" || identity.mode === "readonly" || !identity.actions.includes(permission) || !identity.resources[serverId]?.includes(stackId)) {
        throw new Error("mcpPermissionDenied");
    }
}

/** Durable claims prevent duplicate effects; prepared contents stay only in memory. */
export class McpOperations {
    private handlers = new Map<string, McpActionHandler>();
    private prepared = new Map<string, PreparedMcpAction>();
    /** Publish exact registered action schemas so clients never guess shell-like parameters. */
    get toolDefinitions() {
        return [
            { name: "operation_prepare",
                description: "Prepare a permitted operation without executing it",
                inputSchema: this.actionSchema() },
            { name: "operation_apply",
                description: "Apply the exact prepared operation once",
                inputSchema: z.toJSONSchema(applySchema) },
            { name: "operation_status",
                description: "Read the outcome of your operation",
                inputSchema: z.toJSONSchema(statusSchema) },
        ];
    }

    /** Discovery applies the same action ceiling as execution. */
    getToolDefinitions(identity: MachineIdentity) {
        if (identity.role !== "operator" || identity.mode === "readonly") {
            return [];
        }
        return this.toolDefinitions.map(tool => {
            if (tool.name !== "operation_prepare") {
                return tool;
            }
            return { ...tool,
                inputSchema: this.actionSchema(identity) };
        });
    }

    private actionSchema(identity?: MachineIdentity) {
        return { type: "object" as const,
            oneOf: [ ...this.handlers ].filter(([ , handler ]) => !identity || identity.actions.includes(handler.requiredAction)).map(([ action, handler ]) => ({ type: "object",
                properties: { action: { const: action },
                    request_id: { type: "string",
                        pattern: "^[a-zA-Z0-9_-]{1,100}$" },
                    parameters: z.toJSONSchema(handler.schema) },
                required: [ "action", "request_id", "parameters" ],
                additionalProperties: false })) };
    }

    constructor(private knex: Knex, private refresh: (keyId: string) => Promise<MachineIdentity> = revalidateMcpIdentity) {}

    /** Register only structured actions owned by trusted server code. */
    register(name: string, handler: McpActionHandler): void {
        if (this.handlers.has(name)) {
            throw new Error("Duplicate MCP action");
        }
        this.handlers.set(name, handler);
    }

    private async current(identity: MachineIdentity): Promise<MachineIdentity> {
        const current = await this.refresh(identity.keyId);
        if (current.userId !== identity.userId) {
            throw new Error("mcpPermissionDenied");
        }
        return current;
    }

    private async owned(identity: MachineIdentity, id: string) {
        const current = await this.current(identity);
        const row = await this.knex("mcp_operation").where({ id,
            key_id: current.keyId }).first();
        if (!row) {
            throw new Error("mcpPermissionDenied");
        }
        access(current, row.permission, row.server_id, row.stack_id);
        if (current.policyVersion !== row.policy_version) {
            throw new Error("mcpPermissionDenied");
        }
        return { current,
            row };
    }

    private summary(row: Record<string, unknown>) {
        return { operation_id: row.id,
            action: row.action,
            server_id: row.server_id,
            stack_id: row.stack_id,
            parameters_hash: row.parameters_hash,
            summary: row.summary,
            state: row.state === "running" && !this.prepared.has(String(row.id)) ? "unknown" : row.state,
            expires_at: row.expires_at,
            result: row.result ? JSON.parse(String(row.result)) : null };
    }

    /** Route strict prepare/apply/status inputs without accepting a caller-selected event. */
    async call(identity: MachineIdentity, name: string, input: unknown): Promise<unknown> {
        if (name === "operation_prepare") {
            return this.prepare(identity, input);
        }
        if (name === "operation_status") {
            const request = statusSchema.parse(input);

            return this.summary((await this.owned(identity, request.operation_id)).row);
        }
        if (name !== "operation_apply") {
            throw new Error("mcpPermissionDenied");
        }
        return this.apply(identity, input);
    }

    /**
     * Write down what an operation would do, without doing any of it.
     *
     * The rights are read, the arguments are validated, the rights are read again, and
     * only then is the operation stored. The same request twice is the same operation:
     * the caller may lose the answer and ask again without the work happening twice.
     * @param identity Who is asking
     * @param input Arguments of the call
     * @returns The stored operation
     */
    private async prepare(identity: MachineIdentity, input: unknown): Promise<unknown> {
        const current = await this.current(identity);
        const request = prepareSchema.parse(input);
        const handler = this.handlers.get(request.action);
        if (!handler || current.role !== "operator" || current.mode === "readonly" || !current.actions.includes(handler.requiredAction)) {
            throw new Error("mcpPermissionDenied");
        }
        const args = handler.schema.parse(request.parameters);
        const hash = createHash("sha256").update(canonical({ action: request.action,
            args })).digest("hex");
        const existing = await this.knex("mcp_operation").where({ key_id: current.keyId,
            request_id: request.request_id }).first();
        if (existing) {
            const { row } = await this.owned(current, existing.id);
            if (row.parameters_hash !== hash) {
                throw new Error("mcpRequestChanged");
            }
            return this.summary(row);
        }
        const prepared = await handler.prepare(current, args);
        access(current, handler.requiredAction, prepared.serverId, prepared.stackId);
        const fresh = await this.current(current);
        access(fresh, handler.requiredAction, prepared.serverId, prepared.stackId);
        if (fresh.policyVersion !== current.policyVersion) {
            throw new Error("mcpPermissionDenied");
        }
        if (this.prepared.size >= 500) {
            for (const [ id ] of this.prepared) {
                const row = await this.knex("mcp_operation").where({ id }).first();
                if (!row || row.expires_at <= Date.now()) {
                    this.prepared.delete(id);
                }
            }
            if (this.prepared.size >= 500) {
                throw new Error("mcpTooManyOperations");
            }
        }
        const row = { id: randomUUID(),
            key_id: fresh.keyId,
            request_id: request.request_id,
            action: request.action,
            permission: handler.requiredAction,
            server_id: prepared.serverId,
            stack_id: prepared.stackId,
            parameters_hash: hash,
            fingerprint: prepared.fingerprint,
            policy_version: fresh.policyVersion,
            summary: prepared.summary.slice(0, 200),
            state: fresh.mode === "approval" ? "awaiting_approval" : "prepared",
            created_at: Date.now(),
            expires_at: Date.now() + 10 * 60_000 };
        try {
            await this.knex("mcp_operation").insert(row);
        } catch {
            const duplicate = await this.knex("mcp_operation").where({ key_id: fresh.keyId,
                request_id: request.request_id }).first();
            if (!duplicate || duplicate.parameters_hash !== hash) {
                throw new Error("mcpRequestChanged");
            }
            return this.summary((await this.owned(fresh, duplicate.id)).row);
        }
        this.prepared.set(row.id, prepared);
        return this.summary(row);
    }

    /**
     * Carry out an operation that was prepared earlier.
     *
     * Ownership, the hash of the arguments and the state of the files are all checked
     * again here, because time passed since the operation was written down. The claim on
     * the row happens before any side effect, so a second caller finds it taken.
     * @param identity Who is asking
     * @param input Arguments of the call
     * @returns The operation as it ended
     */
    private async apply(identity: MachineIdentity, input: unknown): Promise<unknown> {
        const request = applySchema.parse(input);
        const { current, row } = await this.owned(identity, request.operation_id);
        if (row.parameters_hash !== request.parameters_hash) {
            throw new Error("mcpRequestChanged");
        }
        if ([ "succeeded", "failed", "running" ].includes(row.state)) {
            return this.summary(row);
        }
        const prepared = this.prepared.get(row.id);
        if (!prepared || row.expires_at <= Date.now()) {
            throw new Error("mcpOperationExpired");
        }
        if (row.state !== "prepared" || current.mode === "approval" && !row.approved_by) {
            throw new Error("mcpApprovalRequired");
        }
        if (!await prepared.revalidate()) {
            throw new Error("mcpOperationStale");
        }
        await this.owned(current, row.id);
        // The durable compare-and-set occurs before any side effect, including across process instances.
        const claimed = await this.knex("mcp_operation").where({ id: row.id,
            state: "prepared" }).where("expires_at", ">", Date.now()).update({ state: "running" });
        if (!claimed) {
            return this.summary((await this.owned(current, row.id)).row);
        }
        try {
            await this.owned(current, row.id);
            if (!await prepared.revalidate()) {
                throw new Error("mcpOperationStale");
            }
            const outcome = await prepared.execute(async () => {
                await this.owned(current, row.id);
            });
            // Only known scalar status fields are persisted; arbitrary handler output cannot leak secrets.
            const result = Object.fromEntries(Object.entries(outcome).filter(([ key, value ]) => ([ "saved", "deployed", "completed" ].includes(key) && typeof value === "boolean") || (key === "preview_id" && typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)) || (key === "file_hash" && typeof value === "string" && /^[a-f0-9]{64}$/.test(value))));
            await this.knex("mcp_operation").where({ id: row.id }).update({ state: "succeeded",
                result: JSON.stringify(result) });
        } catch {
            await this.knex("mcp_operation").where({ id: row.id }).update({ state: "failed",
                result: JSON.stringify({ completed: false }) });
        } finally {
            this.prepared.delete(row.id);
        }
        return this.summary((await this.owned(current, row.id)).row);

    }

    /** Reveal exact volatile review details only to a currently active owner session. */
    async review(ownerId: string, operationId: string): Promise<unknown> {
        const owner = await this.knex("user").where({ id: ownerId,
            role: "admin",
            suspended: 0 }).first();
        if (!owner) {
            throw new Error("mcpPermissionDenied");
        }
        const row = await this.knex("mcp_operation").where({ id: operationId }).whereIn("state", [ "prepared", "awaiting_approval" ]).where("expires_at", ">", Date.now()).first();
        const prepared = this.prepared.get(operationId);
        if (!row || !prepared) {
            throw new Error("mcpOperationExpired");
        }
        return { ...this.summary(row),
            review: prepared.ownerReview ?? { summary: prepared.summary } };
    }

    /** Owner-only route must supply a verified session user; machine keys have no approval path. */
    async approve(ownerId: string, operationId: string): Promise<void> {
        const owner = await this.knex("user").where({ id: ownerId,
            role: "admin",
            suspended: 0 }).first();
        if (!owner) {
            throw new Error("mcpPermissionDenied");
        }
        const changed = await this.knex("mcp_operation").where({ id: operationId,
            state: "awaiting_approval" }).where("expires_at", ">", Date.now()).update({ approved_by: ownerId,
            state: "prepared" });
        if (!changed) {
            throw new Error("mcpOperationExpired");
        }
    }

    /** Safe owner review metadata excludes parameters and all captured file contents. */
    async listPending() {
        const rows = await this.knex("mcp_operation").where({ state: "awaiting_approval" }).where("expires_at", ">", Date.now()).orderBy("created_at", "desc").limit(100);
        return rows.map(row => this.summary(row));
    }
}

/** Hash Compose inputs only; bind-mounted runtime data is never an operation input. */
export async function stackOperationFingerprint(directory: string, config?: StackFileConfig, options: { deployment?: boolean } = {}): Promise<string> {
    const hash = createHash("sha256");
    let bytes = 0;
    let entries = 0;
    const seen = new Map<string, string | null>();
    const composeSeen = new Set<string>();
    const root = await lstat(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new Error("mcpOperationStale");
    }
    hash.update(`${root.dev}:${root.ino}:${root.birthtimeMs}`).update(JSON.stringify(config ?? null));
    const resolve = (base: string, name: unknown): string => {
        if (typeof name !== "string" || !name || name.includes("$") || name.includes("\0") || path.isAbsolute(name)) {
            throw new Error("mcpUnsupportedComposeInput");
        }
        const relative = path.relative(directory, path.resolve(directory, base, name));
        if (relative === ".." || relative.startsWith("../") || relative.split(path.sep).includes(".git")) {
            throw new Error("mcpUnsupportedComposeInput");
        }
        return relative;
    };
    const read = async (relative: string, optional = false): Promise<string | null> => {
        if (seen.has(relative)) {
            return seen.get(relative)!;
        }
        if (++entries > 1000) {
            throw new Error("mcpOperationStale");
        }
        let parent = directory;
        for (const part of relative.split(path.sep).slice(0, -1)) {
            parent = path.join(parent, part);
            const stat = await lstat(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new Error("mcpOperationStale");
            }
        }
        const target = path.join(directory, relative);
        let stat;
        try {
            stat = await lstat(target);
        } catch (error) {
            if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
                hash.update(JSON.stringify([ relative, "absent" ]));
                seen.set(relative, null);
                return null;
            }
            throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || (bytes += stat.size) > 20 * 1024 * 1024) {
            throw new Error("mcpOperationStale");
        }
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const current = await handle.stat();
            if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size) {
                throw new Error("mcpOperationStale");
            }
            const buffer = Buffer.alloc(stat.size + 1);
            if ((await handle.read(buffer, 0, buffer.length, 0)).bytesRead !== stat.size) {
                throw new Error("mcpOperationStale");
            }
            const content = buffer.subarray(0, stat.size);
            hash.update(JSON.stringify([ relative, stat.mode, stat.size ])).update(content);
            const text = content.toString("utf8");
            seen.set(relative, text);
            return text;
        } finally {
            await handle.close();
        }
    };
    const fileRefs = async (value: unknown, base: string): Promise<void> => {
        for (const entry of Array.isArray(value) ? value : value ? [ value ] : []) {
            const object = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
            await read(resolve(base, object ? object.path : entry), object?.required === false);
        }
    };
    const serviceRefs = async (service: Record<string, unknown>, base: string): Promise<void> => {
        // Build contexts can include arbitrary trees and remote sources; no false exact snapshot promise.
        if (options.deployment !== false && (service.build || service.develop || service.provider)) {
            throw new Error("mcpUnsupportedComposeInput");
        }
        await fileRefs(service.env_file, base);
        await fileRefs(service.label_file, base);
        const credential = service.credential_spec;
        if (credential && typeof credential === "object" && "file" in credential) {
            await read(resolve(base, credential.file));
        }
        const extendsValue = service.extends;
        if (extendsValue && typeof extendsValue === "object" && "file" in extendsValue) {
            await compose(resolve(base, extendsValue.file));
        }
    };
    const sectionRefs = async (doc: Record<string, unknown>, base: string): Promise<void> => {
        for (const section of [ doc.configs, doc.secrets ]) {
            if (!section || typeof section !== "object") {
                continue;
            }
            for (const value of Object.values(section)) {
                if (value && typeof value === "object" && "file" in value) {
                    await read(resolve(base, value.file));
                }
            }
        }
    };
    const includeRefs = async (doc: Record<string, unknown>, base: string): Promise<void> => {
        for (const include of Array.isArray(doc.include) ? doc.include : doc.include ? [ doc.include ] : []) {
            const object = include && typeof include === "object" ? include as Record<string, unknown> : null;
            if (object?.project_directory) {
                throw new Error("mcpUnsupportedComposeInput");
            }
            const paths = object ? object.path : include;
            for (const included of Array.isArray(paths) ? paths : [ paths ]) {
                const includedPath = resolve(base, included);
                await read(resolve(path.dirname(includedPath), ".env"), true);
                await fileRefs(object?.env_file, path.dirname(includedPath));
                await compose(includedPath);
            }
        }
    };
    const compose = async (relative: string): Promise<void> => {
        if (composeSeen.has(relative)) {
            return;
        }
        composeSeen.add(relative);
        if (composeSeen.size > 32) {
            throw new Error("mcpUnsupportedComposeInput");
        }
        const content = await read(relative);
        if (content === null) {
            return;
        }
        const doc = YAML.parse(content) as Record<string, unknown> | null;
        if (!doc || typeof doc !== "object") {
            throw new Error("mcpUnsupportedComposeInput");
        }
        const base = path.dirname(relative);
        const services = doc.services && typeof doc.services === "object" ? Object.values(doc.services) : [];
        for (const value of services) {
            if (value && typeof value === "object") {
                await serviceRefs(value as Record<string, unknown>, base);
            }
        }
        await sectionRefs(doc, base);
        await includeRefs(doc, base);
    };
    const main = config?.composeFileName || (await readdir(directory)).find(name => acceptedComposeFileNames.includes(name));
    if (!main) {
        throw new Error("mcpUnsupportedComposeInput");
    }
    await compose(resolve("", main));
    await read(".env", true);
    for (const file of config?.envFileNames ?? []) {
        await read(resolve("", file));
    }
    for (const binding of config?.secretBindings ?? []) {
        await read(resolve("", binding.fileName));
    }
    return hash.digest("hex");
}

/** Shared interpolation input is part of the exact operation even outside the stack directory. */
export async function optionalEnvFingerprint(file: string): Promise<string> {
    let stat;
    try {
        stat = await lstat(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "absent";
        }
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
        throw new Error("mcpOperationStale");
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const current = await handle.stat();
        if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size) {
            throw new Error("mcpOperationStale");
        }
        const buffer = Buffer.alloc(stat.size + 1);
        if ((await handle.read(buffer, 0, buffer.length, 0)).bytesRead !== stat.size) {
            throw new Error("mcpOperationStale");
        }
        return createHash("sha256").update(buffer.subarray(0, stat.size)).digest("hex");
    } finally {
        await handle.close();
    }
}

/** Lifecycle handlers reuse Stack command selection and never manufacture a browser socket. */
export function createMcpOperations(server: DockgeServer, refresh: (keyId: string) => Promise<MachineIdentity> = revalidateMcpIdentity): McpOperations {
    const operations = new McpOperations(Database.getKnex(), refresh);
    for (const action of [ "start", "stop", "restart" ] as const) {
        operations.register(`stack_${action}`, { requiredAction: "stacks:control",
            schema: z.object({ server_id: z.literal("local"),
                stack_id: z.string().uuid() }).strict(),
            prepare: async (identity, input) => {
                const args = input as { server_id: string; stack_id: string };
                access(identity, "stacks:control", args.server_id, args.stack_id);
                const resolve = async () => {
                    const identities = await synchronizeStackIdentities(Database.getKnex(), server);
                    const entry = identities.find(item => item.id === args.stack_id);
                    if (!entry) {
                        throw new Error("mcpPermissionDenied");
                    }
                    return Stack.getStack(server, entry.name);
                };
                const stack = await resolve();
                const currentFingerprint = async (value: Stack) => {
                    const containers = (await readDockerRuntime()).filter(item => path.resolve(item.workingDir || "/") === path.resolve(value.path));
                    const runtime = containers.map(item => [ item.id, item.service, item.state, item.startedAt ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
                    return createHash("sha256").update(await stackOperationFingerprint(value.path, value.fileConfig, { deployment: action === "start" })).update(JSON.stringify(runtime)).update(JSON.stringify(value.fileConfig)).update(await optionalEnvFingerprint(path.join(server.stacksDir, "global.env"))).digest("hex");
                };
                const fingerprint = await currentFingerprint(stack);
                return { serverId: args.server_id,
                    stackId: args.stack_id,
                    fingerprint,
                    summary: `stack_${action}: ${stack.name}`,
                    revalidate: async () => await currentFingerprint(await resolve()) === fingerprint,
                    execute: async guard => {
                        const currentStack = await resolve();
                        await currentStack.control(action, async (options, cwd) => {
                            if (await currentFingerprint(currentStack) !== fingerprint) {
                                throw new Error("mcpOperationStale");
                            }
                            await guard();
                            const result = await spawn("docker", options, { cwd,
                                encoding: "utf8",
                                maxBuffer: 256 * 1024,
                                timeoutMs: 120_000 });
                            return result.code ?? 1;
                        });
                        return { completed: true };
                    } };
            } });
    }
    const containers = new ContainerOperations();
    for (const action of [ "start", "stop", "restart" ] as const) {
        operations.register(`container_${action}`, { requiredAction: "containers:control",
            schema: containerTargetSchema,
            prepare: async (identity, input) => {
                const args = containerTargetSchema.parse(input);
                access(identity, "containers:control", args.server_id, args.stack_id);
                const resolve = async () => resolveMcpStack(server, args.stack_id);
                const row = await containers.inspect(await resolve(), args.container_id);
                const fingerprint = containerOperationFingerprint(row);
                return { serverId: args.server_id,
                    stackId: args.stack_id,
                    fingerprint,
                    summary: `container_${action}: ${row.service} (${row.id})`,
                    revalidate: async () => {
                        const current = await containers.inspect(await resolve(), args.container_id);
                        return containerOperationFingerprint(current) === fingerprint;
                    },
                    execute: async guard => {
                        await containers.control(await resolve(), args.container_id, action, guard, fingerprint);
                        return { completed: true };
                    } };
            } });
    }
    return operations;
}

const containerTargetSchema = z.object({ server_id: z.literal("local"),
    stack_id: z.string().uuid(),
    container_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const containerLogsSchema = containerTargetSchema.extend({ tail: z.number().int().min(1).max(200).default(100),
    since_seconds: z.number().int().min(1).max(86400).default(3600) }).strict();

async function resolveMcpStack(server: DockgeServer, stackId: string): Promise<Stack> {
    const row = (await synchronizeStackIdentities(Database.getKnex(), server)).find(item => item.id === stackId);
    if (!row) {
        throw new Error("mcpPermissionDenied");
    }
    return Stack.getStack(server, row.name);
}

/** Logs require their own grant and are never available to an observer. */
export async function readMcpContainerLogs(server: DockgeServer, identity: MachineIdentity, input: unknown, refresh: (keyId: string) => Promise<MachineIdentity> = revalidateMcpIdentity) {
    const args = containerLogsSchema.parse(input);
    const current = await refresh(identity.keyId);
    if (current.userId !== identity.userId) {
        throw new Error("mcpPermissionDenied");
    }
    access(current, "logs:read", args.server_id, args.stack_id);
    const stack = await resolveMcpStack(server, args.stack_id);
    const text = await new ContainerOperations().logs(stack, args.container_id, args.tail, args.since_seconds, async () => {
        access(await refresh(identity.keyId), "logs:read", args.server_id, args.stack_id);
    });
    const fresh = await refresh(identity.keyId);
    if (fresh.userId !== identity.userId) {
        throw new Error("mcpPermissionDenied");
    }
    access(fresh, "logs:read", args.server_id, args.stack_id);
    return { container_id: args.container_id,
        text };
}
