/**
 * The page side of updating the panel from the web interface: one statechart, kept as a
 * pure reducer. See docs/panel-update-statechart.md, section 6.
 *
 * Nothing here touches the socket, the clock or the storage. Time enters through the
 * events, and what the page has to do - emit, persist, reload, ask for the status - comes
 * back as data, so every transition is tested without a browser. The password of an apply
 * passes through one emit effect and is never kept in the state or written anywhere.
 */
import {
    PANEL_UPDATE_FINAL_PHASES,
    PANEL_UPDATE_OUTCOMES,
    PANEL_UPDATE_PREVIEW_TTL_MS,
    PANEL_UPDATE_REQUEST_PATTERN,
    PANEL_VERSION_PATTERN,
    canCancelPanelUpdate,
    phaseRank,
    type PanelUpdateErrorCode,
    type PanelUpdateManualReason,
    type PanelUpdateOperation,
    type PanelUpdateOutcome,
    type PanelUpdatePreview,
    type PanelUpdateResult,
    type PanelUpdateStatus,
} from "../../common/panel-update";

/** Where the page keeps the operation it follows, so a reload resumes it */
export const PANEL_UPDATE_STORAGE_KEY = "dockge2.panelUpdate.v1";

/** How long the first status may take before the page offers the host commands */
export const PANEL_UPDATE_LOADING_MS = 15_000;

/** How long the automatic reload may take before a Reload button appears */
export const PANEL_UPDATE_RELOAD_STALL_MS = 5_000;

/** How long a running check may go unheard before the page asks for its status again */
export const PANEL_UPDATE_CHECK_QUIET_MS = 60_000;

/** Shown in a host command when the installation directory is not known to this user */
export const PANEL_UPDATE_DIR_PLACEHOLDER = "/path/to/dockge2";

/** What the Progress region of `Running` is doing */
export type PanelUpdateProgress =
    | "submitting"          // apply sent, no status of it yet
    | "starting"            // Preparing.Starting: no phase line yet
    | "downloading"         // Preparing.Downloading: prepared
    | "ready"               // Preparing.Ready: downloaded
    | "cancelling"
    | "stopping"            // Cutover.Stopping
    | "snapshot"            // Cutover.Snapshot
    | "target-starting"     // Cutover.Starting
    | "verifying"
    | "rolling-back"        // the target did not become ready, the previous version comes back
    | "finishing"           // a final phase seen while the helper still runs
    | "step-unknown";       // a phase this build does not know

/**
 * How long the page waits without news before it says so. Offline this turns `Waiting`
 * into `Overdue`; online it asks for the status again and shows the host commands.
 */
export const PANEL_UPDATE_DEADLINES : Readonly<Record<PanelUpdateProgress, number>> = {
    "submitting": 60_000,
    "starting": 120_000,
    "downloading": 120_000,
    "ready": 120_000,
    "cancelling": 120_000,
    "stopping": 600_000,
    "snapshot": 600_000,
    "target-starting": 600_000,
    "step-unknown": 600_000,
    "rolling-back": 600_000,
    "verifying": 180_000,
    "finishing": 180_000,
};

/** Every refusal code of the contract, so each one is known to have a catalogue entry */
const ERROR_CODES : Record<PanelUpdateErrorCode, true> = {
    "invalid": true,
    "forbidden": true,
    "unreadable": true,
    "unmanaged": true,
    "updater-missing": true,
    "busy": true,
    "name-taken": true,
    "password": true,
    "stale-preview": true,
    "too-late": true,
    "running": true,
    "not-found": true,
    "start-failed": true,
};

export const PANEL_UPDATE_ERROR_CODES = Object.keys(ERROR_CODES) as PanelUpdateErrorCode[];

/** Every reason the panel gives for not updating itself; another one is not shown */
const MANUAL_REASONS : Record<PanelUpdateManualReason, true> = {
    "not-container": true,
    "no-installation": true,
    "updater-missing": true,
    "unsupported": true,
    "unreadable": true,
};

export const PANEL_UPDATE_MANUAL_REASONS = Object.keys(MANUAL_REASONS) as PanelUpdateManualReason[];

/** The Link region: whether the page can hear the panel */
export type PanelUpdateLink =
    | { kind : "online" }
    | { kind : "need-auth" }
    | { kind : "offline"; since : number; overdue : boolean };

/** Why the preview did not end in a dry run the owner can apply */
export interface PanelUpdateRefusal {
    /** An acknowledgement refused, the helper reported a result, or the request vanished */
    kind : "error" | "result" | "lost";
    code : string | null;
    /** The catalogue key the server sent with a refusal, for codes the page has no text of */
    msg : string | null;
    outcome : string | null;
    error : string | null;
}

/** A result as the page keeps it */
export interface PanelUpdatePageResult {
    outcome : string;
    /** A `PanelUpdateResultCode`, or `helper-removed` / `contradiction` decided by the page */
    code : string | null;
    error : string | null;
    /** Whether the snapshot replaced the data; null when the updater did not say */
    restoredData : boolean | null;
}

export interface PanelUpdateIdleNode {
    name : "idle";
    sub : "loading" | "manual" | "current" | "available";
    reason : PanelUpdateManualReason | null;
    version : string | null;
    /** When the status was asked for, while loading */
    requestedAt : number | null;
    notice : "preview-expired" | "not-started" | "unreadable" | null;
}

export interface PanelUpdatePreviewNode {
    name : "preview";
    sub : "checking" | "ready" | "refused";
    request : string;
    from : string;
    to : string;
    preview : PanelUpdatePreview | null;
    expires : number | null;
    /** The password dialog of `Ready` */
    dialog : boolean;
    refusal : PanelUpdateRefusal | null;
    notice : "not-started" | "password" | "unreadable" | null;
    /** The catalogue key the panel sent with the notice, such as too many password attempts */
    message : string | null;
    /** Checking: when the page last heard of its check; null while the preview acknowledgement is due */
    heardAt : number | null;
    /** Checking: nothing was heard for longer than the deadline, so the page asked again */
    quiet : boolean;
}

/** What `Submitting` returns to when the apply did not start */
export interface PanelUpdateBack {
    previewRequest : string;
    preview : PanelUpdatePreview | null;
    expires : number;
}

export interface PanelUpdateRunningNode {
    name : "running";
    request : string;
    from : string;
    to : string;
    startedAt : number;
    /** The furthest phase seen */
    phase : string | null;
    progress : PanelUpdateProgress;
    /** Followed from a status rather than started here */
    observer : boolean;
    /** A status of this request arrived */
    seen : boolean;
    /** The apply acknowledgement is still due; the root bounds it with its own timeout */
    ackPending : boolean;
    heardAt : number;
    /** Online, but nothing heard for longer than the deadline */
    quiet : boolean;
    notice : "too-late" | "cancel-failed" | null;
    back : PanelUpdateBack | null;
}

export type PanelUpdateOutcomeKind = "updated" | "not-changed" | "rolled-back" | "recovery-required" | "unknown";

export interface PanelUpdateOutcomeNode {
    name : "outcome";
    sub : PanelUpdateOutcomeKind;
    request : string;
    from : string;
    to : string;
    startedAt : number;
    phase : string | null;
    result : PanelUpdatePageResult;
    /** Updated only: the page reloads, or shows the result after the reload */
    updated : "reloading" | "shown" | null;
    /** Updated.Shown after a reload, until a status confirms it again */
    pending : boolean;
    /** Pending only: when the page last asked for that status */
    askedAt : number | null;
    reloadAt : number | null;
    stalled : boolean;
    /** Followed while it ran, rather than found finished */
    watched : boolean;
}

export type PanelUpdateNode = PanelUpdateIdleNode | PanelUpdatePreviewNode | PanelUpdateRunningNode | PanelUpdateOutcomeNode;

export interface PanelUpdateContext {
    link : PanelUpdateLink;
    /** The last status the panel sent */
    status : PanelUpdateStatus | null;
    /** The newest release the page was told about */
    latest : string | null;
    updateAvailable : boolean;
    /** Sequence of the page's own status requests */
    ask : number;
    /** The request whose answer may say "the helper is gone" (rows 8, 14, 21) */
    probe : number | null;
    /** A finished operation the owner closed; it does not open again on the next status */
    closed : string | null;
    /** Version of the page's own build, when the root told it */
    build : string | null;
}

export interface PanelUpdateState {
    ctx : PanelUpdateContext;
    node : PanelUpdateNode;
}

/** The operation as `sessionStorage` keeps it. Never a password. */
export interface PanelUpdateRecord {
    v : 1;
    request : string;
    from : string;
    to : string;
    phase : string | null;
    startedAt : number;
    stage : "submitting" | "running" | "finished";
    outcome : string | null;
}

export type PanelUpdateAckKind = "status" | "preview" | "apply" | "cancel" | "dismiss";

export type PanelUpdateAckResult =
    | { kind : "ok"; status : PanelUpdateStatus }
    | { kind : "error"; code : string; msg : string | null }
    | { kind : "lost" };

export type PanelUpdateEvent =
    | { type : "BOOT"; persisted : PanelUpdateRecord | null; now : number; build? : string }
    | { type : "INFO"; latestVersion : string | null; updateAvailable : boolean }
    | { type : "STATUS"; status : PanelUpdateStatus; solicited : boolean; ask : number | null; now : number }
    | { type : "LINK_UP"; now : number }
    | { type : "LINK_DOWN"; now : number }
    | { type : "AUTH_LOST" }
    | { type : "ACK"; kind : "status"; ask : number; result : PanelUpdateAckResult; now : number }
    | { type : "ACK"; kind : "preview" | "apply" | "cancel" | "dismiss"; requestId : string; result : PanelUpdateAckResult; now : number }
    | { type : "TICK"; now : number }
    | { type : "CHECK"; owner : boolean; requestId : string }
    | { type : "CONFIRM"; owner : boolean }
    | { type : "SUBMIT"; owner : boolean; password : string; requestId : string; now : number }
    | { type : "CANCEL"; owner : boolean }
    | { type : "DISMISS"; owner : boolean; now : number }
    | { type : "CLOSE" };

export type PanelUpdateEffect =
    | { type : "emit"; kind : "preview"; args : [ requestId : string, version : string ] }
    | { type : "emit"; kind : "apply"; args : [ requestId : string, previewRequestId : string, version : string, password : string ] }
    | { type : "emit"; kind : "cancel" | "dismiss"; args : [ requestId : string ] }
    | { type : "requestStatus"; ask : number }
    | { type : "persist"; record : PanelUpdateRecord }
    | { type : "clearPersist" }
    | { type : "reload" };

export interface PanelUpdateStep {
    state : PanelUpdateState;
    effects : PanelUpdateEffect[];
}

const ONLINE : PanelUpdateLink = { kind: "online" };

const PHASE_PROGRESS : Readonly<Record<string, PanelUpdateProgress>> = {
    "prepared": "downloading",
    "downloaded": "ready",
    "stopping": "stopping",
    "backing-up": "snapshot",
    "starting-target": "target-starting",
    "checking-target": "verifying",
    "rolling-back": "rolling-back",
};

const OUTCOME_KINDS : Readonly<Record<string, PanelUpdateOutcomeKind>> = {
    "no-change": "not-changed",
    "refused": "not-changed",
    "failed-before-cutover": "not-changed",
    "recovered": "rolled-back",
    "recovery-required": "recovery-required",
};

/**
 * The Progress state a journal phase stands for
 * @param phase Furthest phase seen, possibly unknown to this build
 * @returns Progress state
 */
export function progressOfPhase(phase : string | null) : PanelUpdateProgress {
    if (phase === null) {
        return "starting";
    }
    if (Object.hasOwn(PHASE_PROGRESS, phase)) {
        return PHASE_PROGRESS[phase]!;
    }
    return (PANEL_UPDATE_FINAL_PHASES as readonly string[]).includes(phase) ? "finishing" : "step-unknown";
}

/**
 * The state before `BOOT`: loading, and not connected yet
 * @returns Initial state
 */
export function createPanelUpdateState() : PanelUpdateState {
    return {
        ctx: {
            link: offline(0),
            status: null,
            latest: null,
            updateAvailable: false,
            ask: 0,
            probe: null,
            closed: null,
            build: null,
        },
        node: idleNode("loading"),
    };
}

function offline(since : number) : PanelUpdateLink {
    return { kind: "offline",
        since,
        overdue: false };
}

function idleNode(sub : PanelUpdateIdleNode["sub"], extra : Partial<PanelUpdateIdleNode> = {}) : PanelUpdateIdleNode {
    return {
        name: "idle",
        sub,
        reason: null,
        version: null,
        requestedAt: null,
        notice: null,
        ...extra,
    };
}

function stay(state : PanelUpdateState) : PanelUpdateStep {
    return { state,
        effects: [] };
}

function withNode(state : PanelUpdateState, node : PanelUpdateNode, effects : PanelUpdateEffect[] = []) : PanelUpdateStep {
    return { state: { ...state,
        node },
    effects };
}

function parseTime(value : string | undefined, fallback : number) : number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toRecord(node : PanelUpdateRunningNode | PanelUpdateOutcomeNode, stage : PanelUpdateRecord["stage"], outcome : string | null = null) : PanelUpdateEffect {
    return {
        type: "persist",
        record: {
            v: 1,
            request: node.request,
            from: node.from,
            to: node.to,
            phase: node.phase,
            startedAt: node.startedAt,
            stage,
            outcome,
        },
    };
}

/**
 * Ask the panel for its status, if it can hear the page
 * @param state State to ask from
 * @param probe Whether the answer may say that the helper is gone
 * @returns The state with the request counted, and the effect
 */
function ask(state : PanelUpdateState, probe : boolean) : PanelUpdateStep {
    if (state.ctx.link.kind !== "online") {
        return stay(state);
    }
    const next = state.ctx.ask + 1;
    return {
        state: { ...state,
            ctx: { ...state.ctx,
                ask: next,
                probe: probe ? next : state.ctx.probe } },
        effects: [{ type: "requestStatus",
            ask: next }],
    };
}

function then(step : PanelUpdateStep, more : (state : PanelUpdateState) => PanelUpdateStep) : PanelUpdateStep {
    const next = more(step.state);
    return { state: next.state,
        effects: [ ...step.effects, ...next.effects ] };
}

// --- Idle ---------------------------------------------------------------------------

/**
 * `Idle` as the last status and the release news say: row 1
 * @param ctx Context with the status
 * @param notice What to tell the owner on arrival
 * @returns Idle node
 */
function classify(ctx : PanelUpdateContext, notice : PanelUpdateIdleNode["notice"] = null) : PanelUpdateIdleNode {
    const status = ctx.status;
    if (!status) {
        return idleNode("loading", { notice });
    }
    if (status.panel.managed !== "yes") {
        return idleNode("manual", { reason: status.panel.reason ?? (status.panel.managed === "unknown" ? "unreadable" : "unsupported"),
            notice });
    }
    if (ctx.updateAvailable && ctx.latest && ctx.latest !== status.panel.version) {
        return idleNode("available", { version: ctx.latest,
            notice });
    }
    return idleNode("current", { notice });
}

/** The apply operation of a status, unless the owner already closed it */
function applyOperation(ctx : PanelUpdateContext) : PanelUpdateOperation | undefined {
    const op = ctx.status?.operation;
    return op?.kind === "apply" && op.requestId !== ctx.closed ? op : undefined;
}

/**
 * Leave for `Idle`, following an apply operation the status shows: rows 1, 3 and 4
 * @param state State whose context holds the status
 * @param now Current time
 * @param notice What to tell the owner
 * @returns The step
 */
function enterIdle(state : PanelUpdateState, now : number, notice : PanelUpdateIdleNode["notice"] = null) : PanelUpdateStep {
    const op = applyOperation(state.ctx);
    if (op?.running) {
        return observe(state, op, now);
    }
    if (op && state.ctx.status) {
        const found = settled(op, state.ctx.status, now, false);
        if (found.sub === "updated" && state.ctx.build !== null && state.ctx.build !== found.to) {
            // This page is the old build, which slept through the update: load the new one,
            // which shows the result from the record as after a followed update
            const reloading : PanelUpdateOutcomeNode = { ...found,
                updated: "reloading",
                reloadAt: now };
            return withNode(state, reloading, [ toRecord(reloading, "finished", "success"), { type: "reload" }]);
        }
        return withNode(state, found);
    }
    return withNode(state, classify(state.ctx, notice));
}

/**
 * An apply of another request that runs. Only one apply helper exists at a time, so the one
 * the page followed ended and was dismissed, and an owner started the next one.
 */
function otherRunning(state : PanelUpdateState, request : string) : PanelUpdateOperation | undefined {
    const op = applyOperation(state.ctx);
    return op?.running && op.requestId !== request ? op : undefined;
}

/** Row 3: an apply operation runs, followed as an observer */
function observe(state : PanelUpdateState, op : PanelUpdateOperation, now : number) : PanelUpdateStep {
    const phase = op.phase ?? null;
    const node : PanelUpdateRunningNode = {
        name: "running",
        request: op.requestId,
        from: op.from,
        to: op.to,
        startedAt: parseTime(op.startedAt, now),
        phase,
        progress: progressOfPhase(phase),
        observer: true,
        seen: true,
        ackPending: false,
        heardAt: now,
        quiet: false,
        notice: null,
        back: null,
    };
    return withNode(state, node, [ toRecord(node, "running") ]);
}

function pageResult(result : PanelUpdateResult | undefined) : PanelUpdatePageResult {
    return {
        outcome: result?.outcome ?? "unknown",
        code: result?.code ?? (result ? null : "no-result"),
        error: result?.error ?? null,
        restoredData: result?.restoredData ?? null,
    };
}

/**
 * The outcome a finished apply operation stands for. `Updated` needs the updater's success
 * for this request and the answering panel on the target version (I1).
 * @param op Finished operation
 * @param status Status that carried it
 * @param target Version the page expects
 * @returns Kind of the outcome and the result to show
 */
function judge(op : PanelUpdateOperation, status : PanelUpdateStatus, target : string) : { sub : PanelUpdateOutcomeKind; result : PanelUpdatePageResult } {
    const result = pageResult(op.result);
    if (result.outcome === "success") {
        return status.panel.version === target
            ? { sub: "updated",
                result }
            : { sub: "unknown",
                result: { ...result,
                    outcome: "unknown",
                    code: "version-mismatch" } };
    }
    const sub = Object.hasOwn(OUTCOME_KINDS, result.outcome) ? OUTCOME_KINDS[result.outcome]! : "unknown";
    return { sub,
        result };
}

function outcomeNode(base : { request : string; from : string; to : string; startedAt : number; phase : string | null }, sub : PanelUpdateOutcomeKind, result : PanelUpdatePageResult, watched : boolean) : PanelUpdateOutcomeNode {
    return {
        name: "outcome",
        sub,
        request: base.request,
        from: base.from,
        to: base.to,
        startedAt: base.startedAt,
        phase: base.phase,
        result,
        updated: sub === "updated" ? "shown" : null,
        pending: false,
        askedAt: null,
        reloadAt: null,
        stalled: false,
        watched,
    };
}

/** Row 4: an apply operation that finished before the page followed it */
function settled(op : PanelUpdateOperation, status : PanelUpdateStatus, now : number, watched : boolean) : PanelUpdateOutcomeNode {
    const { sub, result } = judge(op, status, op.to);
    return outcomeNode({ request: op.requestId,
        from: op.from,
        to: op.to,
        startedAt: parseTime(op.startedAt, now),
        phase: op.phase ?? null }, sub, result, watched);
}

// --- Events -------------------------------------------------------------------------

function boot(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "BOOT" }>) : PanelUpdateStep {
    const ctx : PanelUpdateContext = { ...state.ctx,
        link: offline(event.now),
        probe: null,
        build: event.build ?? null };
    const record = event.persisted;
    if (!record) {
        return stay({ ctx,
            node: idleNode("loading") });
    }
    if (record.stage === "finished") {
        if (record.outcome !== "success") {
            return { state: { ctx,
                node: idleNode("loading") },
            effects: [{ type: "clearPersist" }] };
        }
        // Row 27: shown again after the reload, pending a status that confirms it
        const node = outcomeNode(record, "updated", { outcome: "success",
            code: null,
            error: null,
            restoredData: null }, true);
        return stay({ ctx,
            node: { ...node,
                pending: true } });
    }
    // Row 26: resume where the operation was; the status comes on LINK_UP
    return stay({ ctx,
        node: {
            name: "running",
            request: record.request,
            from: record.from,
            to: record.to,
            startedAt: record.startedAt,
            phase: record.phase,
            progress: record.stage === "submitting" ? "submitting" : progressOfPhase(record.phase),
            observer: false,
            seen: record.stage === "running",
            ackPending: false,
            heardAt: event.now,
            quiet: false,
            notice: null,
            back: null,
        } });
}

function info(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "INFO" }>) : PanelUpdateStep {
    const ctx = { ...state.ctx,
        latest: event.latestVersion,
        updateAvailable: event.updateAvailable };
    const node = state.node;
    if (node.name === "idle" && node.sub !== "loading" && ctx.status) {
        return { state: { ctx,
            node: classify(ctx, node.notice) },
        effects: [] };
    }
    return stay({ ...state,
        ctx });
}

function linkUp(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "LINK_UP" }>) : PanelUpdateStep {
    const up = { ...state,
        ctx: { ...state.ctx,
            link: ONLINE } };
    const node = state.node;
    switch (node.name) {
        case "idle":
            return ask(node.sub === "loading" ? { ...up,
                node: { ...node,
                    requestedAt: event.now } } : up, false);
        case "preview":
            // A new connection: an acknowledgement still due will never arrive
            return node.sub === "checking" ? ask({ ...up,
                node: { ...node,
                    heardAt: event.now } }, true) : ask(up, false);
        case "running":
            // Row 24. A new connection: an acknowledgement still due will never arrive
            return ask({ ...up,
                node: { ...node,
                    heardAt: event.now,
                    quiet: false,
                    ackPending: false } }, true);
        case "outcome":
            return node.pending ? ask({ ...up,
                node: { ...node,
                    askedAt: event.now } }, true) : ask(up, false);
    }
}

function linkDown(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "LINK_DOWN" }>) : PanelUpdateStep {
    if (state.ctx.link.kind === "offline") {
        return stay(state);
    }
    // Row 22. No answer to a request of the old connection can arrive any more
    return stay({ ...state,
        ctx: { ...state.ctx,
            link: offline(event.now),
            probe: null } });
}

function authLost(state : PanelUpdateState) : PanelUpdateStep {
    // Row 25: the sign-in dialog opens; the operation stays as it is
    return stay({ ...state,
        ctx: { ...state.ctx,
            link: { kind: "need-auth" },
            probe: null } });
}

function tickRunning(state : PanelUpdateState, node : PanelUpdateRunningNode, now : number) : PanelUpdateStep {
    const link = state.ctx.link;
    const deadline = PANEL_UPDATE_DEADLINES[node.progress];
    if (link.kind === "offline" && !link.overdue && now - link.since >= deadline) {
        // Row 23: still retrying, the host commands appear
        return stay({ ...state,
            ctx: { ...state.ctx,
                link: { ...link,
                    overdue: true } } });
    }
    if (link.kind === "online" && !node.ackPending && now - node.heardAt >= deadline) {
        return ask({ ...state,
            node: { ...node,
                quiet: true,
                heardAt: now } }, true);
    }
    return stay(state);
}

function tickPreview(state : PanelUpdateState, node : PanelUpdatePreviewNode, now : number) : PanelUpdateStep {
    const deadline = previewDeadline(node, state.ctx.link);
    if (deadline === null || now < deadline) {
        return stay(state);
    }
    if (node.sub === "ready") {
        // Row 9: the dry run no longer authorises an apply
        return withNode(state, { ...classify(state.ctx, "preview-expired") });
    }
    // Checking: the push with the result was lost, or Docker could not be read when it ended
    return ask(withNode(state, { ...node,
        quiet: true,
        heardAt: now }).state, true);
}

function tick(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "TICK" }>) : PanelUpdateStep {
    const node = state.node;
    const now = event.now;
    if (node.name === "idle" && node.sub === "loading" && node.requestedAt !== null && now - node.requestedAt >= PANEL_UPDATE_LOADING_MS) {
        // Row 2
        return withNode(state, idleNode("manual", { reason: "unsupported" }));
    }
    if (node.name === "preview") {
        return tickPreview(state, node, now);
    }
    if (node.name === "running") {
        return tickRunning(state, node, now);
    }
    if (node.name === "outcome" && node.pending && state.ctx.link.kind === "online" && node.askedAt !== null && now - node.askedAt >= PANEL_UPDATE_LOADING_MS) {
        // The answer that confirms Updated was lost or unreadable: ask again
        return ask(withNode(state, { ...node,
            askedAt: now }).state, true);
    }
    if (node.name === "outcome" && node.updated === "reloading" && !node.stalled && node.reloadAt !== null && now - node.reloadAt >= PANEL_UPDATE_RELOAD_STALL_MS) {
        // Row 31
        return withNode(state, { ...node,
            stalled: true });
    }
    return stay(state);
}

// --- STATUS -------------------------------------------------------------------------

function previewExpiry(finishedAt : string | undefined, now : number) : number {
    const base = Math.min(Math.max(parseTime(finishedAt, now), now - PANEL_UPDATE_PREVIEW_TTL_MS), now);
    return base + PANEL_UPDATE_PREVIEW_TTL_MS;
}

function refused(state : PanelUpdateState, node : PanelUpdatePreviewNode, refusal : PanelUpdateRefusal) : PanelUpdateStep {
    return withNode(state, { ...node,
        sub: "refused",
        dialog: false,
        refusal,
        notice: null,
        message: null });
}

function previewFinished(state : PanelUpdateState, node : PanelUpdatePreviewNode, op : PanelUpdateOperation, now : number) : PanelUpdateStep {
    if (op.result?.outcome === "previewed" && op.preview && op.to === node.to) {
        // Row 6
        return withNode(state, { ...node,
            sub: "ready",
            from: op.from,
            preview: op.preview,
            expires: previewExpiry(op.result.finishedAt, now) });
    }
    // Row 7
    return refused(state, node, { kind: "result",
        code: op.result?.code ?? null,
        msg: null,
        outcome: op.result?.outcome ?? "unknown",
        error: op.result?.error ?? null });
}

function previewStatus(state : PanelUpdateState, node : PanelUpdatePreviewNode, now : number, probe : boolean) : PanelUpdateStep {
    const op = state.ctx.status?.operation;
    if (op?.kind === "apply" && op.running) {
        // An apply runs after all - a lost acknowledgement, or another owner: follow it
        return observe(state, op, now);
    }
    if (node.sub !== "checking") {
        return stay(state);
    }
    if (op?.kind === "preview" && op.requestId === node.request) {
        return op.running ? withNode(state, { ...node,
            heardAt: now }) : previewFinished(state, node, op, now);
    }
    // Row 8: only the answer to the page's own request says the helper is gone
    return probe ? refused(state, node, { kind: "lost",
        code: null,
        msg: null,
        outcome: null,
        error: null }) : stay(state);
}

function nextProgress(node : PanelUpdateRunningNode, phase : string | null) : Pick<PanelUpdateRunningNode, "progress" | "notice"> {
    if (node.progress !== "cancelling") {
        return { progress: progressOfPhase(phase),
            notice: node.notice };
    }
    // Row 18: the image was downloaded before the cancel arrived
    return canCancelPanelUpdate(phase ?? undefined)
        ? { progress: "cancelling",
            notice: node.notice }
        : { progress: progressOfPhase(phase),
            notice: "too-late" };
}

/**
 * Rows 15 and 16: follow the phase forward, never back
 * @param state Current state
 * @param node The running node
 * @param op Our operation, still running
 * @param now Current time
 * @returns The step
 */
function advance(state : PanelUpdateState, node : PanelUpdateRunningNode, op : PanelUpdateOperation, now : number) : PanelUpdateStep {
    const phase = op.phase ?? null;
    const heard = { ...node,
        seen: true,
        heardAt: now,
        quiet: false };
    const forward = phaseRank(phase ?? undefined) > phaseRank(node.phase ?? undefined)
        || (phaseRank(phase ?? undefined) === phaseRank(node.phase ?? undefined) && phase !== null);
    if (!forward) {
        const progress = node.progress === "submitting" ? progressOfPhase(node.phase) : node.progress;
        const next = { ...heard,
            progress };
        return withNode(state, next, node.seen ? [] : [ toRecord(next, "running") ]);
    }
    const next : PanelUpdateRunningNode = { ...heard,
        phase,
        ...nextProgress(node, phase) };
    const changed = phase !== node.phase || !node.seen;
    return withNode(state, next, changed ? [ toRecord(next, "running") ] : []);
}

function finishRunning(state : PanelUpdateState, node : PanelUpdateRunningNode, op : PanelUpdateOperation, status : PanelUpdateStatus, now : number) : PanelUpdateStep {
    const { sub, result } = judge(op, status, node.to);
    const phase = phaseRank(op.phase) >= phaseRank(node.phase ?? undefined) ? op.phase ?? node.phase : node.phase;
    const base = { ...node,
        phase };
    if (sub === "updated") {
        // Row 19: the only way into Updated from a running operation
        const reloading : PanelUpdateOutcomeNode = { ...outcomeNode(base, sub, result, true),
            updated: "reloading",
            reloadAt: now };
        return withNode(state, reloading, [ toRecord(reloading, "finished", "success"), { type: "reload" }]);
    }
    // Row 20
    const done = outcomeNode(base, sub, result, true);
    return withNode(state, done, [ toRecord(done, "finished", result.outcome) ]);
}

function notStarted(state : PanelUpdateState, node : PanelUpdateRunningNode, now : number) : PanelUpdateStep {
    const clear : PanelUpdateEffect = { type: "clearPersist" };
    const back = node.back;
    // Row 14: the request never reached the panel. When another apply runs instead, the
    // record of this one is cleared and that one is followed, as from Idle
    if (back && back.expires > now && !applyOperation(state.ctx)?.running) {
        return withNode(state, {
            name: "preview",
            sub: "ready",
            request: back.previewRequest,
            from: node.from,
            to: node.to,
            preview: back.preview,
            expires: back.expires,
            dialog: false,
            refusal: null,
            notice: "not-started",
            message: null,
            heardAt: null,
            quiet: false,
        }, [ clear ]);
    }
    const idle = enterIdle(state, now, "not-started");
    return { state: idle.state,
        effects: [ clear, ...idle.effects ] };
}

function runningStatus(state : PanelUpdateState, node : PanelUpdateRunningNode, now : number, probe : boolean) : PanelUpdateStep {
    const status = state.ctx.status!;
    const op = status.operation;
    if (op?.kind === "apply" && op.requestId === node.request) {
        return op.running ? advance(state, node, op, now) : finishRunning(state, node, op, status, now);
    }
    if (!probe) {
        // A push may predate `docker run`, and a foreign request is not ours
        return stay(state);
    }
    if (node.progress === "submitting" && !node.seen) {
        return notStarted(state, node, now);
    }
    const other = otherRunning(state, node.request);
    if (other) {
        return observe(state, other, now);
    }
    // Row 21: the helper is gone, nothing can confirm what happened
    const gone = outcomeNode(node, "unknown", { outcome: "unknown",
        code: "helper-removed",
        error: null,
        restoredData: null }, true);
    return withNode(state, gone, [ toRecord(gone, "finished", "unknown") ]);
}

function contradiction(state : PanelUpdateState, node : PanelUpdateOutcomeNode) : PanelUpdateStep {
    const unknown = outcomeNode(node, "unknown", { outcome: "unknown",
        code: "contradiction",
        error: null,
        restoredData: null }, true);
    return withNode(state, unknown, [ toRecord(unknown, "finished", "unknown") ]);
}

function outcomeStatus(state : PanelUpdateState, node : PanelUpdateOutcomeNode, probe : boolean, now : number) : PanelUpdateStep {
    // A result on screen gives way to the next update, so the page holds its reloads and the
    // connection banner through that one too. A push says so as well as an answer: nothing
    // asks while a result is shown.
    const other = node.updated === "reloading" ? undefined : otherRunning(state, node.request);
    if (other) {
        return observe(state, other, now);
    }
    if (!node.pending) {
        return stay(state);
    }
    const status = state.ctx.status!;
    const op = status.operation;
    if (op?.kind === "apply" && op.requestId === node.request) {
        if (op.running) {
            return contradiction(state, node);
        }
        const { sub, result } = judge(op, status, node.to);
        if (sub === "updated") {
            // Row 28
            return withNode(state, { ...node,
                pending: false,
                result });
        }
        // Row 29
        const next = outcomeNode(node, sub, result, true);
        return withNode(state, next, [ toRecord(next, "finished", result.outcome) ]);
    }
    if (!probe || op?.kind === "apply") {
        // Another apply says nothing about ours; the owner can still close the result
        return stay(state);
    }
    // The helper was dismissed elsewhere: the version still has to be the target
    return status.panel.version === node.to ? withNode(state, { ...node,
        pending: false }) : contradiction(state, node);
}

function onStatus(state : PanelUpdateState, status : PanelUpdateStatus, solicited : boolean, askId : number | null, now : number) : PanelUpdateStep {
    const probe = solicited && askId !== null && askId === state.ctx.probe;
    const next : PanelUpdateState = { ...state,
        ctx: { ...state.ctx,
            status,
            probe: probe ? null : state.ctx.probe } };
    const node = next.node;
    switch (node.name) {
        case "idle":
            return enterIdle(next, now, node.notice);
        case "preview":
            return previewStatus(next, node, now, probe);
        case "running":
            return runningStatus(next, node, now, probe);
        case "outcome":
            return outcomeStatus(next, node, probe, now);
    }
}

// --- ACK ----------------------------------------------------------------------------

function statusAck(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "ACK"; kind : "status" }>) : PanelUpdateStep {
    if (event.result.kind === "ok") {
        return onStatus(state, event.result.status, true, event.ask, event.now);
    }
    const next = event.ask === state.ctx.probe ? { ...state,
        ctx: { ...state.ctx,
            probe: null } } : state;
    if (next.node.name === "idle" && next.node.sub === "loading") {
        // Row 2
        return withNode(next, idleNode("manual", { reason: event.result.kind === "error" && event.result.code === "unreadable" ? "unreadable" : "unsupported" }));
    }
    return stay(next);
}

type RequestAck = Extract<PanelUpdateEvent, { type : "ACK"; kind : "preview" | "apply" | "cancel" | "dismiss" }>;

function previewAck(stateBefore : PanelUpdateState, nodeBefore : PanelUpdatePreviewNode, event : RequestAck) : PanelUpdateStep {
    if (nodeBefore.sub !== "checking" || nodeBefore.request !== event.requestId) {
        return stay(stateBefore);
    }
    // The deadline of the check counts from its acknowledgement: before it, a status may
    // not show the helper yet, and the root bounds the acknowledgement itself
    const node = { ...nodeBefore,
        heardAt: event.now };
    const state = { ...stateBefore,
        node };
    const result = event.result;
    if (result.kind === "ok") {
        return onStatus(state, result.status, true, null, event.now);
    }
    if (result.kind === "error" && result.code === "unreadable") {
        // Docker did not answer and nothing started: back where the owner was, to retry
        return withNode(state, classify(state.ctx, "unreadable"));
    }
    if (result.kind === "error") {
        // Row 7
        return refused(state, node, { kind: "error",
            code: result.code,
            msg: result.msg,
            outcome: null,
            error: null });
    }
    return ask(state, true);
}

function applyRefused(state : PanelUpdateState, node : PanelUpdateRunningNode, error : { code : string; msg : string | null }, now : number) : PanelUpdateStep {
    const clear : PanelUpdateEffect[] = [{ type: "clearPersist" }];
    const back = node.back;
    const preview : PanelUpdatePreviewNode = {
        name: "preview",
        sub: "ready",
        request: back?.previewRequest ?? node.request,
        from: node.from,
        to: node.to,
        preview: back?.preview ?? null,
        expires: back?.expires ?? null,
        dialog: false,
        refusal: null,
        notice: null,
        message: null,
        heardAt: null,
        quiet: false,
    };
    if ((error.code === "password" || error.code === "unreadable") && back && back.expires > now) {
        // Nothing started: the dialog stays for another attempt
        return withNode(state, { ...preview,
            dialog: true,
            notice: error.code,
            message: error.msg }, clear);
    }
    return withNode(state, { ...preview,
        sub: "refused",
        refusal: { kind: "error",
            code: error.code,
            msg: error.msg,
            outcome: null,
            error: null } }, clear);
}

function applyAck(state : PanelUpdateState, node : PanelUpdateRunningNode, event : RequestAck) : PanelUpdateStep {
    const result = event.result;
    const settledAck = withNode(state, { ...node,
        ackPending: false }).state;
    if (result.kind === "ok") {
        return onStatus(settledAck, result.status, true, null, event.now);
    }
    if (result.kind === "error") {
        // Row 12: nothing started, unless a status already showed the helper
        return node.progress === "submitting" && !node.seen ? applyRefused(state, node, result, event.now) : stay(settledAck);
    }
    // Row 13. The panel may still be starting the helper, so the probe waits for
    // LINK_UP or for the quiet deadline counted from now
    return withNode(settledAck, { ...node,
        ackPending: false,
        heardAt: event.now });
}

function cancelAck(state : PanelUpdateState, node : PanelUpdateRunningNode, event : RequestAck) : PanelUpdateStep {
    const result = event.result;
    if (result.kind === "ok") {
        return onStatus(state, result.status, true, null, event.now);
    }
    if (result.kind === "lost" || node.progress !== "cancelling") {
        return stay(state);
    }
    // Row 18
    return withNode(state, { ...node,
        progress: progressOfPhase(node.phase),
        notice: result.code === "too-late" ? "too-late" : "cancel-failed" });
}

function dismissAck(state : PanelUpdateState, event : RequestAck) : PanelUpdateStep {
    if (state.ctx.closed !== event.requestId) {
        return stay(state);
    }
    if (event.result.kind === "ok") {
        return onStatus(state, event.result.status, true, null, event.now);
    }
    // The helper may still be there: let the next status show the result again, so the
    // owner can close it once more
    const reopened : PanelUpdateState = { ...state,
        ctx: { ...state.ctx,
            closed: null } };
    const node = state.node;
    if (node.name !== "idle" || node.sub !== "loading") {
        return stay(reopened);
    }
    return ask(withNode(reopened, { ...node,
        requestedAt: event.now }).state, false);
}

/**
 * A status the panel sends when Docker did not answer. It says nothing about the
 * operation, so it is never read as "no operation": rows 8, 14 and 21 must not fire on it.
 * @param status Status to look at
 * @returns Whether it is that status
 */
export function panelUpdateStatusUnreadable(status : PanelUpdateStatus) : boolean {
    return status.panel.managed === "unknown" && status.panel.reason === "unreadable";
}

const UNREADABLE : PanelUpdateAckResult = { kind: "error",
    code: "unreadable",
    msg: null };

function onAck(state : PanelUpdateState, ack : Extract<PanelUpdateEvent, { type : "ACK" }>) : PanelUpdateStep {
    // An unreadable status in an acknowledgement counts as no answer: the action was taken
    // or refused, but what the panel knows now is unknown
    const unreadable = ack.result.kind === "ok" && panelUpdateStatusUnreadable(ack.result.status);
    const event = unreadable ? { ...ack,
        result: ack.kind === "status" ? UNREADABLE : { kind: "lost" as const } } : ack;
    if (event.kind === "status") {
        return statusAck(state, event);
    }
    const node = state.node;
    if (event.kind === "dismiss") {
        return dismissAck(state, event);
    }
    if (event.kind === "preview") {
        return node.name === "preview" ? previewAck(state, node, event) : stay(state);
    }
    if (node.name !== "running" || node.request !== event.requestId) {
        return stay(state);
    }
    return event.kind === "apply" ? applyAck(state, node, event) : cancelAck(state, node, event);
}

// --- Owner actions ------------------------------------------------------------------

function check(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "CHECK" }>) : PanelUpdateStep {
    const node = state.node;
    const status = state.ctx.status;
    const ready = event.owner && node.name === "idle" && node.sub === "available" && state.ctx.link.kind === "online" && status?.panel.managed === "yes";
    if (!ready || !node.version || !PANEL_VERSION_PATTERN.test(node.version) || !PANEL_UPDATE_REQUEST_PATTERN.test(event.requestId)) {
        return stay(state);
    }
    // Row 5
    return withNode(state, {
        name: "preview",
        sub: "checking",
        request: event.requestId,
        from: status.panel.version,
        to: node.version,
        preview: null,
        expires: null,
        dialog: false,
        refusal: null,
        notice: null,
        message: null,
        heardAt: null,
        quiet: false,
    }, [{ type: "emit",
        kind: "preview",
        args: [ event.requestId, node.version ] }]);
}

function confirm(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "CONFIRM" }>) : PanelUpdateStep {
    const node = state.node;
    if (!event.owner || node.name !== "preview" || node.sub !== "ready" || node.dialog) {
        return stay(state);
    }
    // Row 10
    return withNode(state, { ...node,
        dialog: true,
        notice: null,
        message: null });
}

function submit(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "SUBMIT" }>) : PanelUpdateStep {
    const node = state.node;
    if (!event.owner || node.name !== "preview" || node.sub !== "ready" || !node.dialog || state.ctx.link.kind !== "online") {
        return stay(state);
    }
    if (!event.password || !PANEL_UPDATE_REQUEST_PATTERN.test(event.requestId) || node.expires === null || node.expires <= event.now) {
        return stay(state);
    }
    // Row 11. The password goes into the emit and nowhere else
    const running : PanelUpdateRunningNode = {
        name: "running",
        request: event.requestId,
        from: node.from,
        to: node.to,
        startedAt: event.now,
        phase: null,
        progress: "submitting",
        observer: false,
        seen: false,
        ackPending: true,
        heardAt: event.now,
        quiet: false,
        notice: null,
        back: { previewRequest: node.request,
            preview: node.preview,
            expires: node.expires },
    };
    return withNode(state, running, [ toRecord(running, "submitting"), { type: "emit",
        kind: "apply",
        args: [ event.requestId, node.request, node.to, event.password ] }]);
}

function cancel(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "CANCEL" }>) : PanelUpdateStep {
    const node = state.node;
    if (!event.owner || node.name !== "running" || !panelUpdateCanCancel(state)) {
        return stay(state);
    }
    // Row 17
    return withNode(state, { ...node,
        progress: "cancelling",
        notice: null }, [{ type: "emit",
        kind: "cancel",
        args: [ node.request ] }]);
}

function dismiss(state : PanelUpdateState, event : Extract<PanelUpdateEvent, { type : "DISMISS" }>) : PanelUpdateStep {
    const node = state.node;
    // A page that reloads keeps the record it saved for the new build, as the screen offers no close
    if (!event.owner || node.name !== "outcome" || node.updated === "reloading") {
        return stay(state);
    }
    const closed : PanelUpdateState = { ...state,
        ctx: { ...state.ctx,
            closed: node.request } };
    const clear : PanelUpdateEffect = { type: "clearPersist" };
    if (state.ctx.link.kind !== "online") {
        // Nothing can be sent: close it here, the helper stays until the next dismiss
        return then({ state: closed,
            effects: [ clear ] }, (s) => enterIdle(s, event.now));
    }
    // Row 30
    return withNode(closed, idleNode("loading", { requestedAt: event.now }), [{ type: "emit",
        kind: "dismiss",
        args: [ node.request ] }, clear ]);
}

function close(state : PanelUpdateState) : PanelUpdateStep {
    const node = state.node;
    if (node.name === "preview") {
        if (node.dialog) {
            return withNode(state, { ...node,
                dialog: false,
                notice: null,
                message: null });
        }
        return withNode(state, classify(state.ctx));
    }
    if (node.name === "outcome" && node.updated !== "reloading") {
        const closed = { ...state,
            ctx: { ...state.ctx,
                closed: node.request } };
        return withNode(closed, classify(closed.ctx), [{ type: "clearPersist" }]);
    }
    return stay(state);
}

/**
 * Advance the statechart by one event.
 * @param state Current state; never modified
 * @param event What happened
 * @returns The next state and the effects the caller performs, in order
 */
export function reducePanelUpdate(state : PanelUpdateState, event : PanelUpdateEvent) : PanelUpdateStep {
    switch (event.type) {
        case "BOOT":
            return boot(state, event);
        case "INFO":
            return info(state, event);
        case "STATUS":
            return panelUpdateStatusUnreadable(event.status) ? stay(state) : onStatus(state, event.status, event.solicited, event.ask, event.now);
        case "LINK_UP":
            return linkUp(state, event);
        case "LINK_DOWN":
            return linkDown(state, event);
        case "AUTH_LOST":
            return authLost(state);
        case "ACK":
            return onAck(state, event);
        case "TICK":
            return tick(state, event);
        case "CHECK":
            return check(state, event);
        case "CONFIRM":
            return confirm(state, event);
        case "SUBMIT":
            return submit(state, event);
        case "CANCEL":
            return cancel(state, event);
        case "DISMISS":
            return dismiss(state, event);
        case "CLOSE":
            return close(state);
    }
}

// --- Questions the root and the screens ask -----------------------------------------

/**
 * Cancel is offered while the image is still being fetched (I3)
 * @param state Current state
 * @returns Whether a cancel may be sent
 */
export function panelUpdateCanCancel(state : PanelUpdateState) : boolean {
    const node = state.node;
    return node.name === "running"
        && (node.progress === "starting" || node.progress === "downloading")
        && canCancelPanelUpdate(node.phase ?? undefined)
        && state.ctx.link.kind === "online";
}

function previewDeadline(node : PanelUpdatePreviewNode, link : PanelUpdateLink) : number | null {
    if (node.sub === "checking") {
        return link.kind === "online" && node.heardAt !== null ? node.heardAt + PANEL_UPDATE_CHECK_QUIET_MS : null;
    }
    return node.sub === "ready" ? node.expires : null;
}

/**
 * The next moment a TICK can change the state. The root runs its one-second timer only
 * while this is not null.
 * @param state Current state
 * @returns Time in milliseconds, or null when nothing waits on the clock
 */
export function panelUpdateDeadline(state : PanelUpdateState) : number | null {
    const node = state.node;
    const link = state.ctx.link;
    if (node.name === "idle") {
        return node.sub === "loading" && node.requestedAt !== null ? node.requestedAt + PANEL_UPDATE_LOADING_MS : null;
    }
    if (node.name === "preview") {
        return previewDeadline(node, link);
    }
    if (node.name === "outcome" && node.pending) {
        return link.kind === "online" && node.askedAt !== null ? node.askedAt + PANEL_UPDATE_LOADING_MS : null;
    }
    if (node.name === "outcome") {
        return node.updated === "reloading" && !node.stalled && node.reloadAt !== null ? node.reloadAt + PANEL_UPDATE_RELOAD_STALL_MS : null;
    }
    const deadline = PANEL_UPDATE_DEADLINES[node.progress];
    if (link.kind === "offline") {
        return link.overdue ? null : link.since + deadline;
    }
    return link.kind === "online" && !node.ackPending ? node.heardAt + deadline : null;
}

/**
 * Whether the host commands belong on screen: the result needs the host, or the page has
 * waited past its deadline
 * @param state Current state
 * @returns Which commands, or null
 */
export function panelUpdateHostCase(state : PanelUpdateState) : "status" | "recovery-required" | "unknown" | null {
    const node = state.node;
    if (node.name === "outcome") {
        return node.sub === "recovery-required" || node.sub === "unknown" ? node.sub : null;
    }
    if (node.name !== "running") {
        return null;
    }
    const link = state.ctx.link;
    return (link.kind === "offline" && link.overdue) || node.quiet ? "status" : null;
}

/**
 * While an update runs the page must not reload itself: a reload with the panel down lands
 * on the browser's error page. The one reload it does is on entering `Updated.Reloading`.
 * @param state Current state
 * @returns Whether the reloads and the connection banner are held back
 */
export function panelUpdateSuppressing(state : PanelUpdateState) : boolean {
    return state.node.name === "running" || (state.node.name === "outcome" && state.node.updated === "reloading");
}

/**
 * What the page draws: the overlay for a signed-in owner, a banner that does not block for
 * everyone else and while signing in again, nothing when no operation is followed
 * @param state Current state
 * @param viewer Who is looking
 * @returns The presentation
 */
export function panelUpdateView(state : PanelUpdateState, viewer : { owner : boolean; signedIn : boolean }) : "overlay" | "banner" | "none" {
    const node = state.node;
    const shown = node.name === "running" || (node.name === "outcome" && (node.watched || viewer.owner));
    if (!shown) {
        return "none";
    }
    return viewer.owner && viewer.signedIn && state.ctx.link.kind !== "need-auth" ? "overlay" : "banner";
}

/** Steps of the overlay, in order; a rollback replaces starting and checking the target */
export const PANEL_UPDATE_STEPS = [ "check", "download", "stop", "snapshot", "start", "verify" ] as const;

export type PanelUpdateStepKey = typeof PANEL_UPDATE_STEPS[number] | "rollback";

export interface PanelUpdateStepMark {
    key : PanelUpdateStepKey;
    mark : "done" | "current" | "pending";
}

const STEP_OF_PHASE : Readonly<Record<string, number>> = {
    "prepared": 1,
    "downloaded": 2,
    "stopping": 2,
    "backing-up": 3,
    "starting-target": 4,
    "checking-target": 5,
};

/**
 * The step list with its marks. An unknown phase marks no step as current: the screen
 * says "step unknown" rather than guess.
 * @param phase Furthest phase seen
 * @param finished The operation ended: every step it reached is done
 * @returns Steps in order
 */
export function panelUpdateSteps(phase : string | null, finished = false) : PanelUpdateStepMark[] {
    if (phase === "rolling-back" || (finished && phase === "recovered")) {
        const keys : PanelUpdateStepKey[] = [ "check", "download", "stop", "snapshot", "rollback" ];
        return keys.map((key, index) => ({ key,
            mark: index < keys.length - 1 || finished ? "done" : "current" }));
    }
    const known = phase === null || Object.hasOwn(STEP_OF_PHASE, phase);
    const current = phase === null ? 0 : STEP_OF_PHASE[phase] ?? -1;
    const reached = phase === "success" ? PANEL_UPDATE_STEPS.length : current;
    return PANEL_UPDATE_STEPS.map((key, index) => {
        if (index < reached || (finished && index === reached)) {
            return { key,
                mark: "done" as const };
        }
        return { key,
            mark: known && !finished && index === reached ? "current" as const : "pending" as const };
    });
}

function shellWord(value : string) : string {
    return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The host commands for a case, with the real installation directory when it is known
 * @param kind Which situation the owner is in
 * @param installDir Host path of the installation, absent for other users
 * @param version Target release, for the manual update
 * @returns One command per line, each with sudo
 */
export function panelUpdateCommands(kind : "manual" | "status" | "recovery-required" | "unknown", installDir : string | undefined, version = "") : string[] {
    const dir = installDir && installDir.startsWith("/") ? installDir.replace(/\/+$/, "") : PANEL_UPDATE_DIR_PLACEHOLDER;
    const updater = `sudo ${shellWord(`${dir}/.dockge2/update`)}`;
    if (kind === "manual") {
        const target = PANEL_VERSION_PATTERN.test(version) ? version : "VERSION";
        return [ `${updater} --version ${target} --dry-run`, `${updater} --version ${target} --yes` ];
    }
    const status = `${updater} --status`;
    if (kind === "recovery-required") {
        return [ status, `${updater} --rollback --restore-data` ];
    }
    if (kind === "unknown") {
        return [ status, `${updater} --resume`, `${updater} --rollback` ];
    }
    return [ status ];
}

const HOST_LABELS : Readonly<Record<"manual" | "status" | "recovery-required" | "unknown", readonly (string | null)[]>> = {
    "manual": [],
    "status": [ "panelUpdateHostStatus" ],
    "recovery-required": [ "panelUpdateHostStatus", "panelUpdateHostRestore" ],
    "unknown": [ "panelUpdateHostStatus", "panelUpdateHostResume", "panelUpdateHostRollback" ],
};

/**
 * The host commands with the catalogue key that explains each one
 * @param kind Which situation the owner is in
 * @param installDir Host path of the installation, absent for other users
 * @param version Target release, for the manual update
 * @returns One line per command; the manual commands are explained together
 */
export function panelUpdateHostLines(kind : "manual" | "status" | "recovery-required" | "unknown", installDir : string | undefined, version = "") : { label : string | null; command : string }[] {
    return panelUpdateCommands(kind, installDir, version).map((command, index) => ({ label: HOST_LABELS[kind][index] ?? null,
        command }));
}

/** The line shown while the page cannot hear the panel, by what the update was doing */
const OFFLINE_LINES : Readonly<Record<PanelUpdateProgress, string>> = {
    "submitting": "offline-submitting",
    "starting": "offline-preparing",
    "downloading": "offline-preparing",
    "ready": "offline-preparing",
    "cancelling": "offline-preparing",
    "stopping": "offline-cutover",
    "snapshot": "offline-cutover",
    "target-starting": "offline-cutover",
    "step-unknown": "offline-cutover",
    "verifying": "offline-verifying",
    "finishing": "offline-verifying",
    "rolling-back": "rolling-back",
};

const RESULT_LINES = [ "success", "no-change", "refused", "failed-before-cutover", "recovered", "recovery-required" ];

/**
 * The one status line of the overlay and the banner
 * @param state Current state
 * @returns Catalogue key and its values, or null when no operation is followed
 */
export function panelUpdateLine(state : PanelUpdateState) : { key : string; values : { from : string; to : string } } | null {
    const node = state.node;
    if (node.name === "running") {
        const link = state.ctx.link;
        let line : string = node.progress;
        if (link.kind === "need-auth") {
            line = "need-auth";
        } else if (link.kind === "offline") {
            line = link.overdue ? "overdue" : OFFLINE_LINES[node.progress];
        } else if (node.quiet) {
            line = "quiet";
        }
        return { key: `panelUpdateLine.${line}`,
            values: { from: node.from,
                to: node.to } };
    }
    if (node.name !== "outcome") {
        return null;
    }
    const values = { from: node.from,
        to: node.to };
    if (node.updated === "reloading") {
        return { key: node.stalled ? "panelUpdateReloadStalled" : "panelUpdateReloading",
            values };
    }
    if (node.pending) {
        return { key: "panelUpdateConfirming",
            values };
    }
    return { key: `panelUpdateResult.${RESULT_LINES.includes(node.result.outcome) ? node.result.outcome : "unknown"}`,
        values };
}

/**
 * A request id for the helper labels. `crypto.randomUUID` exists only in a secure
 * context, and a panel on a LAN address over HTTP is not one.
 * @param bytes Sixteen random bytes
 * @returns An id `PANEL_UPDATE_REQUEST_PATTERN` accepts
 */
export function panelUpdateRequestId(bytes : Uint8Array) : string {
    const b = Array.from(bytes.slice(0, 16));
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const hex = b.map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// --- Reading what the server and the storage hand over ------------------------------

function isRecord(value : unknown) : value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value : unknown) : value is string | undefined {
    return value === undefined || typeof value === "string";
}

function readPreview(value : unknown) : PanelUpdatePreview | undefined | null {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value) || typeof value.channel !== "string" || !Array.isArray(value.fields) || !value.fields.every((field) => typeof field === "string") || typeof value.schemaChanges !== "boolean") {
        return null;
    }
    return { channel: value.channel,
        fields: [ ...value.fields as string[] ],
        schemaChanges: value.schemaChanges };
}

function readResult(value : unknown) : PanelUpdateResult | undefined | null {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value) || typeof value.outcome !== "string" || !optionalString(value.code) || !optionalString(value.error) || !optionalString(value.finishedAt)) {
        return null;
    }
    // I5: an outcome this build does not know reads as unknown
    const outcome = (PANEL_UPDATE_OUTCOMES as readonly string[]).includes(value.outcome) ? value.outcome as PanelUpdateOutcome : "unknown";
    const result : PanelUpdateResult = { outcome };
    if (value.code !== undefined) {
        result.code = value.code as NonNullable<PanelUpdateResult["code"]>;
    }
    if (value.error !== undefined) {
        result.error = value.error;
    }
    if (value.finishedAt !== undefined) {
        result.finishedAt = value.finishedAt;
    }
    if (typeof value.restoredData === "boolean") {
        result.restoredData = value.restoredData;
    }
    return result;
}

function readOperation(value : unknown) : PanelUpdateOperation | undefined | null {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value) || typeof value.requestId !== "string" || (value.kind !== "preview" && value.kind !== "apply")) {
        return null;
    }
    if (typeof value.from !== "string" || typeof value.to !== "string" || typeof value.startedAt !== "string" || typeof value.running !== "boolean" || !optionalString(value.phase) || !optionalString(value.op)) {
        return null;
    }
    const preview = readPreview(value.preview);
    const result = readResult(value.result);
    if (preview === null || result === null) {
        return null;
    }
    const op : PanelUpdateOperation = { requestId: value.requestId,
        kind: value.kind,
        from: value.from,
        to: value.to,
        startedAt: value.startedAt,
        running: value.running };
    if (value.op !== undefined) {
        op.op = value.op;
    }
    if (value.phase !== undefined) {
        op.phase = value.phase;
    }
    if (preview) {
        op.preview = preview;
    }
    if (result) {
        op.result = result;
    }
    return op;
}

/**
 * Accept a status only when it is well formed; the page never guesses from half of one.
 * Fields a newer panel adds are ignored.
 * @param value What the socket delivered
 * @returns The status, or null
 */
export function readPanelUpdateStatus(value : unknown) : PanelUpdateStatus | null {
    if (!isRecord(value) || value.schema !== 1 || !isRecord(value.panel)) {
        return null;
    }
    const panel = value.panel;
    if (typeof panel.version !== "string" || (panel.managed !== "yes" && panel.managed !== "no" && panel.managed !== "unknown") || !optionalString(panel.reason) || !optionalString(panel.installDir)) {
        return null;
    }
    const operation = readOperation(value.operation);
    if (operation === null) {
        return null;
    }
    const status : PanelUpdateStatus = { schema: 1,
        panel: { version: panel.version,
            managed: panel.managed } };
    // A reason of a newer panel is dropped: the page falls back as for a status without one
    if (panel.reason !== undefined && Object.hasOwn(MANUAL_REASONS, panel.reason)) {
        status.panel.reason = panel.reason as PanelUpdateManualReason;
    }
    if (panel.installDir !== undefined) {
        status.panel.installDir = panel.installDir;
    }
    if (operation) {
        status.operation = operation;
    }
    return status;
}

/**
 * An acknowledgement as the reducer takes it. Anything that is not a well formed answer is
 * treated as no answer: the page asks for the status rather than guess.
 * @param value What the acknowledgement carried
 * @returns The result
 */
export function readPanelUpdateAck(value : unknown) : PanelUpdateAckResult {
    if (isRecord(value) && value.ok === true) {
        const status = readPanelUpdateStatus(value.status);
        return status ? { kind: "ok",
            status } : { kind: "lost" };
    }
    if (isRecord(value) && value.ok === false) {
        // The transport middleware refuses without a code: a failure all the same
        return { kind: "error",
            code: typeof value.code === "string" && value.code ? value.code : "failed",
            msg: typeof value.msg === "string" && value.msg ? value.msg : null };
    }
    return { kind: "lost" };
}

/**
 * The record `sessionStorage` kept, if it is one this build wrote
 * @param text Stored text
 * @returns The record, or null
 */
export function readPanelUpdateRecord(text : string | null) : PanelUpdateRecord | null {
    let value : unknown;
    try {
        value = text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
    if (!isRecord(value) || value.v !== 1 || typeof value.request !== "string" || !PANEL_UPDATE_REQUEST_PATTERN.test(value.request)) {
        return null;
    }
    if (typeof value.from !== "string" || typeof value.to !== "string" || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) {
        return null;
    }
    const stage = value.stage;
    if ((stage !== "submitting" && stage !== "running" && stage !== "finished") || (value.phase !== null && typeof value.phase !== "string") || (value.outcome !== null && typeof value.outcome !== "string")) {
        return null;
    }
    return { v: 1,
        request: value.request,
        from: value.from,
        to: value.to,
        phase: value.phase as string | null,
        startedAt: value.startedAt,
        stage,
        outcome: value.outcome as string | null };
}
