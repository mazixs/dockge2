/**
 * Updating the panel from the web interface: the contract between the host updater, the
 * panel that observes it and the page. See docs/panel-update-statechart.md.
 *
 * The panel is the thing being replaced, so it keeps no update state in memory. Everything
 * here is derived from the helper container that runs the updater: its labels, its exit
 * code and the JSON lines the updater prints with `--progress json`.
 */

/**
 * Journal phases of a running update, in the order the updater writes them. `rolling-back`
 * follows a target that did not become ready, from whichever phase that was noticed in.
 */
export const PANEL_UPDATE_PHASES = [ "prepared", "downloaded", "stopping", "backing-up", "starting-target", "checking-target", "rolling-back" ] as const;

/** Journal phases after which the updater no longer runs */
export const PANEL_UPDATE_FINAL_PHASES = [ "success", "failed-before-cutover", "recovered", "recovery-required" ] as const;

export type PanelUpdatePhase = typeof PANEL_UPDATE_PHASES[number];

/**
 * How an operation ended. `previewed` is a successful dry run, `refused` anything that
 * failed before the updater recorded an operation, `unknown` a result that cannot be
 * confirmed. Only the observer produces `unknown`; the updater never prints it.
 */
export const PANEL_UPDATE_OUTCOMES = [ "previewed", "success", "no-change", "refused", "failed-before-cutover", "recovered", "recovery-required", "unknown" ] as const;

export type PanelUpdateOutcome = typeof PANEL_UPDATE_OUTCOMES[number];

/** Outcomes that come with exit code 0 */
const SUCCESSFUL_OUTCOMES : ReadonlySet<string> = new Set([ "previewed", "success", "no-change" ]);

/** Why an outcome is `unknown` or `refused` without the updater saying so */
export type PanelUpdateResultCode =
    | "updater-missing"      // the helper could not execute <dir>/.dockge2/update
    | "updater-outdated"     // the installed updater predates --progress json: exit 2, nothing on stdout
    | "start-failed"         // Docker refused to start the helper
    | "no-result"            // the helper exited without a result line and the journal is unreadable
    | "interrupted"          // the journal stopped on a phase that is not final
    | "exit-mismatch"        // the result line and the exit code disagree
    | "version-mismatch";    // success reported, but the answering panel runs another version

/** Why the page shows host commands instead of an Update button */
export type PanelUpdateManualReason =
    | "not-container"        // the panel does not run in a container it can inspect
    | "no-installation"      // the container has no Compose working directory label
    | "updater-missing"      // no installed updater in the installation directory
    | "unsupported"          // the data directory is not a bind mount the updater can back up
    | "unreadable";          // Docker did not answer the inspection

/** A helper runs one of these; `status` only reads the journal */
export type PanelUpdateKind = "preview" | "apply" | "status";

/** Labels on the helper container. The request id comes from the page. */
export const PANEL_UPDATE_LABELS = {
    request: "io.dockge2.update.request",
    kind: "io.dockge2.update.kind",
    installation: "io.dockge2.update.installation",
    from: "io.dockge2.update.from",
    to: "io.dockge2.update.to",
    started: "io.dockge2.update.started",
} as const;

/** A version the browser may name; the updater still verifies the signed release */
export const PANEL_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** A request id the page generates; it becomes a label and part of nothing else */
export const PANEL_UPDATE_REQUEST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How long a finished dry run authorises an apply of its target version */
export const PANEL_UPDATE_PREVIEW_TTL_MS = 10 * 60 * 1000;

/** The longest progress line accepted; longer ones are dropped, not truncated */
export const PANEL_UPDATE_MAX_LINE = 16 * 1024;

/** Socket.IO events of the feature. None of them is an agent event. */
export const PANEL_UPDATE_EVENTS = {
    status: "panelUpdateStatus",
    preview: "panelUpdatePreview",
    apply: "panelUpdateApply",
    cancel: "panelUpdateCancel",
    dismiss: "panelUpdateDismiss",
} as const;

/** Helper containers have fixed names per kind, so Docker refuses a second one atomically */
export function panelUpdateHelperName(project : string, kind : PanelUpdateKind) : string {
    return `dockge2-update-${project}-${kind}`;
}

/** Why an event was refused; the page decides the screen by the code, not by the message */
export type PanelUpdateErrorCode =
    | "invalid"              // an argument failed validation
    | "forbidden"            // no session, or the role may not do this
    | "unreadable"           // Docker did not answer; nothing was started or changed
    | "unmanaged"            // the panel cannot update itself; see panel.reason
    | "updater-missing"      // <dir>/.dockge2 does not exist on the host
    | "busy"                 // a helper of that kind exists; a finished apply has to be dismissed first
    | "name-taken"           // a container that is not a helper of this installation holds the fixed name
    | "password"             // doubleCheckPassword failed
    | "stale-preview"        // no finished dry run of that version from the last ten minutes
    | "too-late"             // cancel after the image was downloaded
    | "running"              // dismiss of a helper that still runs
    | "not-found"            // no helper with that request id
    | "start-failed";        // docker run did not return a container

/**
 * Acknowledgement of every event of the feature. A successful one carries the status as the
 * panel derives it right after the action, so the page never has to guess what happened.
 * The push of the same event name carries a bare `PanelUpdateStatus`, not an acknowledgement.
 */
export type PanelUpdateAck =
    | { ok : true; status : PanelUpdateStatus }
    | { ok : false; code : PanelUpdateErrorCode; msg : string; msgi18n : true };

export interface PanelUpdatePhaseLine {
    dockge2 : "phase";
    v : 1;
    op : string;
    phase : string;
    from : string;
    to : string;
    at : string;
}

export interface PanelUpdatePreviewLine {
    dockge2 : "preview";
    v : 1;
    from : string;
    to : string;
    channel : string;
    /** Names of the Compose fields of the panel service that change; values are never printed */
    fields : string[];
    /** A rollback after the new version started would need the data snapshot */
    schemaChanges : boolean;
}

export interface PanelUpdateResultLine {
    dockge2 : "result";
    v : 1;
    /** Empty when the updater refused before recording an operation */
    op : string;
    outcome : Exclude<PanelUpdateOutcome, "unknown">;
    phase : string;
    from : string;
    to : string;
    error? : string;
    /** The verified snapshot replaced the data the failed target left */
    restoredData? : boolean;
}

export interface PanelUpdateJournalLine {
    dockge2 : "journal";
    v : 1;
    op : string;
    phase : string;
    from : string;
    to : string;
    error? : string;
    /** Only on a recovered journal: whether the verified snapshot replaced the data */
    restoredData? : boolean;
}

export type PanelUpdateLine = PanelUpdatePhaseLine | PanelUpdatePreviewLine | PanelUpdateResultLine | PanelUpdateJournalLine;

/** What the observer reads from `docker inspect` of a helper */
export interface PanelUpdateHelper {
    kind : PanelUpdateKind;
    requestId : string;
    from : string;
    to : string;
    startedAt : string;
    running : boolean;
    exitCode? : number;
    finishedAt? : string;
    /** Docker could not start the entrypoint: the container exists but never ran */
    startError? : string;
}

export interface PanelUpdatePreview {
    channel : string;
    fields : string[];
    schemaChanges : boolean;
}

export interface PanelUpdateResult {
    outcome : PanelUpdateOutcome;
    code? : PanelUpdateResultCode;
    error? : string;
    finishedAt? : string;
    restoredData? : boolean;
}

/** One operation as the page sees it */
export interface PanelUpdateOperation {
    requestId : string;
    kind : "preview" | "apply";
    /** The updater's operation id, once it recorded one */
    op? : string;
    from : string;
    to : string;
    startedAt : string;
    running : boolean;
    /** The furthest phase seen. Unknown values are legal and read as "step unknown". */
    phase? : string;
    preview? : PanelUpdatePreview;
    result? : PanelUpdateResult;
}

/**
 * The status the panel sends. Only ever extended: during verification the old page reads
 * it from the new server, and after a recovery the new page may read it from the old one.
 */
export interface PanelUpdateStatus {
    schema : 1;
    panel : {
        version : string;
        managed : "yes" | "no" | "unknown";
        reason? : PanelUpdateManualReason;
        /** Host path of the installation, for the commands the page shows; owners only */
        installDir? : string;
    };
    operation? : PanelUpdateOperation;
}

/**
 * Order of a phase: -1 before any phase, the index for a running phase, and one rank for
 * every final phase. A phase the build does not know ranks with the running ones it cannot
 * be compared to, so it never moves anything backwards or forwards on its own.
 * @param phase Journal phase, possibly unknown
 * @returns Rank for comparison
 */
export function phaseRank(phase : string | undefined) : number {
    if (!phase) {
        return -1;
    }
    const running = (PANEL_UPDATE_PHASES as readonly string[]).indexOf(phase);
    if (running >= 0) {
        return running;
    }
    return (PANEL_UPDATE_FINAL_PHASES as readonly string[]).includes(phase) ? PANEL_UPDATE_PHASES.length : -1;
}

/**
 * Cancel is offered only while the image is still being fetched. From `downloaded` to
 * `stopping` there are seconds, and a cancel that loses that race costs a stop and a start.
 * @param phase Furthest phase seen
 * @returns Whether a cancel may be sent
 */
export function canCancelPanelUpdate(phase : string | undefined) : boolean {
    return phaseRank(phase) < phaseRank("downloaded");
}

function isString(value : unknown) : value is string {
    return typeof value === "string";
}

function isStringArray(value : unknown) : value is string[] {
    return Array.isArray(value) && value.every(isString);
}

type Fields = Record<string, unknown> & { from : string; to : string };

function phaseLine(v : Fields) : PanelUpdatePhaseLine | undefined {
    if (!isString(v.op) || !isString(v.phase) || !isString(v.at)) {
        return undefined;
    }
    return {
        dockge2: "phase",
        v: 1,
        op: v.op,
        phase: v.phase,
        from: v.from,
        to: v.to,
        at: v.at,
    };
}

function previewLine(v : Fields) : PanelUpdatePreviewLine | undefined {
    if (!isString(v.channel) || !isStringArray(v.fields) || typeof v.schemaChanges !== "boolean") {
        return undefined;
    }
    return {
        dockge2: "preview",
        v: 1,
        from: v.from,
        to: v.to,
        channel: v.channel,
        fields: v.fields,
        schemaChanges: v.schemaChanges,
    };
}

function resultLine(v : Fields) : PanelUpdateResultLine | undefined {
    const outcome = v.outcome;
    if (!isString(v.op) || !isString(v.phase) || !isString(outcome) || outcome === "unknown" || !(PANEL_UPDATE_OUTCOMES as readonly string[]).includes(outcome)) {
        return undefined;
    }
    const line : PanelUpdateResultLine = {
        dockge2: "result",
        v: 1,
        op: v.op,
        outcome: outcome as PanelUpdateResultLine["outcome"],
        phase: v.phase,
        from: v.from,
        to: v.to,
    };
    if (isString(v.error)) {
        line.error = v.error;
    }
    if (typeof v.restoredData === "boolean") {
        line.restoredData = v.restoredData;
    }
    return line;
}

function journalLine(v : Fields) : PanelUpdateJournalLine | undefined {
    if (!isString(v.op) || !isString(v.phase)) {
        return undefined;
    }
    const line : PanelUpdateJournalLine = {
        dockge2: "journal",
        v: 1,
        op: v.op,
        phase: v.phase,
        from: v.from,
        to: v.to,
    };
    if (isString(v.error)) {
        line.error = v.error;
    }
    if (typeof v.restoredData === "boolean") {
        line.restoredData = v.restoredData;
    }
    return line;
}

const LINE_PARSERS : Record<string, (v : Fields) => PanelUpdateLine | undefined> = {
    phase: phaseLine,
    preview: previewLine,
    result: resultLine,
    journal: journalLine,
};

/**
 * Parse one line of updater output. Anything that is not a well formed line of schema 1
 * is dropped: human text, a line of a newer schema, a line cut by the log driver.
 * @param line One line of the helper's stdout
 * @returns The line, or undefined
 */
export function parsePanelUpdateLine(line : string) : PanelUpdateLine | undefined {
    if (line.length > PANEL_UPDATE_MAX_LINE || !line.startsWith("{")) {
        return undefined;
    }
    let value : unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    const v = value as Record<string, unknown>;
    if (v.v !== 1 || !isString(v.from) || !isString(v.to) || !isString(v.dockge2) || !Object.hasOwn(LINE_PARSERS, v.dockge2)) {
        return undefined;
    }
    return LINE_PARSERS[v.dockge2]?.(v as Fields);
}

/** Journal phase of a finished operation to the outcome it stands for */
function journalOutcome(phase : string) : PanelUpdateOutcome | undefined {
    return (PANEL_UPDATE_FINAL_PHASES as readonly string[]).includes(phase) ? phase as PanelUpdateOutcome : undefined;
}

/** Keep the furthest phase; a late or unknown one never moves the operation back */
function advancePhase(operation : PanelUpdateOperation, phase : string) : void {
    if (phaseRank(phase) >= phaseRank(operation.phase)) {
        operation.phase = phase;
    }
}

/** Fold the phase and preview lines into the operation and return the last result line */
function foldLines(operation : PanelUpdateOperation, lines : readonly PanelUpdateLine[]) : PanelUpdateResultLine | undefined {
    let result : PanelUpdateResultLine | undefined;
    for (const line of lines) {
        if (line.dockge2 === "phase") {
            operation.op ??= line.op;
            advancePhase(operation, line.phase);
        } else if (line.dockge2 === "preview") {
            operation.preview = {
                channel: line.channel,
                fields: [ ...line.fields ],
                schemaChanges: line.schemaChanges,
            };
        } else if (line.dockge2 === "result") {
            result = line;
        }
    }
    return result;
}

/** The result the updater printed, checked against the exit code and the answering version */
function fromResultLine(operation : PanelUpdateOperation, line : PanelUpdateResultLine, exitCode : number | undefined, panelVersion : string) : PanelUpdateResult {
    if (line.op) {
        operation.op = line.op;
    }
    advancePhase(operation, line.phase);
    if (SUCCESSFUL_OUTCOMES.has(line.outcome) !== (exitCode === 0)) {
        return {
            outcome: "unknown",
            code: "exit-mismatch",
        };
    }
    if (line.outcome === "success" && operation.kind === "apply" && line.to !== panelVersion) {
        return {
            outcome: "unknown",
            code: "version-mismatch",
        };
    }
    const value : PanelUpdateResult = { outcome: line.outcome };
    if (line.error !== undefined) {
        value.error = line.error;
    }
    if (line.restoredData !== undefined) {
        value.restoredData = line.restoredData;
    }
    return value;
}

/** Time of an updater operation id, `20060102T150405.000000000` in UTC, in milliseconds */
function operationTime(op : string) : number | undefined {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})\d{6}$/.exec(op);
    if (!m) {
        return undefined;
    }
    const [ , year, month, day, hour, minute, second, ms ] = m.map(Number) as number[];
    return Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, ms!);
}

/**
 * Whether the journal is about this helper's operation. It keeps the last operation of the
 * installation, so a helper killed before its first phase line would otherwise take the
 * result of an earlier update as its own. Without an id from the lines, the operation has
 * to be the same versions and recorded after the helper started; both times come from the
 * host clock.
 */
function journalBelongs(operation : PanelUpdateOperation, journal : PanelUpdateJournalLine, helper : PanelUpdateHelper) : boolean {
    if (journal.from !== helper.from || journal.to !== helper.to) {
        return false;
    }
    if (operation.op) {
        return journal.op === operation.op;
    }
    const recorded = operationTime(journal.op);
    const started = Date.parse(helper.startedAt);
    return recorded !== undefined && Number.isFinite(started) && recorded >= started;
}

/** Where the journal on the host says an operation without a result line stopped */
function fromJournal(operation : PanelUpdateOperation, journal : PanelUpdateJournalLine, panelVersion : string) : PanelUpdateResult {
    operation.op = journal.op;
    advancePhase(operation, journal.phase);
    const outcome = journalOutcome(journal.phase);
    let value : PanelUpdateResult;
    if (outcome === undefined) {
        value = {
            outcome: "unknown",
            code: "interrupted",
        };
    } else if (outcome === "success" && journal.to !== panelVersion) {
        value = {
            outcome: "unknown",
            code: "version-mismatch",
        };
    } else {
        value = { outcome };
    }
    if (journal.error !== undefined) {
        value.error = journal.error;
    }
    // An older updater leaves it out: whether the data was restored stays unknown
    if (journal.restoredData !== undefined) {
        value.restoredData = journal.restoredData;
    }
    return value;
}

/**
 * A helper that never ran the update: the updater is missing, Docker refused the container,
 * or an updater older than `--progress json` rejected the flag - Go's flag parser exits 2
 * before printing anything, while a current updater prints a result line on every path.
 */
function startFailure(helper : PanelUpdateHelper, lines : readonly PanelUpdateLine[]) : PanelUpdateResult | undefined {
    const missing = helper.exitCode === 126 || helper.exitCode === 127;
    if (helper.startError !== undefined || (missing && lines.length === 0)) {
        return {
            outcome: "refused",
            code: missing ? "updater-missing" : "start-failed",
        };
    }
    if (helper.exitCode === 2 && lines.length === 0) {
        return {
            outcome: "refused",
            code: "updater-outdated",
        };
    }
    return undefined;
}

/**
 * Derive one operation from its helper, fail closed. Success needs the updater's result
 * line, exit code 0 and, for an apply, the answering panel running the target version.
 * @param helper The helper as `docker inspect` shows it
 * @param lines Parsed stdout lines of the helper, in order
 * @param panelVersion Version of the panel doing the deriving
 * @param journal The journal read by a status helper, when the apply helper left no result
 * @returns The operation for the status
 */
export function derivePanelUpdateOperation(helper : PanelUpdateHelper, lines : readonly PanelUpdateLine[], panelVersion : string, journal? : PanelUpdateJournalLine) : PanelUpdateOperation {
    const operation : PanelUpdateOperation = {
        requestId: helper.requestId,
        kind: helper.kind === "apply" ? "apply" : "preview",
        from: helper.from,
        to: helper.to,
        startedAt: helper.startedAt,
        running: helper.running,
    };
    const line = foldLines(operation, lines);
    if (helper.running) {
        return operation;
    }
    let result = startFailure(helper, lines);
    if (!result && line) {
        result = fromResultLine(operation, line, helper.exitCode, panelVersion);
    }
    // No result line: the helper was killed, the daemon restarted or the log was lost.
    // The journal on the host still knows where the operation stopped.
    if (!result && operation.kind === "apply" && journal && journalBelongs(operation, journal, helper)) {
        result = fromJournal(operation, journal, panelVersion);
    }
    result ??= {
        outcome: "unknown",
        code: "no-result",
    };
    if (helper.finishedAt) {
        result.finishedAt = helper.finishedAt;
    }
    operation.result = result;
    return operation;
}
