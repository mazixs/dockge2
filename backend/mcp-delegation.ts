import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import express from "express";
import { z } from "zod";
import { MCP_READ_TOOLS } from "./mcp-policy";
import { delegatedSubjectId } from "./mcp-delegated-operations";

const MAX_BYTES = 256 * 1024;
const TTL = 15_000;
const APPLY_TTL = 150_000;
const remotePermissions: Record<string, string> = {
    stack_start: "stacks:control",
    stack_stop: "stacks:control",
    stack_restart: "stacks:control",
    container_start: "containers:control",
    container_stop: "containers:control",
    container_restart: "containers:control",
    container_logs: "logs:read",
    stack_files_read: "files:read",
    stack_files_write: "files:write",
    git_preview: "git:read",
    git_preview_result: "git:read",
    git_apply: "git:apply",
    stack_deploy: "deploy",
    stack_images_update: "deploy",
    git_clone: "deploy",
};
const remoteTools = [ ...MCP_READ_TOOLS, "container_logs", "stack_files_read", "git_preview_result", "operation_prepare", "operation_apply", "operation_status" ] as const;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const peerSchema = z.object({ id,
    name: z.string().min(1).max(80),
    url: z.string().url(),
    publicKey: z.string().max(4096),
    allowedStackIds: z.array(z.string().uuid()).min(1).max(100),
    actions: z.array(z.string().min(1).max(64)).max(30),
    role: z.enum([ "viewer", "operator" ]),
    ownerId: z.string().min(1).max(128) }).strict();
const configSchema = z.object({ serverId: id,
    privateKey: z.string().max(4096),
    peers: z.array(peerSchema).max(50) }).strict();
export type DelegationConfig = z.infer<typeof configSchema>;
export type DelegationPeer = z.infer<typeof peerSchema>;

const identitySchema = z.object({ keyId: z.string().regex(/^[a-f0-9]{32}$/),
    userId: z.string().min(1).max(128),
    role: z.enum([ "viewer", "operator" ]),
    servers: z.array(id).min(1).max(50),
    stacks: z.array(z.string().uuid()).min(1).max(100),
    resources: z.record(id, z.array(z.string().uuid()).max(100)),
    policyVersion: z.number().int().positive(),
    actions: z.array(z.string().max(64)).max(30).optional(),
    mode: z.enum([ "readonly", "automatic", "approval" ]).optional() }).strict();
export type DelegatedIdentity = z.infer<typeof identitySchema>;
const argsSchema = z.object({ server_id: id,
    stack_id: z.string().uuid().optional(),
    container_id: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    window_hours: z.union([ z.literal(24), z.literal(168), z.literal(720) ]).optional() }).strict();
const readSchema = z.object({ kind: z.literal("read"),
    issuer: id,
    audience: id,
    requestId: z.string().uuid(),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
    identity: identitySchema,
    action: z.enum(remoteTools),
    args: z.record(z.string(), z.unknown()) }).strict();
type Assertion = z.infer<typeof readSchema>;
const validationSchema = z.object({ kind: z.literal("validate"),
    issuer: id,
    audience: id,
    requestId: z.string().uuid(),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
    assertion: readSchema,
    operationTarget: z.object({ action: z.string().max(64),
        stackId: z.string().uuid(),
        additionalActions: z.array(z.string().max(64)).max(10).optional() }).strict().optional() }).strict();

/** A file provisioned by the host owner keeps private peer keys out of browser settings. */
export async function loadDelegationConfig(path = process.env.DOCKGE_MCP_DELEGATION_CONFIG) : Promise<DelegationConfig | null> {
    if (!path) {
        return null;
    }
    const info = await stat(path);
    if (!info.isFile() || info.size > 128 * 1024 || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
        throw new Error("mcpDelegationConfigurationDenied");
    }
    const config = configSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (new Set(config.peers.map(peer => peer.id)).size !== config.peers.length || config.peers.some(peer => peer.id === config.serverId)) {
        throw new Error("mcpDelegationConfigurationDenied");
    }
    if (createPrivateKey(config.privateKey).asymmetricKeyType !== "ed25519") {
        throw new Error("mcpDelegationConfigurationDenied");
    }
    for (const peer of config.peers) {
        peerURL(peer.url);
        if (createPublicKey(peer.publicKey).asymmetricKeyType !== "ed25519") {
            throw new Error("mcpDelegationConfigurationDenied");
        }
    }
    return config;
}

/** Public catalog has explicit resources and never includes keys or account identifiers. */
export function publicDelegationPeers(config : DelegationConfig | null) {
    return config?.peers.map(peer => ({ id: peer.id,
        name: peer.name,
        stacks: peer.allowedStackIds })) ?? [];
}

function peerURL(value : string) {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && [ "127.0.0.1", "[::1]", "localhost" ].includes(url.hostname)))) {
        throw new Error("mcpDelegationDenied");
    }
    return url;
}

function current(envelope : { issuedAt : number; expiresAt : number; action? : string }) {
    const now = Date.now();
    return envelope.issuedAt <= now + 1000 && envelope.expiresAt > now && envelope.expiresAt - envelope.issuedAt > 0 && envelope.expiresAt - envelope.issuedAt <= (envelope.action === "operation_apply" ? APPLY_TTL : TTL);
}

function allowed(assertion : Assertion, peer : DelegationPeer) {
    const subject = assertion.identity;
    const args = assertion.args;
    if (!current(assertion) || !subject.servers.includes(assertion.audience)
        || !subject.stacks.every(stack => peer.allowedStackIds.includes(stack) && subject.resources[assertion.audience]?.includes(stack))
        || !peer.actions.includes(assertion.action) || args.server_id !== assertion.audience) {
        return false;
    }
    if ((MCP_READ_TOOLS as readonly string[]).includes(assertion.action)) {
        const parsed = argsSchema.safeParse(args);
        return parsed.success && (!parsed.data.stack_id || subject.stacks.includes(parsed.data.stack_id))
            && ([ "servers_list", "stacks_list" ].includes(assertion.action) || Boolean(parsed.data.stack_id))
            && (assertion.action !== "container_status" || Boolean(parsed.data.container_id))
            && (assertion.action === "container_status" || !parsed.data.container_id)
            && (assertion.action === "stability_get" || parsed.data.window_hours === undefined);
    }
    if (subject.role !== "operator" || peer.role !== "operator" || subject.mode === "readonly") {
        return false;
    }
    if (assertion.action === "operation_apply" || assertion.action === "operation_status") {
        // Ownership, stored permission, hash and approval are checked by the ordinary durable registry.
        return Object.keys(args).every(key => [ "server_id", "operation_id", ...(assertion.action === "operation_apply" ? [ "parameters_hash" ] : []) ].includes(key))
            && z.string().uuid().safeParse(args.operation_id).success;
    }
    const action = assertion.action === "operation_prepare" ? args.action : assertion.action;
    const parameters = assertion.action === "operation_prepare" ? args.parameters : args;
    if (typeof action !== "string" || !peer.actions.includes(action) || !remotePermissions[action] || !subject.actions?.includes(remotePermissions[action]!) || !parameters || typeof parameters !== "object") {
        return false;
    }
    const target = parameters as Record<string, unknown>;
    if (action === "git_apply" && target.deploy === true && (!peer.actions.includes("stack_deploy") || !subject.actions?.includes("deploy"))) {
        return false;
    }
    return target.server_id === assertion.audience && typeof target.stack_id === "string" && subject.stacks.includes(target.stack_id)
        && (assertion.action !== "operation_prepare" || Object.keys(args).every(key => [ "server_id", "action", "request_id", "parameters" ].includes(key)));
}

function identityStillAllows(currentIdentity : DelegatedIdentity | null, assertion : Assertion) {
    const original = assertion.identity;
    return currentIdentity && currentIdentity.keyId === original.keyId && currentIdentity.userId === original.userId
        && currentIdentity.policyVersion === original.policyVersion
        && currentIdentity.role === original.role && currentIdentity.mode === original.mode
        && (original.actions ?? []).every(action => currentIdentity.actions?.includes(action))
        && currentIdentity.servers.includes(assertion.audience)
        && original.stacks.every(stack => currentIdentity.resources[assertion.audience]?.includes(stack));
}

async function signedPost(config : DelegationConfig, peer : DelegationPeer, path : "read" | "validate", value : unknown) {
    const body = JSON.stringify(value);
    const signature = sign(null, Buffer.from(body), config.privateKey).toString("base64url");
    const response = await fetch(new URL(`/internal/mcp-delegation/${path}`, peerURL(peer.url)), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(value && typeof value === "object" && "action" in value && value.action === "operation_apply" ? APPLY_TTL - 5000 : 5000),
        headers: { "content-type": "application/json",
            "x-dockge-signature": signature },
        body,
    });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("mcpDelegationDenied");
    }
    const reader = response.body.getReader();
    const chunks : Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
            break;
        }
        size += chunk.value.length;
        if (size > MAX_BYTES) {
            await reader.cancel();
            throw new Error("mcpDelegationDenied");
        }
        chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Only server-provisioned peers can be targeted; external Bearer secrets are never accepted. */
export async function callDelegatedTool(config : DelegationConfig, peerId : string, identity : DelegatedIdentity, action : string, args : unknown) {
    const peer = config.peers.find(item => item.id === peerId);
    if (!peer) {
        throw new Error("mcpDelegationDenied");
    }
    const now = Date.now();
    const assertion = readSchema.parse({ kind: "read",
        issuer: config.serverId,
        audience: peer.id,
        requestId: randomUUID(),
        issuedAt: now,
        expiresAt: now + (action === "operation_apply" ? APPLY_TTL : TTL),
        identity: { ...identity,
            stacks: (identity.resources[peer.id] ?? []).filter(stack => peer.allowedStackIds.includes(stack)),
            resources: { [peer.id]: (identity.resources[peer.id] ?? []).filter(stack => peer.allowedStackIds.includes(stack)) } },
        action,
        args });
    if (!allowed(assertion, peer)) {
        throw new Error("mcpDelegationDenied");
    }
    return signedPost(config, peer, "read", assertion);
}

/** Backward-compatible observer entrypoint, still denying mutations by name. */
export async function callDelegatedRead(config : DelegationConfig, peerId : string, identity : DelegatedIdentity, action : string, args : unknown) {
    if (!(MCP_READ_TOOLS as readonly string[]).includes(action)) {
        throw new Error("mcpDelegationDenied");
    }
    return callDelegatedTool(config, peerId, identity, action, args);
}

export interface DelegationServices {
    getConfig : () => Promise<DelegationConfig | null>;
    /** Resolve by public key ID using current database state, expiry and owner suspension. */
    resolveIdentity : (keyId : string) => Promise<DelegatedIdentity | null>;
    /** Check the receiver's responsible local account and enabled state, not the issuer's owner ID. */
    authorizePeer : (peer : DelegationPeer) => Promise<boolean>;
    /** Shared safe observation service, invoked only after both independent policy checks. */
    read : (identity : DelegatedIdentity, action : string, args : unknown) => Promise<unknown>;
    operationTarget? : (subjectId : string, operationId : string) => Promise<{ action : string; stackId : string; additionalActions? : string[] } | null>;
    dispatch? : (identity : DelegatedIdentity, action : string, args : unknown, refresh : () => Promise<DelegatedIdentity>) => Promise<unknown>;
}

/** Independently authorized, replay-protected peer channel; never uses browser agent sessions. */
export function createDelegationRouter(services : DelegationServices) {
    const router = express.Router();
    const seen = new Map<string, number>();
    let active = 0;
    router.use("/internal/mcp-delegation", (_request, response, next) => {
        if (active >= 4) {
            response.sendStatus(429);
            return;
        }
        active++;
        response.once("close", () => active--);
        response.setHeader("Cache-Control", "no-store");
        next();
    });
    router.post("/internal/mcp-delegation/:operation", express.raw({ type: "application/json",
        limit: "32kb" }), async (request, response) => {
        try {
            const config = await services.getConfig();
            if (!config || request.headers.authorization || request.headers.cookie || request.headers.origin || Object.keys(request.query).length) {
                throw new Error("denied");
            }
            const body = request.body as Buffer;
            if (!Buffer.isBuffer(body)) {
                throw new Error("denied");
            }
            const raw = JSON.parse(body.toString("utf8"));
            const envelope = request.params.operation === "read" ? readSchema.parse(raw) : request.params.operation === "validate" ? validationSchema.parse(raw) : null;
            const peer = config.peers.find(item => item.id === envelope?.issuer);
            const signature = request.headers["x-dockge-signature"];
            if (!envelope || !peer || typeof signature !== "string" || !/^[a-zA-Z0-9_-]{86}$/.test(signature) || !current(envelope) || envelope.audience !== config.serverId || !verify(null, body, peer.publicKey, Buffer.from(signature, "base64url")) || !await services.authorizePeer(peer)) {
                throw new Error("denied");
            }
            for (const [ key, expiry ] of seen) {
                if (expiry <= Date.now()) {
                    seen.delete(key);
                }
            }
            const nonce = `${peer.id}:${envelope.requestId}`;
            if (seen.has(nonce) || seen.size >= 1000) {
                throw new Error("denied");
            }
            seen.set(nonce, envelope.expiresAt);
            if (envelope.kind === "validate") {
                const original = envelope.assertion;
                if ([ "operation_apply", "operation_status" ].includes(original.action) && !envelope.operationTarget || original.issuer !== config.serverId || original.audience !== peer.id || !allowed(original, peer) || envelope.operationTarget && (!peer.actions.includes(envelope.operationTarget.action) || envelope.operationTarget.additionalActions?.some(action => !peer.actions.includes(action)) || !original.identity.stacks.includes(envelope.operationTarget.stackId)) || !identityStillAllows(await services.resolveIdentity(original.identity.keyId), original)) {
                    throw new Error("denied");
                }
                response.json({ valid: true });
                return;
            }
            const assertion = envelope;
            let operationTarget : { action : string; stackId : string; additionalActions? : string[] } | null = null;
            if ([ "operation_apply", "operation_status" ].includes(assertion.action)) {
                operationTarget = await services.operationTarget?.(delegatedSubjectId(assertion.issuer, assertion.identity.keyId), String(assertion.args.operation_id)) ?? null;
                if (!operationTarget) {
                    throw new Error("denied");
                }
            }
            const revalidate = async () => {
                const fresh = await services.getConfig();
                const trust = fresh?.peers.find(item => item.id === peer.id);
                if (!fresh || !trust || trust.publicKey !== peer.publicKey || fresh.serverId !== config.serverId || !allowed(assertion, trust) || operationTarget && (!trust.actions.includes(operationTarget.action) || operationTarget.additionalActions?.some(action => !trust.actions.includes(action)) || !trust.allowedStackIds.includes(operationTarget.stackId) || !assertion.identity.stacks.includes(operationTarget.stackId)) || !await services.authorizePeer(trust)) {
                    throw new Error("denied");
                }
                const now = Date.now();
                const verdict = await signedPost(fresh, trust, "validate", { kind: "validate",
                    issuer: fresh.serverId,
                    audience: trust.id,
                    requestId: randomUUID(),
                    issuedAt: now,
                    expiresAt: now + TTL,
                    assertion,
                    ...(operationTarget ? { operationTarget } : {}) }) as { valid? : boolean };
                if (verdict.valid !== true || !current(assertion)) {
                    throw new Error("denied");
                }
            };
            const observer = (MCP_READ_TOOLS as readonly string[]).includes(assertion.action);
            const effectiveIdentity = () : DelegatedIdentity => ({ ...assertion.identity,
                keyId: delegatedSubjectId(assertion.issuer, assertion.identity.keyId),
                role: observer ? "viewer" : "operator",
                servers: [ "local" ],
                stacks: assertion.identity.stacks,
                resources: { local: assertion.identity.stacks },
                actions: observer ? [] : assertion.identity.actions ?? [],
                mode: observer ? "readonly" : assertion.identity.mode ?? "readonly" });
            const refresh = async () => {
                await revalidate();
                return effectiveIdentity();
            };
            const localArgs = { ...assertion.args };
            if (assertion.action === "operation_prepare") {
                delete localArgs.server_id;
                localArgs.parameters = { ...(assertion.args.parameters as Record<string, unknown>),
                    server_id: "local" };
            } else if ([ "operation_apply", "operation_status" ].includes(assertion.action)) {
                delete localArgs.server_id;
            } else {
                localArgs.server_id = "local";
            }
            const effective = await refresh();
            const result = observer ? await services.read(effective, assertion.action, localArgs)
                : services.dispatch ? await services.dispatch(effective, assertion.action, localArgs, refresh) : (() => {
                    throw new Error("denied");
                })();
            await revalidate();
            const output = result && typeof result === "object" && "server_id" in result && result.server_id === "local" ? { ...result,
                server_id: assertion.audience } : result;
            const resultText = JSON.stringify(output);
            if (Buffer.byteLength(resultText) > MAX_BYTES) {
                throw new Error("denied");
            }
            response.type("application/json").send(resultText);
        } catch {
            response.status(403).json({ error: "mcpDelegationDenied" });
        }
    });
    router.use("/internal/mcp-delegation", (_request, response) => {
        response.sendStatus(405);
    });
    router.use((error : { type? : string }, _request : express.Request, response : express.Response, _next : express.NextFunction) => {
        if (!response.headersSent) {
            response.status(error.type === "entity.too.large" ? 413 : 403).json({ error: "mcpDelegationDenied" });
        }
    });
    return router;
}
