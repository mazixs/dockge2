import express from "express";
import type { Request, Response, NextFunction } from "express";
import { Readable } from "node:stream";
import { createMcpHandler, Server, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY, type AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import packageJSON from "../package.json";
import { DelegatedInvocation } from "./mcp-delegated-operations";
import { registerMcpFilesGit } from "./mcp-files-git";
import type { DockgeServer } from "./dockge-server";
import { Database } from "./database";
import { Settings } from "./settings";
import { log } from "./log";
import { getSessionFromHeaders, resolveRequestAddress, resolveTrustedOrigins, trustsProxyHeaders, verifyAccountPassword } from "./auth";
import { McpKeys, synchronizeStackIdentities, revalidateMcpIdentity, reserveMcpStack, unreserveMcpStack, type MachineIdentity } from "./mcp-keys";
import { MCP_READ_TOOLS, parseBearer, permittedTool, safeContainer, hashKey } from "./mcp-policy";
import { stabilityCollector } from "./stability";
import { createDelegationRouter, loadDelegationConfig, publicDelegationPeers, callDelegatedTool } from "./mcp-delegation";
import { createMcpOperations, containerLogsSchema, readMcpContainerLogs, type McpOperations } from "./mcp-operations";
import { MCP_INSTRUCTIONS, MCP_TOOL_ORDER, failureMessage, toolDefinition } from "./mcp-catalog";
import { auditReason, auditText, flushMcpAudit, recalledClient, recordMcpAudit, recordMcpRepeated, rememberClient, type McpAuditOutcome, type McpClientInfo } from "./mcp-audit";

const targetSchema = z.object({ server_id: z.literal("local"),
    stack_id: z.string().uuid() }).strict();
const inputSchemas = {
    servers_list: z.object({}).strict(),
    stacks_list: z.object({ server_id: z.literal("local") }).strict(),
    containers_list: targetSchema,
    container_status: targetSchema.extend({ container_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    stability_get: targetSchema.extend({ window_hours: z.union([ z.literal(24), z.literal(168), z.literal(720) ]).default(24) }).strict(),
};
const configSchema = z.object({ enabled: z.boolean(),
    url: z.string().max(512),
    allowInsecureHttp: z.boolean().default(false) }).strict();

/** Stored MCP settings */
export type McpConfig = z.infer<typeof configSchema>;

/** Methods that open or describe a connection, as opposed to calling a tool */
const CONNECTION_METHODS = [ "initialize", "server/discover", "tools/list" ];

const LOOPBACK = [ "localhost", "127.0.0.1", "[::1]" ];

/** Read-only service uses the existing observations, never starts a Docker command. */
export async function readMcpTool(server : DockgeServer, identity : MachineIdentity, name : string, input : unknown) {
    if (!permittedTool(identity.role, name)) {
        throw new Error("mcpPermissionDenied");
    }
    const schema = inputSchemas[name as keyof typeof inputSchemas];
    const args = schema.parse(input) as { server_id? : string; stack_id? : string; container_id? : string; window_hours? : 24 | 168 | 720 };
    if (!identity.servers.includes("local")) {
        throw new Error("mcpPermissionDenied");
    }
    if (name === "servers_list") {
        return { servers: [{ id: "local",
            name: "Local" }] };
    }
    const all = await synchronizeStackIdentities(Database.getKnex(), server);
    const allowed = all.filter((stack) => identity.resources.local?.includes(stack.id));
    if (name === "stacks_list") {
        return { stacks: allowed };
    }
    const stack = allowed.find((item) => item.id === args.stack_id);
    if (!stack) {
        throw new Error("mcpPermissionDenied");
    }
    const overview = await stabilityCollector.read(args.window_hours ?? 24);
    const group = !stack.reserved && overview.observedAt !== null && overview.observedAt >= stack.createdAt ? overview.stacks.find((item) => item.name === stack.name && item.managed) : undefined;
    if (name === "stability_get") {
        return { observedAt: overview.observedAt,
            stale: overview.stale,
            windowHours: overview.windowHours,
            stack: group ?? null };
    }
    const containers = (group?.containers ?? []).map((item) => safeContainer({ ...item }));
    if (name === "container_status") {
        const container = containers.find((item) => item.id === args.container_id);
        if (!container) {
            throw new Error("mcpPermissionDenied");
        }
        return { stale: overview.stale,
            observedAt: overview.observedAt,
            container };
    }
    return { stale: overview.stale,
        observedAt: overview.observedAt,
        containers };
}

/**
 * Validate the address the endpoint answers on. It decides which Host and Origin are
 * accepted, so it cannot be arbitrary.
 *
 * Plain HTTP is accepted on loopback, and elsewhere only when the owner opted in: the
 * key then crosses the network readable by anyone on the path.
 * @param value The configured address
 * @param allowInsecureHttp Whether the owner accepted plain HTTP beyond loopback
 * @returns The parsed address
 */
export function validateMcpURL(value : string, allowInsecureHttp = false) : URL {
    let url : URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("mcpInvalidURL");
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/mcp" || ![ "https:", "http:" ].includes(url.protocol)) {
        throw new Error("mcpInvalidURL");
    }
    if (url.protocol === "http:" && !LOOPBACK.includes(url.hostname) && !allowInsecureHttp) {
        throw new Error("mcpInsecureURL");
    }
    return url;
}

/**
 * Whether a Host header names the configured address. A default port written out
 * explicitly is the same address.
 * @param header Host header value
 * @param url Configured address
 * @returns Whether they match
 */
function sameHost(header : string | undefined, url : URL) : boolean {
    if (!header) {
        return false;
    }
    const host = header.toLowerCase().replace(url.protocol === "https:" ? /:443$/ : /:80$/, "");
    return host === url.host;
}

/** Advertise the same resource selector for local and explicitly configured peers. */
function publicToolSchema(value : unknown) : { type: "object" } {
    const schema = structuredClone(value) as Record<string, unknown>;
    const visit = (item : unknown) => {
        if (!item || typeof item !== "object") {
            return;
        }
        const node = item as Record<string, unknown>;
        const properties = node.properties as Record<string, unknown> | undefined;
        if (properties && (properties.server_id || properties.operation_id || properties.request_id)) {
            properties.server_id = { type: "string",
                pattern: "^[a-zA-Z0-9-]{1,64}$",
                description: "\"local\", or a server ID from servers_list" };
        }
        for (const child of Object.values(node)) {
            visit(child);
        }
    };
    visit(schema);
    return schema as { type: "object" };
}

/** What the audit says a call was about, as far as it can be trusted */
interface AuditTarget {
    server_id? : string;
    stack_id? : string;
    request_id? : string;
    action? : string;
}

/**
 * Read back what a call was about, for the audit log.
 *
 * Only values this server recognises are recorded: an identifier the caller invented is
 * not written down as if the panel had confirmed it. An operation identifier is the
 * exception, because the stored operation itself says what it was about.
 * @param identity Who called
 * @param args Arguments of the call
 * @param value What the tool answered
 * @returns Fields the audit log may keep
 */
async function auditTarget(identity : MachineIdentity, args : Record<string, unknown>, value : unknown) : Promise<AuditTarget> {
    const metadata = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const parameters = args.parameters && typeof args.parameters === "object" ? args.parameters as Record<string, unknown> : args;
    const serverId = metadata.server_id ?? parameters.server_id;
    const stackId = metadata.stack_id ?? parameters.stack_id;

    if (typeof args.operation_id === "string") {
        const operation = await Database.getKnex()("mcp_operation").where({ id: args.operation_id,
            key_id: identity.keyId }).first();

        if (operation) {
            return { server_id: operation.server_id,
                stack_id: operation.stack_id,
                request_id: operation.request_id,
                action: operation.action };
        }
    }
    return {
        ...(typeof serverId === "string" && identity.servers.includes(serverId) ? { server_id: serverId } : {}),
        ...(typeof stackId === "string" && /^[a-f0-9-]{36}$/.test(stackId) ? { stack_id: stackId } : {}),
        ...(typeof args.request_id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(args.request_id) ? { request_id: args.request_id } : {}),
        ...(typeof metadata.action === "string" && /^[a-z_]{1,64}$/.test(metadata.action) ? { action: metadata.action } : {}),
    };
}

/**
 * Why a key was not accepted, for the owner's log only. The caller always gets the same
 * 401, so the difference tells a guesser nothing.
 * @param header Authorization header as sent
 * @returns Reason slug, and the key when it is certain which key was meant
 */
async function keyRefusal(header : string | undefined) : Promise<{ reason : string; keyId? : string }> {
    if (!header) {
        return { reason: "missing_key" };
    }
    const secret = parseBearer(header);
    const match = secret ? /^dg2?_([a-f0-9]{32})\./.exec(secret) : null;
    if (!secret || !match) {
        return { reason: "invalid_key" };
    }
    const row = await Database.getKnex()("mcp_key").where({ id: match[1] }).first();
    if (!row || row.secret_hash !== hashKey(secret)) {
        return { reason: "invalid_key" };
    }
    if (row.revoked_at !== null) {
        return { reason: "revoked_key",
            keyId: row.id };
    }
    if (Number(row.expires_at) <= Date.now()) {
        return { reason: "expired_key",
            keyId: row.id };
    }
    return { reason: "key_unusable",
        keyId: row.id };
}

/**
 * What the client said about itself in this request: in `initialize` for a 2025 client,
 * in the per-request envelope for a 2026 client.
 * @param request Parsed request
 * @returns The announcement, cleaned, or undefined
 */
function announcedClient(request : Request) : McpClientInfo | undefined {
    const body = request.body && typeof request.body === "object" ? request.body as { method? : unknown; params? : Record<string, unknown> } : {};
    const params = body.params && typeof body.params === "object" ? body.params : {};
    const meta = params._meta && typeof params._meta === "object" ? params._meta as Record<string, unknown> : {};
    const info = (body.method === "initialize" ? params.clientInfo : meta[CLIENT_INFO_META_KEY]) as { name? : unknown; version? : unknown } | undefined;
    const protocol = body.method === "initialize" ? params.protocolVersion : request.headers["mcp-protocol-version"] ?? meta[PROTOCOL_VERSION_META_KEY];
    const announced = { name: auditText(info?.name),
        version: auditText(info?.version, 32),
        protocol: auditText(protocol, 16) };
    return announced.name || announced.protocol ? announced : undefined;
}

/** Per-request state handed to the SDK server instance */
interface CallContext {
    identity : MachineIdentity;
    secret : string;
    address : string;
    client : McpClientInfo;
    toolCalled : boolean;
}

export function mountMcp(server : DockgeServer) {
    let operations : McpOperations | undefined;
    let filesGit : ReturnType<typeof registerMcpFilesGit> | undefined;
    const getOperations = () => {
        if (!operations) {
            operations = createMcpOperations(server);
            filesGit = registerMcpFilesGit(server, operations);
        }
        return operations;
    };
    const delegated = new DelegatedInvocation();
    let remoteOperations : McpOperations | undefined;
    let remoteFilesGit : ReturnType<typeof registerMcpFilesGit> | undefined;
    const remoteRegistry = () => {
        if (!remoteOperations) {
            remoteOperations = createMcpOperations(server, delegated.refresh);
            remoteFilesGit = registerMcpFilesGit(server, remoteOperations, delegated.refresh);
        }
        return remoteOperations;
    };
    const auditedPeerCall = async (identity : MachineIdentity, action : string, args : unknown, execute : () => Promise<unknown>) => {
        const started = Date.now();
        let outcome : McpAuditOutcome = "denied";
        let reason : string | null = null;
        let result : unknown;
        try {
            result = await execute();
            outcome = "allowed";
            return result;
        } catch (error) {
            outcome = error instanceof z.ZodError ? "invalid" : "denied";
            reason = auditReason(error);
            throw error;
        } finally {
            const input = args as Record<string, unknown>;
            const parameters = input?.parameters && typeof input.parameters === "object" ? input.parameters as Record<string, unknown> : input;
            const metadata = result && typeof result === "object" ? result as Record<string, unknown> : {};
            const stackId = metadata.stack_id ?? parameters?.stack_id;
            await recordMcpAudit({ key_id: identity.keyId,
                tool: MCP_TOOL_ORDER.includes(action) ? action : "unknown",
                server_id: "local",
                ...(typeof stackId === "string" && /^[a-f0-9-]{36}$/.test(stackId) ? { stack_id: stackId } : {}),
                outcome,
                reason,
                detail: "delegated",
                duration_ms: Date.now() - started });
        }
    };
    server.app.use(createDelegationRouter({
        getConfig: async () => (await Settings.get("mcpConfig"))?.enabled ? loadDelegationConfig() : null,
        resolveIdentity: (keyId) => revalidateMcpIdentity(keyId).catch(() => null),
        authorizePeer: async (peer) => {
            const user = await Database.getKnex()("user").where({ id: peer.ownerId,
                suspended: 0 }).first();
            return Boolean((await Settings.get("mcpConfig"))?.enabled && user && (peer.role === "viewer" || [ "admin", "operator" ].includes(user.role)));
        },
        read: (identity, action, args) => {
            const effective = { ...identity,
                actions: identity.actions ?? [],
                mode: identity.mode ?? "readonly" };
            return auditedPeerCall(effective, action, args, () => readMcpTool(server, effective, action, args));
        },
        operationTarget: async (subjectId, operationId) => {
            const row = await Database.getKnex()("mcp_operation").where({ id: operationId,
                key_id: subjectId }).first();
            return row ? { action: row.action,
                stackId: row.stack_id,
                additionalActions: row.action === "git_apply" && row.summary === "git_apply_and_deploy" ? [ "stack_deploy" ] : [] } : null;
        },
        dispatch: async (identity, action, args, refresh) => {
            const effective = { ...identity,
                actions: identity.actions ?? [],
                mode: identity.mode ?? "readonly" };
            return auditedPeerCall(effective, action, args, () => delegated.run(effective, async () => {
                const current = await refresh();
                return { ...current,
                    actions: current.actions ?? [],
                    mode: current.mode ?? "readonly" };
            }, async () => {
                const registry = remoteRegistry();
                if (action === "container_logs") {
                    return readMcpContainerLogs(server, effective, args, delegated.refresh);
                }
                if (action === "stack_files_read" || action === "git_preview_result") {
                    return remoteFilesGit!.call(effective, action, args);
                }
                return registry.call(effective, action, args);
            }));
        },
    }));
    const dispatch = async (identity : MachineIdentity, name : string, input : unknown) => {
        const args = input as { server_id? : unknown; parameters? : { server_id? : unknown } } | null;
        const targetServer = args?.server_id ?? (name === "operation_prepare" ? args?.parameters?.server_id : undefined);
        if (targetServer !== undefined && targetServer !== "local") {
            const config = await loadDelegationConfig();
            if (!config || typeof targetServer !== "string" || !identity.servers.includes(targetServer)) {
                throw new Error("mcpPermissionDenied");
            }
            return callDelegatedTool(config, targetServer, identity, name, { ...args,
                server_id: targetServer });
        }
        if (name === "container_logs") {
            return readMcpContainerLogs(server, identity, input);
        }
        if (name === "stack_files_read" || name === "git_preview_result") {
            getOperations();
            return filesGit!.call(identity, name, input);
        }
        if (name.startsWith("operation_")) {
            const localInput = { ...(input as Record<string, unknown>) };
            delete localInput.server_id;
            return getOperations().call(identity, name, localInput);
        }
        if (name === "servers_list") {
            inputSchemas.servers_list.parse(input);
            const peers = publicDelegationPeers(await loadDelegationConfig()).filter(peer => identity.servers.includes(peer.id));
            return { servers: [ ...(identity.servers.includes("local") ? [{ id: "local",
                name: "Local" }] : []), ...peers.map(peer => ({ id: peer.id,
                name: peer.name })) ] };
        }
        return readMcpTool(server, identity, name, input);
    };

    // The database connects after the routes are mounted, so every use asks for it anew
    const keys = () => new McpKeys(Database.getKnex());

    /** Tools the key may call right now, in a fixed order; nothing else is listed. */
    const listTools = async (context : CallContext) => {
        const identity = await keys().authenticate(context.secret);
        getOperations();
        const tools = new Map<string, ReturnType<typeof toolDefinition>>();
        for (const name of MCP_READ_TOOLS.filter((item) => permittedTool(identity.role, item))) {
            tools.set(name, toolDefinition(name, z.toJSONSchema(name === "servers_list" ? inputSchemas[name] : inputSchemas[name].extend({ server_id: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/) }))));
        }
        if (identity.role === "operator" && identity.mode !== "readonly") {
            for (const tool of filesGit!.toolDefinitions.filter(item => identity.actions.includes(item.permission))) {
                tools.set(tool.name, toolDefinition(tool.name, publicToolSchema(tool.inputSchema)));
            }
            if (identity.actions.includes("logs:read")) {
                tools.set("container_logs", toolDefinition("container_logs", publicToolSchema(z.toJSONSchema(containerLogsSchema))));
            }
            // Git and deployment reach a remote repository or an image registry
            const reachesOut = identity.actions.some(action => [ "git:read", "git:apply", "deploy" ].includes(action));
            for (const tool of getOperations().getToolDefinitions(identity)) {
                tools.set(tool.name, toolDefinition(tool.name, publicToolSchema(tool.inputSchema), tool.name === "operation_apply" && reachesOut));
            }
        }
        return MCP_TOOL_ORDER.filter(name => tools.has(name)).map(name => tools.get(name)!);
    };

    const callTool = async (context : CallContext, name : string, args : Record<string, unknown>) => {
        const started = Date.now();
        let outcome : McpAuditOutcome = "denied";
        let reason : string | null = null;
        let target : AuditTarget = {};
        context.toolCalled = true;
        try {
            const identity = await keys().authenticate(context.secret);
            const value = await dispatch(identity, name, args);

            target = await auditTarget(identity, args, value);
            // Revocation during a slow read also suppresses delivery of its result.
            const fresh = await revalidateMcpIdentity(identity.keyId);
            if (fresh.policyVersion !== identity.policyVersion || fresh.role !== identity.role || fresh.userId !== identity.userId || JSON.stringify(fresh.resources) !== JSON.stringify(identity.resources) || JSON.stringify(fresh.actions) !== JSON.stringify(identity.actions) || fresh.mode !== identity.mode) {
                throw new Error("mcpPermissionDenied");
            }
            const text = JSON.stringify(value);
            if (Buffer.byteLength(text) > 256 * 1024) {
                throw new Error("mcpResponseTooLarge");
            }
            outcome = "allowed";
            return { content: [{ type: "text" as const,
                text }] };
        } catch (error) {
            outcome = error instanceof z.ZodError ? "invalid" : "denied";
            reason = auditReason(error);
            if (!Object.keys(target).length) {
                target = await auditTarget(context.identity, args, undefined).catch(() => ({}));
            }
            // A refused call names a stack only when the key could see it
            if (target.stack_id && !context.identity.stacks.includes(target.stack_id)) {
                delete target.stack_id;
            }
            return { isError: true,
                content: [{ type: "text" as const,
                    text: failureMessage(error) }] };
        } finally {
            await recordMcpAudit({ key_id: context.identity.keyId,
                tool: MCP_TOOL_ORDER.includes(name) ? name : "unknown",
                ...target,
                outcome,
                reason,
                client_name: context.client.name,
                client_version: context.client.version,
                protocol_version: context.client.protocol,
                address: context.address,
                duration_ms: Date.now() - started });
        }
    };

    // One SDK instance per request: no protocol session outlives the HTTP exchange
    const handler = createMcpHandler(({ authInfo }) => {
        const context = authInfo?.extra?.context as CallContext | undefined;
        if (!context) {
            throw new Error("mcpUnauthorized");
        }
        const sdk = new Server({ name: "dockge2",
            title: "Dockge2",
            version: packageJSON.version }, { capabilities: { tools: {} },
            instructions: MCP_INSTRUCTIONS });
        sdk.setRequestHandler("tools/list", async () => ({ tools: await listTools(context) }));
        sdk.setRequestHandler("tools/call", async (request) => callTool(context, request.params.name, request.params.arguments ?? {}));
        return sdk;
    }, { legacy: "stateless",
        responseMode: "auto",
        maxRequestBodySize: 2 * 1024 * 1024,
        onerror: (error) => log.debug("mcp", error.message) });

    /**
     * Hand an Express request to the SDK's web-standard handler and stream its answer back.
     * @param request Parsed Express request
     * @param response Express response
     * @param endpoint The configured address, used instead of the Host header
     * @param authInfo Who the request authenticated as
     * @returns HTTP status of the answer
     */
    const serve = async (request : Request, response : Response, endpoint : URL, authInfo : AuthInfo) : Promise<number> => {
        const headers = new Headers();
        for (const [ name, value ] of Object.entries(request.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [ value ]) {
                headers.append(name, item);
            }
        }
        const controller = new AbortController();
        response.once("close", () => controller.abort());
        const answer = await handler.fetch(new globalThis.Request(endpoint, { method: "POST",
            headers,
            signal: controller.signal }), { authInfo,
            parsedBody: request.body });
        response.status(answer.status);
        answer.headers.forEach((value, name) => response.setHeader(name, value));
        if (answer.body) {
            Readable.fromWeb(answer.body as never).on("error", () => response.destroy()).pipe(response);
        } else {
            response.end();
        }
        return answer.status;
    };

    const router = express.Router();

    // Without an authorization server there is nothing to discover: answer plainly instead of the SPA page
    router.get(/^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/.*)?$/, (_request, response) => {
        response.status(404).json({ error: "not_found" });
    });

    const refuse = (request : Request, reason : string, extra : { keyId? : string | undefined; detail? : string | undefined } = {}) => {
        const address = resolveRequestAddress(request);
        recordMcpRepeated(`${address}|${reason}|${extra.keyId ?? ""}|${extra.detail ?? ""}`, { tool: "request",
            outcome: "refused",
            reason,
            key_id: extra.keyId ?? null,
            address,
            detail: extra.detail ?? null });
    };

    const buckets = new Map<string, { at : number; count : number; active : number }>();
    // Bounding the address map also bounds unauthenticated resource consumption.
    const limit = (request : Request, response : Response, next : NextFunction) => {
        const now = Date.now();
        for (const [ key, item ] of buckets) {
            if (now - item.at > 60_000 && !item.active) {
                buckets.delete(key);
            }
        }
        const address = resolveRequestAddress(request);
        const item = buckets.get(address) ?? { at: now,
            count: 0,
            active: 0 };
        if (buckets.size >= 1000 && !buckets.has(address) || item.count >= 60 || item.active >= 4) {
            if (request.baseUrl === "/mcp") {
                refuse(request, "rate_limited");
            }
            response.setHeader("Retry-After", "60");
            response.sendStatus(429);
            return;
        }
        item.count++;
        item.active++;
        buckets.set(address, item);
        response.once("close", () => item.active--);
        next();
    };
    router.use([ "/mcp", "/api/mcp" ], limit);
    router.use([ "/mcp", "/api/mcp" ], (_request, response, next) => {
        response.setHeader("Cache-Control", "no-store");
        next();
    });

    router.use("/api/mcp", (request, response, next) => {
        const origin = request.headers.origin;
        const trusted = resolveTrustedOrigins(server, { host: request.headers.host,
            forwardedHost: [ request.headers["x-forwarded-host"] ].flat()[0],
            forwardedProto: [ request.headers["x-forwarded-proto"] ].flat()[0] });
        const allowed = origin ? trusted.includes(origin) : request.method === "GET";
        if (!allowed) {
            response.sendStatus(403);
            return;
        }
        response.setHeader("Vary", "Origin");
        if (origin) {
            response.setHeader("Access-Control-Allow-Origin", origin);
        }
        response.setHeader("Access-Control-Allow-Credentials", "true");
        if (request.method === "OPTIONS") {
            response.setHeader("Access-Control-Allow-Methods", "GET, POST");
            response.setHeader("Access-Control-Allow-Headers", "content-type");
            response.sendStatus(204);
            return;
        }
        void (async () => {
            // A real better-auth session is mandatory even when browser auth was disabled.
            const session = await getSessionFromHeaders(request.headers);
            const user = session?.user && await Database.getKnex()("user").where({ id: session.user.id,
                role: "admin",
                suspended: 0 }).first();
            if (!user) {
                response.sendStatus(403);
                return;
            }
            response.locals.ownerId = user.id;
            next();
        })().catch(next);
    });
    router.use("/api/mcp", express.json({ limit: "16kb" }));
    router.get("/api/mcp", async (_request, response, next) => {
        try {
            const knex = Database.getKnex();
            await flushMcpAudit();
            const peers = publicDelegationPeers(await loadDelegationConfig());
            const stored = await Settings.get("mcpConfig") as Partial<McpConfig> | null;
            response.json({ peers,
                pending: await getOperations().listPending(),
                config: { enabled: Boolean(stored?.enabled),
                    url: stored?.url ?? (process.env.DOCKGE_PUBLIC_URL ? process.env.DOCKGE_PUBLIC_URL.replace(/\/$/, "") + "/mcp" : ""),
                    allowInsecureHttp: Boolean(stored?.allowInsecureHttp),
                    configured: Boolean(stored?.url) },
                keys: await keys().list(),
                stacks: await synchronizeStackIdentities(knex, server),
                users: await knex("user").where({ suspended: 0 }).select("id", "name"),
                status: {
                    lastConnection: await knex("mcp_audit").whereIn("tool", [ ...CONNECTION_METHODS, ...MCP_TOOL_ORDER ]).where({ outcome: "allowed" }).orderBy("at", "desc").first() ?? null,
                    lastRefusal: await knex("mcp_audit").where({ outcome: "refused" }).orderBy("at", "desc").first() ?? null,
                },
                audit: await knex("mcp_audit").orderBy("at", "desc").orderBy("id", "desc").limit(100) });
        } catch (error) {
            next(error);
        }
    });
    router.post("/api/mcp/:action", async (request, response, next) => {
        try {
            const envelope = z.object({ password: z.string().min(1).max(128),
                data: z.unknown() }).strict().parse(request.body);
            if (!await verifyAccountPassword(response.locals.ownerId, envelope.password)) {
                response.status(403).json({ error: "mcpWrongPassword" });
                return;
            }
            if (request.params.action === "config") {
                const config = configSchema.parse(envelope.data);
                validateMcpURL(config.url, config.allowInsecureHttp);
                await Settings.set("mcpConfig", config, "internal");
                await recordMcpAudit({ tool: "config_update",
                    outcome: "allowed",
                    detail: config.enabled ? "enabled" : "disabled" });
                response.json({ ok: true,
                    config });
            } else if (request.params.action === "issue") {
                await synchronizeStackIdentities(Database.getKnex(), server);
                const peers = publicDelegationPeers(await loadDelegationConfig());
                response.json(await keys().issue(envelope.data, Object.fromEntries(peers.map(peer => [ peer.id, peer.stacks ]))));
            } else if (request.params.action === "reduce") {
                const { id, value } = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/),
                    value: z.unknown() }).strict().parse(envelope.data);
                await keys().reduce(id, value);
                response.json({ ok: true });
            } else if (request.params.action === "reserve") {
                const { name } = z.object({ name: z.string().min(1).max(64) }).strict().parse(envelope.data);
                response.json(await reserveMcpStack(server, name));
            } else if (request.params.action === "unreserve") {
                const { id } = z.object({ id: z.string().uuid() }).strict().parse(envelope.data);
                await unreserveMcpStack(id);
                response.json({ ok: true });
            } else if (request.params.action === "review") {
                const { id } = z.object({ id: z.string().uuid() }).strict().parse(envelope.data);
                let value;
                try {
                    value = await getOperations().review(response.locals.ownerId, id);
                } catch {
                    value = await remoteRegistry().review(response.locals.ownerId, id);
                }
                response.json(value);
            } else if (request.params.action === "approve") {
                const { id } = z.object({ id: z.string().uuid() }).strict().parse(envelope.data);
                await getOperations().approve(response.locals.ownerId, id);
                const operation = await Database.getKnex()("mcp_operation").where({ id }).first("key_id", "action", "server_id", "stack_id", "request_id");
                await recordMcpAudit({ tool: "operation_approve",
                    outcome: "allowed",
                    key_id: operation?.key_id ?? null,
                    action: operation?.action,
                    server_id: operation?.server_id,
                    stack_id: operation?.stack_id,
                    request_id: operation?.request_id });
                response.json({ ok: true });
            } else if (request.params.action === "revoke") {
                const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).strict().parse(envelope.data);
                await keys().revoke(id);
                response.json({ ok: true });
            } else {
                response.sendStatus(404);
            }
        } catch (error) {
            next(error);
        }
    });

    // Authenticate and check DNS rebinding BEFORE parsing a body or constructing SDK state.
    router.use("/mcp", async (request, response, next) => {
        try {
            const config = await Settings.get("mcpConfig") as Partial<McpConfig> | null;
            if (!config?.enabled || typeof config.url !== "string") {
                response.sendStatus(404);
                return;
            }
            const url = validateMcpURL(config.url, config.allowInsecureHttp);
            const forwardedHost = trustsProxyHeaders() ? [ request.headers["x-forwarded-host"] ].flat()[0]?.split(",")[0]?.trim() : undefined;
            if (!sameHost(request.headers.host, url) && !sameHost(forwardedHost, url)) {
                refuse(request, "host_mismatch", { detail: forwardedHost || request.headers.host });
                response.sendStatus(403);
                return;
            }
            if (request.headers.origin && request.headers.origin !== url.origin) {
                refuse(request, "origin_mismatch", { detail: request.headers.origin });
                response.sendStatus(403);
                return;
            }
            // Never write a query down: it is where a misconfigured client would put its key
            if (Object.keys(request.query).length > 0) {
                refuse(request, "query_rejected");
                response.sendStatus(403);
                return;
            }
            const secret = parseBearer(request.headers.authorization);
            let identity : MachineIdentity;
            try {
                identity = await keys().authenticate(secret);
            } catch {
                const refusal = await keyRefusal(request.headers.authorization);
                refuse(request, refusal.reason, { keyId: refusal.keyId });
                response.setHeader("WWW-Authenticate", "Bearer");
                response.sendStatus(401);
                return;
            }
            response.locals.machine = identity;
            response.locals.secret = secret;
            response.locals.endpoint = url;
            next();
        } catch (error) {
            next(error);
        }
    });
    router.use("/mcp", express.json({ limit: "2mb" }));
    /**
     * Who is calling, and with which client. A 2025 client names itself only in
     * `initialize`, so later requests of the same key reuse that announcement.
     * @param request Authenticated request
     * @param identity Key it authenticated as
     * @param secret The key itself, passed on to the SDK only
     * @returns Context for this request
     */
    const callContext = (request : Request, identity : MachineIdentity, secret : string) : CallContext => {
        const announced = announcedClient(request);
        if (announced?.name) {
            rememberClient(identity.keyId, announced);
        }
        const recalled = recalledClient(identity.keyId);
        return { identity,
            secret,
            address: resolveRequestAddress(request),
            client: announced?.name ? announced : { name: recalled?.name ?? null,
                version: recalled?.version ?? null,
                protocol: announced?.protocol ?? recalled?.protocol ?? null },
            toolCalled: false };
    };

    /**
     * Log a connection or tool listing, and a tool call the SDK refused before it
     * reached `callTool`, which logs every call it runs itself.
     * @param context Request context
     * @param body Parsed JSON-RPC request
     * @param status HTTP status of the answer
     * @returns {void}
     */
    const recordExchange = (context : CallContext, body : { method? : unknown; params? : { name? : unknown } } | undefined, status : number) => {
        const method = typeof body?.method === "string" ? body.method : "";
        if (!CONNECTION_METHODS.includes(method) && (method !== "tools/call" || context.toolCalled)) {
            return;
        }
        const tool = method === "tools/call" ? String(body?.params?.name) : method;
        const ok = status < 400 && method !== "tools/call";
        const { client } = context;
        recordMcpRepeated(`${context.identity.keyId}|${method}|${client.name}|${client.version}|${client.protocol}|${ok}`, { tool: MCP_TOOL_ORDER.includes(tool) || CONNECTION_METHODS.includes(tool) ? tool : "unknown",
            outcome: ok ? "allowed" : "invalid",
            reason: ok ? null : "protocol_error",
            key_id: context.identity.keyId,
            client_name: client.name,
            client_version: client.version,
            protocol_version: client.protocol,
            address: context.address });
    };

    router.post("/mcp", async (request, response, next) => {
        const identity = response.locals.machine as MachineIdentity;
        const context = callContext(request, identity, response.locals.secret);
        try {
            const status = await serve(request, response, response.locals.endpoint, { token: context.secret,
                clientId: identity.keyId,
                scopes: [],
                extra: { context } });
            recordExchange(context, request.body, status);
        } catch (error) {
            next(error);
        }
    });
    router.all([ "/mcp", "/mcp/*" ], (_request, response) => {
        response.setHeader("Allow", "POST");
        response.sendStatus(405);
    });
    router.use((error : { type? : string; message? : string }, request : Request, response : Response, _next : NextFunction) => {
        if (response.headersSent) {
            return;
        }
        const status = error.type === "entity.too.large" ? 413 : 400;
        if (request.path === "/mcp" || request.path.startsWith("/mcp/")) {
            const parse = error.type === "entity.parse.failed";
            response.status(status === 413 ? 413 : parse ? 400 : 500).json({ jsonrpc: "2.0",
                id: null,
                error: status === 413 ? { code: -32600,
                    message: "Request body too large" } : parse ? { code: -32700,
                    message: "Parse error" } : { code: -32603,
                    message: "Internal error" } });
            return;
        }
        const code = error instanceof z.ZodError ? "mcpInvalidRequest" : typeof error.message === "string" && /^mcp[A-Z][A-Za-z]{1,60}$/.test(error.message) ? error.message : "mcpRequestFailed";
        response.status(status).json({ error: code });
    });
    server.app.use(router);
}
