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

/**
 * Whether the envelope itself may be listened to at all.
 *
 * Nothing about the operation is looked at here: only that the assertion is still
 * current, was addressed to this server, and stays inside what both the caller and the
 * peer were granted.
 * @param assertion Signed request of the other panel
 * @param peer The panel it came from, as this one has it configured
 * @returns True when the envelope may be read further
 */
function allowedEnvelope(assertion : Assertion, peer : DelegationPeer) : boolean {
    const subject = assertion.identity;

    return current(assertion) && subject.servers.includes(assertion.audience)
        && subject.stacks.every(stack => peer.allowedStackIds.includes(stack) && subject.resources[assertion.audience]?.includes(stack))
        && peer.actions.includes(assertion.action) && assertion.args.server_id === assertion.audience;
}

/**
 * Whether a reading call stays within what was granted
 * @param assertion Signed request of the other panel
 * @returns True when the call may be answered
 */
function allowedRead(assertion : Assertion) : boolean {
    const parsed = argsSchema.safeParse(assertion.args);

    return parsed.success && (!parsed.data.stack_id || assertion.identity.stacks.includes(parsed.data.stack_id))
        && ([ "servers_list", "stacks_list" ].includes(assertion.action) || Boolean(parsed.data.stack_id))
        && (assertion.action !== "container_status" || Boolean(parsed.data.container_id))
        && (assertion.action === "container_status" || !parsed.data.container_id)
        && (assertion.action === "stability_get" || parsed.data.window_hours === undefined);
}

/**
 * Whether a call that names an existing operation carries nothing else.
 *
 * Ownership, stored permission, hash and approval are checked by the ordinary durable
 * registry, so the only question here is the shape of the reference.
 * @param assertion Signed request of the other panel
 * @returns True when the reference may be passed on
 */
function allowedOperationReference(assertion : Assertion) : boolean {
    const permitted = [ "server_id", "operation_id", ...(assertion.action === "operation_apply" ? [ "parameters_hash" ] : []) ];

    return Object.keys(assertion.args).every(key => permitted.includes(key))
        && z.string().uuid().safeParse(assertion.args.operation_id).success;
}

/**
 * Whether a writing call names a stack both sides granted, for an action both sides allow
 * @param assertion Signed request of the other panel
 * @param peer The panel it came from, as this one has it configured
 * @returns True when the write may be prepared
 */
function allowedWrite(assertion : Assertion, peer : DelegationPeer) : boolean {
    const subject = assertion.identity;
    const args = assertion.args;
    const preparing = assertion.action === "operation_prepare";
    const action = preparing ? args.action : assertion.action;
    const parameters = preparing ? args.parameters : args;

    if (typeof action !== "string" || !peer.actions.includes(action) || !remotePermissions[action] || !subject.actions?.includes(remotePermissions[action]!) || !parameters || typeof parameters !== "object") {
        return false;
    }
    const target = parameters as Record<string, unknown>;

    // Deploying is a separate permission: applying a git update may not smuggle it in
    if (action === "git_apply" && target.deploy === true && (!peer.actions.includes("stack_deploy") || !subject.actions?.includes("deploy"))) {
        return false;
    }
    return target.server_id === assertion.audience && typeof target.stack_id === "string" && subject.stacks.includes(target.stack_id)
        && (!preparing || Object.keys(args).every(key => [ "server_id", "action", "request_id", "parameters" ].includes(key)));
}

/**
 * Whether one signed request of another panel may be served.
 *
 * The order is the order of the questions: is the envelope current and addressed here,
 * is this a reading call, may this caller write at all, and only then what the write
 * would touch. Every step answers false on anything it does not recognise.
 * @param assertion Signed request of the other panel
 * @param peer The panel it came from, as this one has it configured
 * @returns True when the call may be served
 */
function allowed(assertion : Assertion, peer : DelegationPeer) : boolean {
    if (!allowedEnvelope(assertion, peer)) {
        return false;
    }
    if ((MCP_READ_TOOLS as readonly string[]).includes(assertion.action)) {
        return allowedRead(assertion);
    }
    if (assertion.identity.role !== "operator" || peer.role !== "operator" || assertion.identity.mode === "readonly") {
        return false;
    }
    if (assertion.action === "operation_apply" || assertion.action === "operation_status") {
        return allowedOperationReference(assertion);
    }
    return allowedWrite(assertion, peer);
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

/** One request of another panel: either a call to serve, or an assertion to confirm */
type Envelope = Assertion | z.infer<typeof validationSchema>;

/** The operation a delegated apply or status call refers to */
type OperationTarget = { action : string; stackId : string; additionalActions? : string[] };

/**
 * Everything a request has to prove before any of it is acted on.
 *
 * A browser session is never accepted here: this channel is for another panel, and its
 * only proof is a signature over the exact bytes that arrived.
 * @param request Incoming request
 * @param services How this panel reads its own configuration
 * @returns The configuration in force, the envelope and the peer that signed it
 * @throws {Error} denied, for anything that does not prove itself
 */
async function authenticate(request : express.Request, services : DelegationServices) : Promise<{ config : DelegationConfig; envelope : Envelope; peer : DelegationPeer }> {
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
    return { config,
        envelope,
        peer };
}

/**
 * Serve a request exactly once.
 *
 * A signature stays valid for as long as the envelope says, so without this a captured
 * request could be sent again inside that window.
 * @param seen Requests already served, with the moment each stops being replayable
 * @param peer The panel the request came from
 * @param envelope The request itself
 * @returns {void}
 * @throws {Error} denied, when this request was already served
 */
function claimNonce(seen : Map<string, number>, peer : DelegationPeer, envelope : Envelope) : void {
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
}

/**
 * Confirm an assertion this panel signed earlier.
 *
 * The other side asks before it acts, so the answer has to be decided from the rights as
 * they are now, not as they were when the assertion was written.
 * @param envelope The confirmation request
 * @param peer The panel that asks
 * @param config Configuration in force
 * @param services How this panel reads rights
 * @returns {void}
 * @throws {Error} denied, when the assertion may no longer be acted on
 */
async function confirmAssertion(envelope : z.infer<typeof validationSchema>, peer : DelegationPeer, config : DelegationConfig, services : DelegationServices) : Promise<void> {
    const original = envelope.assertion;
    const target = envelope.operationTarget;

    if ([ "operation_apply", "operation_status" ].includes(original.action) && !target) {
        throw new Error("denied");
    }
    if (original.issuer !== config.serverId || original.audience !== peer.id || !allowed(original, peer)) {
        throw new Error("denied");
    }
    if (target && (!peer.actions.includes(target.action) || target.additionalActions?.some(action => !peer.actions.includes(action)) || !original.identity.stacks.includes(target.stackId))) {
        throw new Error("denied");
    }
    if (!identityStillAllows(await services.resolveIdentity(original.identity.keyId), original)) {
        throw new Error("denied");
    }
}

/**
 * Whether the peer is still the one the request was accepted from.
 *
 * Read between accepting a call and acting on it: the configuration may have been
 * rewritten, and a key or a stack taken away in between has to stop the call.
 * @param fresh Configuration as it is now
 * @param trust The peer as it is now
 * @param peer The peer as it was when the request arrived
 * @param config Configuration as it was then
 * @param assertion The call
 * @param target The operation the call refers to, when it refers to one
 * @returns True when nothing that mattered has changed
 */
function trustUnchanged(fresh : DelegationConfig, trust : DelegationPeer, peer : DelegationPeer, config : DelegationConfig, assertion : Assertion, target : OperationTarget | null) : boolean {
    if (trust.publicKey !== peer.publicKey || fresh.serverId !== config.serverId || !allowed(assertion, trust)) {
        return false;
    }
    return !target || (trust.actions.includes(target.action) && !target.additionalActions?.some(action => !trust.actions.includes(action))
        && trust.allowedStackIds.includes(target.stackId) && assertion.identity.stacks.includes(target.stackId));
}

/**
 * The arguments as this panel serves them locally.
 *
 * The caller names a server of its own catalogue; here the call is always about this
 * panel, so the name is replaced rather than passed on.
 * @param assertion The call
 * @returns Arguments for the local tool
 */
function localArguments(assertion : Assertion) : Record<string, unknown> {
    const args = { ...assertion.args };

    if (assertion.action === "operation_prepare") {
        delete args.server_id;
        args.parameters = { ...(assertion.args.parameters as Record<string, unknown>),
            server_id: "local" };
    } else if ([ "operation_apply", "operation_status" ].includes(assertion.action)) {
        delete args.server_id;
    } else {
        args.server_id = "local";
    }
    return args;
}

/**
 * Who the caller is, as far as this panel is concerned.
 *
 * The rights of the other panel are not imported: a reading call becomes a viewer of the
 * named stacks here and nothing more, whatever the caller holds at home.
 * @param assertion The call
 * @param observer True when the call only reads
 * @returns Identity used for the local check
 */
function effectiveIdentity(assertion : Assertion, observer : boolean) : DelegatedIdentity {
    return { ...assertion.identity,
        keyId: delegatedSubjectId(assertion.issuer, assertion.identity.keyId),
        role: observer ? "viewer" : "operator",
        servers: [ "local" ],
        stacks: assertion.identity.stacks,
        resources: { local: assertion.identity.stacks },
        actions: observer ? [] : assertion.identity.actions ?? [],
        mode: observer ? "readonly" : assertion.identity.mode ?? "readonly" };
}

/**
 * Carry out one call of another panel.
 *
 * The rights are checked again immediately before the work and once more after it: the
 * call travels, and a key revoked while it was in flight must not leave a result behind.
 * @param assertion The call
 * @param peer The panel it came from
 * @param config Configuration in force when it arrived
 * @param services How this panel reads rights and does the work
 * @returns The answer, as the JSON text to send back
 * @throws {Error} denied, when the call may not be served
 */
async function serve(assertion : Assertion, peer : DelegationPeer, config : DelegationConfig, services : DelegationServices) : Promise<string> {
    let operationTarget : OperationTarget | null = null;

    if ([ "operation_apply", "operation_status" ].includes(assertion.action)) {
        operationTarget = await services.operationTarget?.(delegatedSubjectId(assertion.issuer, assertion.identity.keyId), String(assertion.args.operation_id)) ?? null;
        if (!operationTarget) {
            throw new Error("denied");
        }
    }
    const revalidate = async () => {
        const fresh = await services.getConfig();
        const trust = fresh?.peers.find(item => item.id === peer.id);

        if (!fresh || !trust || !trustUnchanged(fresh, trust, peer, config, assertion, operationTarget) || !await services.authorizePeer(trust)) {
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
    const refresh = async () => {
        await revalidate();
        return effectiveIdentity(assertion, observer);
    };
    const localArgs = localArguments(assertion);
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
    return resultText;
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
            const { config, envelope, peer } = await authenticate(request, services);

            claimNonce(seen, peer, envelope);
            if (envelope.kind === "validate") {
                await confirmAssertion(envelope, peer, config, services);
                response.json({ valid: true });
                return;
            }
            response.type("application/json").send(await serve(envelope, peer, config, services));
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
