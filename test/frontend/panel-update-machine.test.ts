import { strict as assert } from "node:assert";
import test from "node:test";
import {
    PANEL_UPDATE_OUTCOMES,
    PANEL_UPDATE_PHASES,
    canCancelPanelUpdate,
    phaseRank,
    type PanelUpdateOperation,
    type PanelUpdateStatus,
} from "../../common/panel-update";
import {
    PANEL_UPDATE_CHECK_QUIET_MS,
    PANEL_UPDATE_DEADLINES,
    PANEL_UPDATE_DIR_PLACEHOLDER,
    PANEL_UPDATE_ERROR_CODES,
    PANEL_UPDATE_MANUAL_REASONS,
    PANEL_UPDATE_LOADING_MS,
    PANEL_UPDATE_RELOAD_STALL_MS,
    PANEL_UPDATE_STEPS,
    createPanelUpdateState,
    panelUpdateCanCancel,
    panelUpdateCommands,
    panelUpdateDeadline,
    panelUpdateHostCase,
    panelUpdateHostLines,
    panelUpdateLine,
    panelUpdateRequestId,
    panelUpdateSteps,
    panelUpdateSuppressing,
    panelUpdateView,
    readPanelUpdateAck,
    readPanelUpdateRecord,
    readPanelUpdateStatus,
    reducePanelUpdate,
    type PanelUpdateEffect,
    type PanelUpdateEvent,
    type PanelUpdateRecord,
    type PanelUpdateState,
    type PanelUpdateStep,
} from "../../frontend/src/panel-update-machine";
import en from "../../frontend/src/lang/en.json" with { type: "json" };
import ru from "../../frontend/src/lang/ru.json" with { type: "json" };

// Invented data only
const T0 = 1_900_000_000_000;
const FROM = "0.0.13";
const TO = "0.0.14";
const PREVIEW_ID = "0a1b2c3d-0000-4000-8000-000000000001";
const APPLY_ID = "0a1b2c3d-0000-4000-8000-000000000002";
const NEXT_ID = "0a1b2c3d-0000-4000-8000-000000000003";
const FOREIGN_ID = "0a1b2c3d-0000-4000-8000-00000000000f";
const PASSWORD = "invented-password-7";
const PREVIEW = { channel: "stable",
    fields: [ "image" ],
    schemaChanges: true };

const iso = (time : number) => new Date(time).toISOString();

interface OpOptions {
    running? : boolean;
    phase? : string;
    outcome? : string;
    code? : string;
    restoredData? : boolean;
    to? : string;
    finishedAt? : number;
}

function applyOp(requestId : string, options : OpOptions = {}) : PanelUpdateOperation {
    const op : PanelUpdateOperation = { requestId,
        kind: "apply",
        from: FROM,
        to: options.to ?? TO,
        startedAt: iso(T0),
        running: options.running ?? options.outcome === undefined };
    if (options.phase !== undefined) {
        op.phase = options.phase;
    }
    if (options.outcome !== undefined) {
        op.result = { outcome: options.outcome as never,
            finishedAt: iso(options.finishedAt ?? T0) };
        if (options.code !== undefined) {
            op.result.code = options.code as never;
        }
        if (options.restoredData !== undefined) {
            op.result.restoredData = options.restoredData;
        }
    }
    return op;
}

function previewOp(requestId : string, options : OpOptions = {}) : PanelUpdateOperation {
    const op : PanelUpdateOperation = { requestId,
        kind: "preview",
        from: FROM,
        to: options.to ?? TO,
        startedAt: iso(T0),
        running: options.running ?? false };
    if (!op.running) {
        op.result = { outcome: (options.outcome ?? "previewed") as never,
            finishedAt: iso(options.finishedAt ?? T0) };
        if (options.code !== undefined) {
            op.result.code = options.code as never;
        }
        if (op.result.outcome === "previewed") {
            op.preview = PREVIEW;
        }
    }
    return op;
}

function status(op? : PanelUpdateOperation, version = FROM, managed : "yes" | "no" | "unknown" = "yes") : PanelUpdateStatus {
    const result : PanelUpdateStatus = { schema: 1,
        panel: { version,
            managed,
            installDir: "/srv/dockge2" } };
    if (managed === "no") {
        result.panel.reason = "not-container";
    }
    if (op) {
        result.operation = op;
    }
    return result;
}

interface Run {
    state : PanelUpdateState;
    effects : PanelUpdateEffect[];
}

function drive(state : PanelUpdateState, ...events : PanelUpdateEvent[]) : Run {
    let current = state;
    const effects : PanelUpdateEffect[] = [];
    for (const event of events) {
        const step = reducePanelUpdate(current, event);
        current = step.state;
        effects.push(...step.effects);
    }
    return { state: current,
        effects };
}

const push = (s : PanelUpdateStatus, now = T0) : PanelUpdateEvent => ({ type: "STATUS",
    status: s,
    solicited: false,
    ask: null,
    now });

/** The answer to the last status request the page sent */
const answer = (state : PanelUpdateState, s : PanelUpdateStatus, now = T0) : PanelUpdateEvent => ({ type: "ACK",
    kind: "status",
    ask: state.ctx.ask,
    result: { kind: "ok",
        status: s },
    now });

/** Drop the connection, come back, and answer the status request that LINK_UP sends */
function reconnect(state : PanelUpdateState, s : PanelUpdateStatus, now = T0) : Run {
    const back = drive(state, { type: "LINK_DOWN",
        now }, { type: "LINK_UP",
        now });
    const asked = back.effects.find((effect) => effect.type === "requestStatus");
    assert.ok(asked, "LINK_UP asks for the status");
    const step = reducePanelUpdate(back.state, answer(back.state, s, now));
    return { state: step.state,
        effects: [ ...back.effects, ...step.effects ] };
}

function online(latest = TO, available = true) : PanelUpdateState {
    return drive(createPanelUpdateState(), { type: "BOOT",
        persisted: null,
        now: T0 }, { type: "INFO",
        latestVersion: latest,
        updateAvailable: available }, { type: "LINK_UP",
        now: T0 }).state;
}

function idle(s = status(), latest = TO, available = true) : PanelUpdateState {
    const state = online(latest, available);
    return drive(state, answer(state, s)).state;
}

const checking = () => drive(idle(), { type: "CHECK",
    owner: true,
    requestId: PREVIEW_ID }).state;

const ready = () => drive(checking(), push(status(previewOp(PREVIEW_ID)))).state;

const dialog = () => drive(ready(), { type: "CONFIRM",
    owner: true }).state;

const submit = (now = T0 + 1_000) : PanelUpdateEvent => ({ type: "SUBMIT",
    owner: true,
    password: PASSWORD,
    requestId: APPLY_ID,
    now });

const submitting = () => drive(dialog(), submit()).state;

function running(phase? : string) : PanelUpdateState {
    const options : OpOptions = phase === undefined ? {} : { phase };
    return drive(submitting(), { type: "ACK",
        kind: "apply",
        requestId: APPLY_ID,
        result: { kind: "ok",
            status: status(applyOp(APPLY_ID, options)) },
        now: T0 + 2_000 }).state;
}

function record(stage : PanelUpdateRecord["stage"], phase : string | null, outcome : string | null = null) : PanelUpdateRecord {
    return { v: 1,
        request: APPLY_ID,
        from: FROM,
        to: TO,
        phase,
        startedAt: T0,
        stage,
        outcome };
}

const booted = (persisted : PanelUpdateRecord | null) => reducePanelUpdate(createPanelUpdateState(), { type: "BOOT",
    persisted,
    now: T0 });

function node<N extends PanelUpdateState["node"]["name"]>(state : PanelUpdateState, name : N) : Extract<PanelUpdateState["node"], { name : N }> {
    assert.equal(state.node.name, name, `expected ${name}, got ${JSON.stringify(state.node)}`);
    return state.node as Extract<PanelUpdateState["node"], { name : N }>;
}

// --- The transition table, row by row ----------------------------------------------

interface Row {
    row : string;
    name : string;
    check : () => void;
}

const ROWS : Row[] = [
    { row: "1",
        name: "a status without an operation settles Idle: available, current, manual",
        check: () => {
            assert.equal(node(idle(), "idle").sub, "available");
            assert.equal(node(idle(), "idle").version, TO);
            assert.equal(node(idle(status(), FROM, false), "idle").sub, "current");
            const manual = node(idle(status(undefined, FROM, "no")), "idle");
            assert.equal(manual.sub, "manual");
            assert.equal(manual.reason, "not-container");
        } },
    { row: "1-",
        name: "the release that is already running is not an update",
        check: () => assert.equal(node(idle(status(undefined, TO), TO, true), "idle").sub, "current") },
    { row: "2",
        name: "a lost status answer or 15 s without one turns Loading into Manual",
        check: () => {
            const state = online();
            const lost = drive(state, { type: "ACK",
                kind: "status",
                ask: state.ctx.ask,
                result: { kind: "lost" },
                now: T0 });
            assert.equal(node(lost.state, "idle").sub, "manual");
            assert.equal(node(lost.state, "idle").reason, "unsupported");
            assert.equal(node(drive(state, { type: "TICK",
                now: T0 + PANEL_UPDATE_LOADING_MS - 1 }).state, "idle").sub, "loading");
            assert.equal(node(drive(state, { type: "TICK",
                now: T0 + PANEL_UPDATE_LOADING_MS }).state, "idle").sub, "manual");
            assert.equal(panelUpdateDeadline(state), T0 + PANEL_UPDATE_LOADING_MS);
        } },
    { row: "3",
        name: "an apply that runs is followed as an observer and persisted",
        check: () => {
            const run = drive(online(), push(status(applyOp(FOREIGN_ID, { phase: "prepared" }))));
            const observed = node(run.state, "running");
            assert.equal(observed.request, FOREIGN_ID);
            assert.equal(observed.observer, true);
            assert.equal(observed.progress, "downloading");
            assert.deepEqual(run.effects.map((effect) => effect.type), [ "persist" ]);
        } },
    { row: "4",
        name: "an apply that finished before the page looked is shown, without a reload",
        check: () => {
            const rolled = drive(online(), push(status(applyOp(FOREIGN_ID, { outcome: "recovered",
                restoredData: true }))));
            const outcome = node(rolled.state, "outcome");
            assert.equal(outcome.sub, "rolled-back");
            assert.equal(outcome.result.restoredData, true);
            assert.equal(outcome.watched, false);
            assert.deepEqual(rolled.effects, []);
            // Without the updater's word on the data the page claims neither restored nor kept
            for (const [ restoredData, kept ] of [[ false, false ], [ undefined, null ]] as const) {
                const options : OpOptions = { outcome: "recovered" };
                if (restoredData !== undefined) {
                    options.restoredData = restoredData;
                }
                assert.equal(node(drive(online(), push(status(applyOp(FOREIGN_ID, options)))).state, "outcome").result.restoredData, kept);
            }
            const updated = drive(online(), push(status(applyOp(FOREIGN_ID, { outcome: "success" }), TO)));
            assert.equal(node(updated.state, "outcome").updated, "shown");
            assert.deepEqual(updated.effects, []);
        } },
    { row: "4+",
        name: "a page of the old build that finds the update finished loads the new build first",
        check: () => {
            const boot = (build : string) => drive(createPanelUpdateState(), { type: "BOOT",
                persisted: null,
                now: T0,
                build }, { type: "LINK_UP",
                now: T0 }).state;
            const success = status(applyOp(FOREIGN_ID, { outcome: "success" }), TO);
            const old = drive(boot(FROM), push(success));
            assert.equal(node(old.state, "outcome").updated, "reloading");
            assert.equal(old.effects.at(-1)?.type, "reload");
            const saved = old.effects.find((effect) => effect.type === "persist");
            assert.ok(saved?.type === "persist" && saved.record.stage === "finished" && saved.record.outcome === "success");
            // The screen offers no close while it reloads, and the reducer keeps the record too
            for (const leave of [{ type: "DISMISS",
                owner: true,
                now: T0 }, { type: "CLOSE" }] as PanelUpdateEvent[]) {
                assert.deepEqual(drive(old.state, leave).effects, []);
            }
            // The new build shows it from the record and reloads no more
            const after = drive(createPanelUpdateState(), { type: "BOOT",
                persisted: saved.record,
                now: T0,
                build: TO }, { type: "LINK_UP",
                now: T0 });
            const shown = drive(after.state, answer(after.state, success));
            assert.equal(node(shown.state, "outcome").pending, false);
            assert.ok(!shown.effects.some((effect) => effect.type === "reload"));
            const current = drive(boot(TO), push(success));
            assert.equal(node(current.state, "outcome").updated, "shown");
            assert.deepEqual(current.effects, []);
        } },
    { row: "5",
        name: "CHECK from Available sends a preview with a new request id",
        check: () => {
            const run = drive(idle(), { type: "CHECK",
                owner: true,
                requestId: PREVIEW_ID });
            assert.equal(node(run.state, "preview").sub, "checking");
            assert.deepEqual(run.effects, [{ type: "emit",
                kind: "preview",
                args: [ PREVIEW_ID, TO ] }]);
        } },
    { row: "5-",
        name: "CHECK is ignored for other users, offline, with a bad id or with nothing to install",
        check: () => {
            const base = idle();
            for (const state of [ base, drive(base, { type: "LINK_DOWN",
                now: T0 }).state, idle(status(), FROM, false) ]) {
                for (const event of [{ owner: false,
                    requestId: PREVIEW_ID }, { owner: true,
                    requestId: "not-a-uuid" }]) {
                    const run = drive(state, { type: "CHECK",
                        ...event });
                    assert.equal(run.state.node.name, "idle");
                    assert.deepEqual(run.effects, []);
                }
            }
            assert.equal(drive(drive(base, { type: "LINK_DOWN",
                now: T0 }).state, { type: "CHECK",
                owner: true,
                requestId: PREVIEW_ID }).state.node.name, "idle");
        } },
    { row: "6",
        name: "our finished dry run makes Ready, valid for ten minutes from its end",
        check: () => {
            const preview = node(ready(), "preview");
            assert.equal(preview.sub, "ready");
            assert.deepEqual(preview.preview, PREVIEW);
            assert.equal(preview.expires, T0 + 600_000);
        } },
    { row: "7",
        name: "a refused dry run or a refused acknowledgement makes Refused",
        check: () => {
            const byResult = node(drive(checking(), push(status(previewOp(PREVIEW_ID, { outcome: "refused",
                code: "updater-outdated" })))).state, "preview");
            assert.equal(byResult.sub, "refused");
            assert.equal(byResult.refusal?.code, "updater-outdated");
            const byAck = node(drive(checking(), { type: "ACK",
                kind: "preview",
                requestId: PREVIEW_ID,
                result: { kind: "error",
                    code: "busy",
                    msg: null },
                now: T0 }).state, "preview");
            assert.equal(byAck.sub, "refused");
            assert.equal(byAck.refusal?.kind, "error");
            assert.equal(byAck.refusal?.code, "busy");
        } },
    { row: "7-",
        name: "a foreign dry run and a still running one leave Checking alone",
        check: () => {
            assert.equal(node(drive(checking(), push(status(previewOp(FOREIGN_ID)))).state, "preview").sub, "checking");
            assert.equal(node(drive(checking(), push(status(previewOp(PREVIEW_ID, { running: true })))).state, "preview").sub, "checking");
            assert.equal(node(drive(checking(), { type: "ACK",
                kind: "preview",
                requestId: FOREIGN_ID,
                result: { kind: "error",
                    code: "busy",
                    msg: null },
                now: T0 }).state, "preview").sub, "checking");
        } },
    { row: "8",
        name: "the solicited status after reconnecting without our dry run makes Refused(lost)",
        check: () => {
            const preview = node(reconnect(checking(), status()).state, "preview");
            assert.equal(preview.sub, "refused");
            assert.equal(preview.refusal?.kind, "lost");
        } },
    { row: "8-",
        name: "a push without our dry run is not proof that it is gone",
        check: () => assert.equal(node(drive(checking(), push(status())).state, "preview").sub, "checking") },
    { row: "8+",
        name: "a check that goes unheard asks again, and keeps waiting while Docker cannot be read",
        check: () => {
            const QUIET = PANEL_UPDATE_CHECK_QUIET_MS;
            const pending = checking();
            // Until the acknowledgement the root bounds the wait; a status may not show the helper yet
            assert.equal(panelUpdateDeadline(pending), null);
            const acked = drive(pending, { type: "ACK",
                kind: "preview",
                requestId: PREVIEW_ID,
                result: { kind: "ok",
                    status: status(previewOp(PREVIEW_ID, { running: true })) },
                now: T0 }).state;
            assert.equal(node(acked, "preview").sub, "checking");
            assert.equal(panelUpdateDeadline(acked), T0 + QUIET);
            assert.deepEqual(drive(acked, { type: "TICK",
                now: T0 + QUIET - 1 }).effects, []);
            // News of the running check moves the deadline
            assert.equal(panelUpdateDeadline(drive(acked, push(status(previewOp(PREVIEW_ID, { running: true })), T0 + 30_000)).state), T0 + 30_000 + QUIET);

            // The final push was lost: the deadline asks, and the answer finishes the check
            const asked = drive(acked, { type: "TICK",
                now: T0 + QUIET });
            assert.deepEqual(asked.effects.map((effect) => effect.type), [ "requestStatus" ]);
            assert.equal(node(asked.state, "preview").quiet, true);
            assert.equal(node(drive(asked.state, answer(asked.state, status(previewOp(PREVIEW_ID)), T0 + QUIET)).state, "preview").sub, "ready");
            // The answer to that request without the helper says it is gone
            assert.equal(node(drive(asked.state, answer(asked.state, status(), T0 + QUIET)).state, "preview").refusal?.kind, "lost");

            // Docker cannot be read: still checking, and the next deadline asks again
            const unreadable = status(undefined, FROM, "unknown");
            unreadable.panel.reason = "unreadable";
            const waiting = drive(asked.state, answer(asked.state, unreadable, T0 + QUIET)).state;
            assert.equal(node(waiting, "preview").sub, "checking");
            assert.equal(node(waiting, "preview").quiet, true);
            assert.equal(panelUpdateDeadline(waiting), T0 + 2 * QUIET);
            assert.deepEqual(drive(waiting, { type: "TICK",
                now: T0 + 2 * QUIET }).effects.map((effect) => effect.type), [ "requestStatus" ]);

            // Offline the clock stops; the link coming back asks at once and counts again
            const down = drive(acked, { type: "LINK_DOWN",
                now: T0 + 1 }).state;
            assert.equal(panelUpdateDeadline(down), null);
            const up = drive(down, { type: "LINK_UP",
                now: T0 + 2 });
            assert.equal(panelUpdateDeadline(up.state), T0 + 2 + QUIET);
            assert.deepEqual(up.effects.map((effect) => effect.type), [ "requestStatus" ]);
            // A lost acknowledgement asks at once and starts the deadline
            const lost = drive(pending, { type: "ACK",
                kind: "preview",
                requestId: PREVIEW_ID,
                result: { kind: "lost" },
                now: T0 + 5 });
            assert.deepEqual(lost.effects.map((effect) => effect.type), [ "requestStatus" ]);
            assert.equal(panelUpdateDeadline(lost.state), T0 + 5 + QUIET);
        } },
    { row: "9",
        name: "an expired dry run returns to Available with check again",
        check: () => {
            const state = ready();
            assert.equal(panelUpdateDeadline(state), T0 + 600_000);
            assert.equal(node(drive(state, { type: "TICK",
                now: T0 + 599_999 }).state, "preview").sub, "ready");
            const back = node(drive(state, { type: "TICK",
                now: T0 + 600_000 }).state, "idle");
            assert.equal(back.sub, "available");
            assert.equal(back.notice, "preview-expired");
        } },
    { row: "10",
        name: "CONFIRM opens the password dialog and CLOSE closes it, then the preview",
        check: () => {
            assert.equal(node(dialog(), "preview").dialog, true);
            const closed = drive(dialog(), { type: "CLOSE" }).state;
            assert.equal(node(closed, "preview").dialog, false);
            assert.equal(node(drive(closed, { type: "CLOSE" }).state, "idle").sub, "available");
            assert.equal(node(drive(ready(), { type: "CONFIRM",
                owner: false }).state, "preview").dialog, false);
        } },
    { row: "11",
        name: "SUBMIT sends the apply and persists the operation without the password",
        check: () => {
            const run = drive(dialog(), submit());
            const sub = node(run.state, "running");
            assert.equal(sub.progress, "submitting");
            assert.equal(sub.request, APPLY_ID);
            assert.deepEqual(run.effects.map((effect) => effect.type), [ "persist", "emit" ]);
            assert.deepEqual(run.effects[1], { type: "emit",
                kind: "apply",
                args: [ APPLY_ID, PREVIEW_ID, TO, PASSWORD ] });
            assert.ok(!JSON.stringify(run.effects[0]).includes(PASSWORD));
            assert.ok(!JSON.stringify(run.state).includes(PASSWORD));
        } },
    { row: "11-",
        name: "SUBMIT needs the open dialog, a password, a live dry run and a connection",
        check: () => {
            const cases : [PanelUpdateState, PanelUpdateEvent][] = [
                [ ready(), submit() ],
                [ dialog(), { ...submit(),
                    password: "" } as PanelUpdateEvent ],
                [ dialog(), submit(T0 + 600_000) ],
                [ dialog(), { ...submit(),
                    owner: false } as PanelUpdateEvent ],
                [ drive(dialog(), { type: "LINK_DOWN",
                    now: T0 }).state, submit() ],
            ];
            for (const [ state, event ] of cases) {
                const run = drive(state, event);
                assert.equal(run.state.node.name, "preview");
                assert.deepEqual(run.effects, []);
            }
        } },
    { row: "12",
        name: "a refused apply clears the record: wrong password reopens the dialog, the rest refuse",
        check: () => {
            const refuse = (code : string, msg : string | null = null) => drive(submitting(), { type: "ACK",
                kind: "apply",
                requestId: APPLY_ID,
                result: { kind: "error",
                    code,
                    msg },
                now: T0 + 2_000 });
            const wrong = refuse("password");
            const again = node(wrong.state, "preview");
            assert.equal(again.sub, "ready");
            assert.equal(again.dialog, true);
            assert.equal(again.notice, "password");
            assert.equal(again.message, null);
            assert.equal(again.request, PREVIEW_ID);
            assert.deepEqual(wrong.effects, [{ type: "clearPersist" }]);
            // The attempt limit is said as such, not as one more wrong password
            assert.equal(node(refuse("password", "tooManyPasswordAttempts").state, "preview").message, "tooManyPasswordAttempts");
            for (const code of [ "busy", "stale-preview" ]) {
                const run = refuse(code);
                assert.equal(node(run.state, "preview").sub, "refused");
                assert.equal(node(run.state, "preview").refusal?.code, code);
                assert.deepEqual(run.effects, [{ type: "clearPersist" }]);
            }
        } },
    { row: "13",
        name: "a lost apply acknowledgement keeps Submitting and asks after reconnecting",
        check: () => {
            const lost = drive(submitting(), { type: "ACK",
                kind: "apply",
                requestId: APPLY_ID,
                result: { kind: "lost" },
                now: T0 + 5_000 });
            assert.equal(node(lost.state, "running").progress, "submitting");
            assert.deepEqual(lost.effects, []);
            assert.equal(panelUpdateDeadline(lost.state), T0 + 5_000 + PANEL_UPDATE_DEADLINES.submitting);
            const back = drive(lost.state, { type: "LINK_DOWN",
                now: T0 }, { type: "LINK_UP",
                now: T0 });
            assert.ok(back.effects.some((effect) => effect.type === "requestStatus"));
        } },
    { row: "14",
        name: "no helper in the solicited status after reconnecting: nothing started",
        check: () => {
            const run = reconnect(submitting(), status(), T0 + 3_000);
            const back = node(run.state, "preview");
            assert.equal(back.sub, "ready");
            assert.equal(back.notice, "not-started");
            assert.ok(run.effects.some((effect) => effect.type === "clearPersist"));
            const late = node(reconnect(submitting(), status(), T0 + 700_000).state, "idle");
            assert.equal(late.notice, "not-started");
        } },
    { row: "14-",
        name: "a push without the helper does not end Submitting",
        check: () => assert.equal(node(drive(submitting(), push(status())).state, "running").progress, "submitting") },
    { row: "15",
        name: "each phase moves Progress forward and is persisted",
        check: () => {
            const expected : Record<string, string> = { "prepared": "downloading",
                "downloaded": "ready",
                "stopping": "stopping",
                "backing-up": "snapshot",
                "starting-target": "target-starting",
                "checking-target": "verifying",
                "rolling-back": "rolling-back" };
            let state = running();
            assert.equal(node(state, "running").progress, "starting");
            for (const phase of PANEL_UPDATE_PHASES) {
                const run = drive(state, push(status(applyOp(APPLY_ID, { phase }))));
                assert.equal(node(run.state, "running").progress, expected[phase]);
                assert.deepEqual(run.effects.map((effect) => effect.type), [ "persist" ]);
                assert.equal((run.effects[0] as { record : PanelUpdateRecord }).record.phase, phase);
                state = run.state;
            }
            assert.equal(node(drive(running(), push(status(applyOp(APPLY_ID, { phase: "phase-from-the-future" })))).state, "running").progress, "step-unknown");
        } },
    { row: "16",
        name: "a late phase does not move Progress back",
        check: () => {
            const run = drive(running("stopping"), push(status(applyOp(APPLY_ID, { phase: "prepared" }))));
            assert.equal(node(run.state, "running").progress, "stopping");
            assert.equal(node(run.state, "running").phase, "stopping");
            assert.deepEqual(run.effects, []);
        } },
    { row: "17",
        name: "CANCEL while the image is fetched sends the cancel",
        check: () => {
            for (const state of [ running(), running("prepared") ]) {
                assert.equal(panelUpdateCanCancel(state), true);
                const run = drive(state, { type: "CANCEL",
                    owner: true });
                assert.equal(node(run.state, "running").progress, "cancelling");
                assert.deepEqual(run.effects, [{ type: "emit",
                    kind: "cancel",
                    args: [ APPLY_ID ] }]);
            }
        } },
    { row: "17-",
        name: "CANCEL from downloaded on, by another user or offline sends nothing",
        check: () => {
            const cases = [ running("downloaded"), running("stopping"), drive(running(), { type: "LINK_DOWN",
                now: T0 }).state ];
            for (const state of cases) {
                assert.equal(panelUpdateCanCancel(state), false);
                assert.deepEqual(drive(state, { type: "CANCEL",
                    owner: true }).effects, []);
            }
            assert.deepEqual(drive(running(), { type: "CANCEL",
                owner: false }).effects, []);
        } },
    { row: "18",
        name: "too late to cancel: the refusal or a phase from downloaded on",
        check: () => {
            const cancelling = drive(running("prepared"), { type: "CANCEL",
                owner: true }).state;
            const refused = node(drive(cancelling, { type: "ACK",
                kind: "cancel",
                requestId: APPLY_ID,
                result: { kind: "error",
                    code: "too-late",
                    msg: null },
                now: T0 }).state, "running");
            assert.equal(refused.progress, "downloading");
            assert.equal(refused.notice, "too-late");
            const phased = node(drive(cancelling, push(status(applyOp(APPLY_ID, { phase: "downloaded" })))).state, "running");
            assert.equal(phased.progress, "ready");
            assert.equal(phased.notice, "too-late");
            assert.equal(node(drive(cancelling, push(status(applyOp(APPLY_ID, { phase: "prepared" })))).state, "running").progress, "cancelling");
        } },
    { row: "19",
        name: "our success with the panel on the target version reloads once",
        check: () => {
            const run = drive(running("checking-target"), push(status(applyOp(APPLY_ID, { outcome: "success" }), TO), T0 + 9_000));
            const outcome = node(run.state, "outcome");
            assert.equal(outcome.sub, "updated");
            assert.equal(outcome.updated, "reloading");
            assert.deepEqual(run.effects.map((effect) => effect.type), [ "persist", "reload" ]);
            assert.equal((run.effects[0] as { record : PanelUpdateRecord }).record.outcome, "success");
            assert.equal(panelUpdateSuppressing(run.state), true);
        } },
    { row: "19-",
        name: "success with another version is Unknown; a foreign success changes nothing",
        check: () => {
            const other = drive(running("checking-target"), push(status(applyOp(APPLY_ID, { outcome: "success" }), FROM)));
            assert.equal(node(other.state, "outcome").sub, "unknown");
            assert.equal(node(other.state, "outcome").result.code, "version-mismatch");
            assert.ok(!other.effects.some((effect) => effect.type === "reload"));
            const foreign = drive(running("stopping"), push(status(applyOp(FOREIGN_ID, { outcome: "success" }), TO)));
            assert.equal(node(foreign.state, "running").phase, "stopping");
            assert.deepEqual(foreign.effects, []);
        } },
    { row: "20",
        name: "every other result of ours is an Outcome with the result persisted",
        check: () => {
            const expected : [string, string][] = [
                [ "no-change", "not-changed" ],
                [ "refused", "not-changed" ],
                [ "failed-before-cutover", "not-changed" ],
                [ "recovered", "rolled-back" ],
                [ "recovery-required", "recovery-required" ],
                [ "unknown", "unknown" ],
            ];
            for (const [ outcome, sub ] of expected) {
                const run = drive(running("stopping"), push(status(applyOp(APPLY_ID, { outcome }))));
                assert.equal(node(run.state, "outcome").sub, sub, outcome);
                assert.deepEqual(run.effects.map((effect) => effect.type), [ "persist" ]);
            }
            const future = readPanelUpdateStatus(status(applyOp(APPLY_ID, { outcome: "outcome-from-the-future" })));
            assert.ok(future);
            assert.equal(node(drive(running(), push(future)).state, "outcome").sub, "unknown");
        } },
    { row: "21",
        name: "the helper is gone from the solicited status after reconnecting: Unknown",
        check: () => {
            const outcome = node(reconnect(running("stopping"), status(undefined, TO)).state, "outcome");
            assert.equal(outcome.sub, "unknown");
            assert.equal(outcome.result.code, "helper-removed");
            assert.equal(outcome.request, APPLY_ID);
        } },
    { row: "21-",
        name: "a push without the helper, or with a foreign one, is ignored",
        check: () => {
            assert.equal(node(drive(running("stopping"), push(status())).state, "running").phase, "stopping");
            assert.equal(node(drive(running("stopping"), push(status(applyOp(FOREIGN_ID, { phase: "prepared" })))).state, "running").request, APPLY_ID);
        } },
    { row: "21+",
        name: "another apply running in the solicited status is followed instead of Unknown",
        check: () => {
            // Ours ended and was dismissed in another tab, and the next update started there
            const run = reconnect(running("stopping"), status(applyOp(NEXT_ID, { phase: "downloading" })));
            const followed = node(run.state, "running");
            assert.equal(followed.request, NEXT_ID);
            assert.equal(followed.observer, true);
            assert.ok(panelUpdateSuppressing(run.state));
            assert.ok(run.effects.some((effect) => effect.type === "persist" && effect.record.request === NEXT_ID));
        } },
    { row: "21--",
        name: "an old status answer is not the probe",
        check: () => {
            const back = drive(running("stopping"), { type: "LINK_DOWN",
                now: T0 }, { type: "LINK_UP",
                now: T0 });
            const stale = reducePanelUpdate(back.state, { type: "ACK",
                kind: "status",
                ask: back.state.ctx.ask - 1,
                result: { kind: "ok",
                    status: status() },
                now: T0 });
            assert.equal(stale.state.node.name, "running");
        } },
    { row: "22",
        name: "LINK_DOWN starts Waiting",
        check: () => {
            const down = drive(running("stopping"), { type: "LINK_DOWN",
                now: T0 + 7 }).state;
            assert.deepEqual(down.ctx.link, { kind: "offline",
                since: T0 + 7,
                overdue: false });
        } },
    { row: "23",
        name: "past the deadline of its Progress state Waiting becomes Overdue, never final",
        check: () => {
            const deadlines : [PanelUpdateState, number][] = [
                [ submitting(), 60_000 ],
                [ running("prepared"), 120_000 ],
                [ running("stopping"), 600_000 ],
                [ running("checking-target"), 180_000 ],
            ];
            for (const [ state, deadline ] of deadlines) {
                const down = drive(state, { type: "LINK_DOWN",
                    now: T0 }).state;
                assert.equal(panelUpdateDeadline(down), T0 + deadline);
                assert.equal(drive(down, { type: "TICK",
                    now: T0 + deadline - 1 }).state.ctx.link.kind === "offline" && (drive(down, { type: "TICK",
                    now: T0 + deadline - 1 }).state.ctx.link as { overdue : boolean }).overdue, false);
                const overdue = drive(down, { type: "TICK",
                    now: T0 + deadline }).state;
                assert.equal((overdue.ctx.link as { overdue : boolean }).overdue, true);
                assert.equal(panelUpdateHostCase(overdue), "status");
                assert.equal(panelUpdateDeadline(overdue), null);
            }
            const overdue = drive(running("stopping"), { type: "LINK_DOWN",
                now: T0 }, { type: "TICK",
                now: T0 + 600_000 }).state;
            assert.equal(node(drive(overdue, push(status(applyOp(APPLY_ID, { phase: "backing-up" })))).state, "running").progress, "snapshot");
            assert.equal(drive(overdue, { type: "LINK_UP",
                now: T0 }).state.ctx.link.kind, "online");
        } },
    { row: "24",
        name: "LINK_UP from Offline or NeedAuth goes Online and asks for the status",
        check: () => {
            for (const state of [ drive(running(), { type: "LINK_DOWN",
                now: T0 }).state, drive(running(), { type: "AUTH_LOST" }).state ]) {
                const run = drive(state, { type: "LINK_UP",
                    now: T0 });
                assert.equal(run.state.ctx.link.kind, "online");
                assert.deepEqual(run.effects, [{ type: "requestStatus",
                    ask: run.state.ctx.ask }]);
                assert.equal(run.state.ctx.probe, run.state.ctx.ask);
            }
        } },
    { row: "25",
        name: "AUTH_LOST keeps the operation and waits for the sign-in",
        check: () => {
            const state = running("checking-target");
            const lost = drive(state, { type: "AUTH_LOST" }).state;
            assert.equal(lost.ctx.link.kind, "need-auth");
            assert.deepEqual(lost.node, state.node);
            assert.equal(panelUpdateView(lost, { owner: true,
                signedIn: false }), "banner");
        } },
    { row: "26",
        name: "BOOT with a running record resumes offline at the furthest phase",
        check: () => {
            const step = booted(record("running", "stopping"));
            const resumed = node(step.state, "running");
            assert.equal(resumed.progress, "stopping");
            assert.equal(step.state.ctx.link.kind, "offline");
            const up = drive(step.state, { type: "LINK_UP",
                now: T0 });
            assert.equal(up.state.ctx.probe, up.state.ctx.ask);
            assert.equal(node(booted(record("submitting", null)).state, "running").progress, "submitting");
        } },
    { row: "27",
        name: "BOOT with a success record shows Updated pending and asks again",
        check: () => {
            const shown = node(booted(record("finished", "checking-target", "success")).state, "outcome");
            assert.equal(shown.updated, "shown");
            assert.equal(shown.pending, true);
            const other = booted(record("finished", "stopping", "recovered"));
            assert.equal(node(other.state, "idle").sub, "loading");
            assert.deepEqual(other.effects, [{ type: "clearPersist" }]);
        } },
    { row: "28",
        name: "the status after the reload confirms Updated",
        check: () => {
            const state = booted(record("finished", "checking-target", "success")).state;
            const confirmed = node(reconnect(state, status(applyOp(APPLY_ID, { outcome: "success" }), TO)).state, "outcome");
            assert.equal(confirmed.sub, "updated");
            assert.equal(confirmed.pending, false);
            const dismissedElsewhere = node(reconnect(state, status(undefined, TO)).state, "outcome");
            assert.equal(dismissedElsewhere.pending, false);
        } },
    { row: "29",
        name: "a status that contradicts the record after the reload replaces it",
        check: () => {
            const state = booted(record("finished", "checking-target", "success")).state;
            assert.equal(node(reconnect(state, status(applyOp(APPLY_ID, { phase: "stopping" }))).state, "outcome").result.code, "contradiction");
            assert.equal(node(reconnect(state, status(applyOp(APPLY_ID, { outcome: "recovered" }))).state, "outcome").sub, "rolled-back");
            assert.equal(node(reconnect(state, status()).state, "outcome").result.code, "contradiction");
            assert.equal(node(reconnect(state, status(applyOp(APPLY_ID, { outcome: "success" }), FROM)).state, "outcome").sub, "unknown");
        } },
    { row: "29+",
        name: "a result on screen gives way to the next update, even on a push",
        check: () => {
            const done = drive(running("stopping"), push(status(applyOp(APPLY_ID, { outcome: "recovered" })))).state;
            assert.equal(node(done, "outcome").sub, "rolled-back");
            const next = drive(done, push(status(applyOp(NEXT_ID, { phase: "prepared" })))).state;
            assert.equal(node(next, "running").request, NEXT_ID);
            assert.ok(panelUpdateSuppressing(next));
            // A finished apply of the same request, or none, leaves the result as it is
            assert.equal(node(drive(done, push(status())).state, "outcome").request, APPLY_ID);
        } },
    { row: "28-",
        name: "a lost answer after the reload is asked again rather than left pending",
        check: () => {
            const up = drive(booted(record("finished", "checking-target", "success")).state, { type: "LINK_UP",
                now: T0 });
            const lost = drive(up.state, { type: "ACK",
                kind: "status",
                ask: up.state.ctx.ask,
                result: { kind: "lost" },
                now: T0 });
            assert.equal(node(lost.state, "outcome").pending, true);
            const deadline = panelUpdateDeadline(lost.state);
            assert.ok(deadline !== null);
            const again = drive(lost.state, { type: "TICK",
                now: deadline });
            assert.deepEqual(again.effects, [{ type: "requestStatus",
                ask: lost.state.ctx.ask + 1 }]);
            const confirmed = drive(again.state, answer(again.state, status(applyOp(APPLY_ID, { outcome: "success" }), TO))).state;
            assert.equal(node(confirmed, "outcome").pending, false);
        } },
    { row: "30",
        name: "DISMISS clears the result and it does not come back with the next status",
        check: () => {
            const done = drive(running("stopping"), push(status(applyOp(APPLY_ID, { outcome: "recovered" })))).state;
            const run = drive(done, { type: "DISMISS",
                owner: true,
                now: T0 });
            assert.equal(node(run.state, "idle").sub, "loading");
            assert.deepEqual(run.effects, [{ type: "emit",
                kind: "dismiss",
                args: [ APPLY_ID ] }, { type: "clearPersist" }]);
            const after = drive(run.state, { type: "ACK",
                kind: "dismiss",
                requestId: APPLY_ID,
                result: { kind: "ok",
                    status: status(applyOp(APPLY_ID, { outcome: "recovered" })) },
                now: T0 });
            assert.equal(node(after.state, "idle").sub, "available");
            assert.deepEqual(drive(done, { type: "DISMISS",
                owner: false,
                now: T0 }).effects, []);
        } },
    { row: "31",
        name: "a reload that does not happen within 5 s offers a Reload button",
        check: () => {
            const state = drive(running("checking-target"), push(status(applyOp(APPLY_ID, { outcome: "success" }), TO), T0)).state;
            assert.equal(panelUpdateDeadline(state), T0 + PANEL_UPDATE_RELOAD_STALL_MS);
            assert.equal(node(drive(state, { type: "TICK",
                now: T0 + PANEL_UPDATE_RELOAD_STALL_MS - 1 }).state, "outcome").stalled, false);
            assert.equal(node(drive(state, { type: "TICK",
                now: T0 + PANEL_UPDATE_RELOAD_STALL_MS }).state, "outcome").stalled, true);
        } },
];

for (const row of ROWS) {
    test(`row ${row.row}: ${row.name}`, row.check);
}

test("a running apply that appears during a preview is followed", () => {
    const observed = node(drive(ready(), push(status(applyOp(APPLY_ID, { phase: "prepared" })))).state, "running");
    assert.equal(observed.request, APPLY_ID);
    assert.equal(observed.observer, true);
});

test("online and quiet past the deadline asks again and shows the host command", () => {
    const state = running("stopping");
    const quiet = drive(state, { type: "TICK",
        now: T0 + 2_000 + 600_000 });
    assert.equal(node(quiet.state, "running").quiet, true);
    assert.equal(panelUpdateHostCase(quiet.state), "status");
    assert.ok(quiet.effects.some((effect) => effect.type === "requestStatus"));
    const heard = drive(quiet.state, push(status(applyOp(APPLY_ID, { phase: "backing-up" }))));
    assert.equal(node(heard.state, "running").quiet, false);
});

const UNREADABLE_STATUS : PanelUpdateStatus = { schema: 1,
    panel: { version: FROM,
        managed: "unknown",
        reason: "unreadable" } };

test("an unreadable status is never read as no operation", () => {
    // As the probe after reconnecting, in each state where "no operation" would decide
    for (const state of [ checking(), submitting(), running("stopping"), booted(record("finished", "checking-target", "success")).state ]) {
        const run = reconnect(state, UNREADABLE_STATUS);
        const shape = (n : PanelUpdateState["node"]) => JSON.stringify([ n.name, "sub" in n ? n.sub : n.progress, "pending" in n ? n.pending : null, "refusal" in n ? n.refusal : null ]);
        assert.equal(shape(run.state.node), shape(state.node));
    }
    // Pushed, it is ignored; as the first answer it names the reason
    assert.deepEqual(drive(running("stopping"), push(UNREADABLE_STATUS)).state.node, running("stopping").node);
    const first = online();
    assert.equal(node(drive(first, answer(first, UNREADABLE_STATUS)).state, "idle").reason, "unreadable");
    // In the acknowledgement of an apply it counts as no answer
    const applied = drive(submitting(), { type: "ACK",
        kind: "apply",
        requestId: APPLY_ID,
        result: { kind: "ok",
            status: UNREADABLE_STATUS },
        now: T0 + 3_000 });
    assert.equal(node(applied.state, "running").progress, "submitting");
    assert.equal(node(applied.state, "running").ackPending, false);
});

test("Docker not answering refuses nothing for good: the owner retries", () => {
    const unreadable = { kind: "error" as const,
        code: "unreadable",
        msg: "panelUpdateError.unreadable" };
    const apply = node(drive(submitting(), { type: "ACK",
        kind: "apply",
        requestId: APPLY_ID,
        result: unreadable,
        now: T0 + 2_000 }).state, "preview");
    assert.equal(apply.sub, "ready");
    assert.equal(apply.dialog, true);
    assert.equal(apply.notice, "unreadable");
    const preview = node(drive(checking(), { type: "ACK",
        kind: "preview",
        requestId: PREVIEW_ID,
        result: unreadable,
        now: T0 }).state, "idle");
    assert.equal(preview.sub, "available");
    assert.equal(preview.notice, "unreadable");
});

test("a refusal without a contract code keeps the server's message", () => {
    const refused = node(drive(submitting(), { type: "ACK",
        kind: "apply",
        requestId: APPLY_ID,
        result: readPanelUpdateAck({ ok: false,
            code: "forbidden",
            msg: "authPermissionDenied",
            msgi18n: true }),
        now: T0 + 2_000 }).state, "preview");
    assert.equal(refused.sub, "refused");
    assert.equal(refused.refusal?.code, "forbidden");
    assert.equal(refused.refusal?.msg, "authPermissionDenied");
});

test("a failed dismiss lets the result come back to be closed again", () => {
    const done = drive(running("stopping"), push(status(applyOp(APPLY_ID, { outcome: "recovered" })))).state;
    const dismissed = drive(done, { type: "DISMISS",
        owner: true,
        now: T0 }).state;
    const failed = drive(dismissed, { type: "ACK",
        kind: "dismiss",
        requestId: APPLY_ID,
        result: { kind: "error",
            code: "unreadable",
            msg: null },
        now: T0 });
    assert.equal(failed.state.ctx.closed, null);
    assert.ok(failed.effects.some((effect) => effect.type === "requestStatus"));
    const again = drive(failed.state, answer(failed.state, status(applyOp(APPLY_ID, { outcome: "recovered" }))));
    assert.equal(node(again.state, "outcome").sub, "rolled-back");
});

test("closing an outcome locally keeps it closed and clears the record", () => {
    const done = drive(running("stopping"), push(status(applyOp(APPLY_ID, { outcome: "recovered" })))).state;
    const run = drive(done, { type: "CLOSE" });
    assert.equal(run.state.node.name, "idle");
    assert.deepEqual(run.effects, [{ type: "clearPersist" }]);
    assert.equal(drive(run.state, push(status(applyOp(APPLY_ID, { outcome: "recovered" })))).state.node.name, "idle");
});

test("presentation: overlay for a signed-in owner, banner for others, suppressions while running", () => {
    const state = running("stopping");
    assert.equal(panelUpdateView(state, { owner: true,
        signedIn: true }), "overlay");
    assert.equal(panelUpdateView(state, { owner: false,
        signedIn: true }), "banner");
    assert.equal(panelUpdateView(idle(), { owner: true,
        signedIn: true }), "none");
    const found = drive(online(), push(status(applyOp(FOREIGN_ID, { outcome: "recovered" })))).state;
    assert.equal(panelUpdateView(found, { owner: false,
        signedIn: true }), "none");
    assert.equal(panelUpdateView(found, { owner: true,
        signedIn: true }), "overlay");
    assert.equal(panelUpdateSuppressing(state), true);
    assert.equal(panelUpdateSuppressing(found), false);
    assert.equal(panelUpdateSuppressing(idle()), false);
});

test("steps follow the phases; a rollback replaces start and verify; an unknown phase is not a step", () => {
    const marks = (phase : string | null, finished = false) => panelUpdateSteps(phase, finished).map((step) => `${step.key}:${step.mark}`).join(" ");
    assert.equal(PANEL_UPDATE_STEPS.length, 6);
    assert.equal(marks(null), "check:current download:pending stop:pending snapshot:pending start:pending verify:pending");
    assert.equal(marks("prepared"), "check:done download:current stop:pending snapshot:pending start:pending verify:pending");
    assert.equal(marks("backing-up"), "check:done download:done stop:done snapshot:current start:pending verify:pending");
    assert.equal(marks("checking-target"), "check:done download:done stop:done snapshot:done start:done verify:current");
    assert.equal(marks("rolling-back"), "check:done download:done stop:done snapshot:done rollback:current");
    assert.equal(marks("rolling-back", true), "check:done download:done stop:done snapshot:done rollback:done");
    assert.equal(marks("success"), "check:done download:done stop:done snapshot:done start:done verify:done");
    assert.equal(marks("phase-from-the-future"), "check:pending download:pending stop:pending snapshot:pending start:pending verify:pending");
    assert.equal(marks("stopping", true), "check:done download:done stop:done snapshot:pending start:pending verify:pending");
});

test("a rollback in progress cannot be cancelled and waits ten minutes offline", () => {
    const state = running("rolling-back");
    assert.equal(node(state, "running").progress, "rolling-back");
    assert.equal(panelUpdateCanCancel(state), false);
    const down = drive(state, { type: "LINK_DOWN",
        now: T0 }).state;
    assert.equal(panelUpdateDeadline(down), T0 + 600_000);
});

test("host commands carry sudo and the real directory, quoted, or a placeholder", () => {
    assert.deepEqual(panelUpdateCommands("recovery-required", "/srv/dockge2/"), [
        "sudo /srv/dockge2/.dockge2/update --status",
        "sudo /srv/dockge2/.dockge2/update --rollback --restore-data",
    ]);
    assert.deepEqual(panelUpdateCommands("unknown", "/opt/my panel"), [
        "sudo '/opt/my panel/.dockge2/update' --status",
        "sudo '/opt/my panel/.dockge2/update' --resume",
        "sudo '/opt/my panel/.dockge2/update' --rollback",
    ]);
    assert.deepEqual(panelUpdateCommands("manual", undefined, TO), [
        `sudo ${PANEL_UPDATE_DIR_PLACEHOLDER}/.dockge2/update --version ${TO} --dry-run`,
        `sudo ${PANEL_UPDATE_DIR_PLACEHOLDER}/.dockge2/update --version ${TO} --yes`,
    ]);
    assert.equal(panelUpdateCommands("status", "relative/dir")[0], `sudo ${PANEL_UPDATE_DIR_PLACEHOLDER}/.dockge2/update --status`);
    assert.equal(panelUpdateCommands("manual", "/srv/x", "1.0.0; rm -rf /")[0], "sudo /srv/x/.dockge2/update --version VERSION --dry-run");
});

test("each host command comes with the sentence that explains it", () => {
    assert.deepEqual(panelUpdateHostLines("unknown", "/opt/dockge2").map((line) => line.label), [ "panelUpdateHostStatus", "panelUpdateHostResume", "panelUpdateHostRollback" ]);
    assert.deepEqual(panelUpdateHostLines("manual", "/opt/dockge2", TO).map((line) => line.label), [ null, null ]);
    assert.equal(panelUpdateHostLines("status", undefined)[0]?.command, `sudo ${PANEL_UPDATE_DIR_PLACEHOLDER}/.dockge2/update --status`);
});

test("the status line names the state in words, in English and Russian", () => {
    const text = (catalogue : unknown, key : string) => key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], catalogue);
    const base = running("stopping");
    const links : PanelUpdateState["ctx"]["link"][] = [{ kind: "online" }, { kind: "need-auth" }, { kind: "offline",
        since: T0,
        overdue: false }, { kind: "offline",
        since: T0,
        overdue: true }];
    const keys = new Set<string>();
    for (const progress of Object.keys(PANEL_UPDATE_DEADLINES) as (keyof typeof PANEL_UPDATE_DEADLINES)[]) {
        for (const link of links) {
            for (const quiet of [ false, true ]) {
                const line = panelUpdateLine({ ctx: { ...base.ctx,
                    link },
                node: { ...node(base, "running"),
                    progress,
                    quiet } });
                keys.add(line!.key);
            }
        }
    }
    const done = drive(running("stopping"), push(status(applyOp(APPLY_ID, { outcome: "recovered" })))).state;
    keys.add(panelUpdateLine(done)!.key);
    for (const key of keys) {
        assert.equal(typeof text(en, key), "string", `en ${key}`);
        assert.equal(typeof text(ru, key), "string", `ru ${key}`);
    }
    assert.equal(panelUpdateLine(done)!.key, "panelUpdateResult.recovered");
    assert.equal(panelUpdateLine(idle()), null);
    assert.equal(panelUpdateLine(base)!.key, "panelUpdateLine.stopping");
    assert.equal(panelUpdateLine(drive(base, { type: "LINK_DOWN",
        now: T0 }).state)!.key, "panelUpdateLine.offline-cutover");
});

test("request ids from random bytes match the contract", () => {
    const id = panelUpdateRequestId(new Uint8Array(16).fill(0xff));
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(panelUpdateRequestId(new Uint8Array(16)), "00000000-0000-4000-8000-000000000000");
});

test("statuses and acknowledgements are read strictly", () => {
    const good = status(applyOp(APPLY_ID, { phase: "stopping" }));
    assert.deepEqual(readPanelUpdateStatus(JSON.parse(JSON.stringify({ ...good,
        extra: 1 }))), good);
    assert.equal(readPanelUpdateStatus({ schema: 2,
        panel: good.panel }), null);
    assert.equal(readPanelUpdateStatus({ schema: 1,
        panel: { version: 1,
            managed: "yes" } }), null);
    assert.equal(readPanelUpdateStatus({ ...good,
        operation: { requestId: APPLY_ID } }), null);
    // A reason this page has no sentence for is dropped rather than shown as a key
    const manual = { schema: 1,
        panel: { version: FROM,
            managed: "no",
            reason: "updater-missing" } };
    assert.equal(readPanelUpdateStatus(manual)?.panel.reason, "updater-missing");
    assert.deepEqual(readPanelUpdateStatus({ ...manual,
        panel: { ...manual.panel,
            reason: "reason-from-the-future" } })?.panel, { version: FROM,
        managed: "no" });
    assert.deepEqual(readPanelUpdateAck({ ok: true,
        status: good }), { kind: "ok",
        status: good });
    assert.deepEqual(readPanelUpdateAck({ ok: false,
        code: "busy",
        msg: "panelUpdateError.busy",
        msgi18n: true }), { kind: "error",
        code: "busy",
        msg: "panelUpdateError.busy" });
    // The transport middleware refuses without a code
    assert.deepEqual(readPanelUpdateAck({ ok: false,
        msg: "authSessionExpired",
        msgi18n: true }), { kind: "error",
        code: "failed",
        msg: "authSessionExpired" });
    assert.deepEqual(readPanelUpdateAck({ ok: true }), { kind: "lost" });
    assert.deepEqual(readPanelUpdateAck(undefined), { kind: "lost" });
});

test("the stored record is read back only when this build wrote it", () => {
    const stored = record("running", "stopping");
    assert.deepEqual(readPanelUpdateRecord(JSON.stringify(stored)), stored);
    assert.equal(readPanelUpdateRecord(null), null);
    assert.equal(readPanelUpdateRecord("{"), null);
    assert.equal(readPanelUpdateRecord(JSON.stringify({ ...stored,
        v: 2 })), null);
    assert.equal(readPanelUpdateRecord(JSON.stringify({ ...stored,
        request: "../etc" })), null);
    assert.equal(readPanelUpdateRecord(JSON.stringify({ ...stored,
        stage: "paused" })), null);
});

test("every refusal code and every reason has a sentence in English and Russian", () => {
    const reasons = [ ...PANEL_UPDATE_MANUAL_REASONS,
        "updater-outdated", "start-failed", "no-result", "interrupted", "exit-mismatch", "version-mismatch",
        "helper-removed", "contradiction", "lost" ];
    for (const catalogue of [ en, ru ] as Record<string, unknown>[]) {
        const errors = catalogue.panelUpdateError as Record<string, unknown>;
        const reasonTexts = catalogue.panelUpdateReason as Record<string, unknown>;
        for (const code of PANEL_UPDATE_ERROR_CODES) {
            assert.equal(typeof errors[code], "string", `panelUpdateError.${code}`);
        }
        for (const reason of reasons) {
            assert.equal(typeof reasonTexts[reason], "string", `panelUpdateReason.${reason}`);
        }
    }
});

// --- Model check --------------------------------------------------------------------

interface ModelState {
    state : PanelUpdateState;
    now : number;
}

interface Labelled {
    label : string;
    event : PanelUpdateEvent;
}

const TICK_STEPS = [ PANEL_UPDATE_RELOAD_STALL_MS, PANEL_UPDATE_LOADING_MS, 60_000, 120_000, 180_000, 600_000 ];
const MODEL_ERRORS = [ "password", "unreadable", "busy", "stale-preview", "too-late", "not-found", "failed" ];
const FINISHED = [ ...PANEL_UPDATE_OUTCOMES.filter((outcome) => outcome !== "previewed") ];

function oursOf(state : PanelUpdateState) : { apply : string; preview : string } {
    const n = state.node;
    return {
        apply: n.name === "running" || n.name === "outcome" ? n.request : APPLY_ID,
        preview: n.name === "preview" ? n.request : PREVIEW_ID,
    };
}

/** Every status the model delivers, for our request and for a foreign one */
function modelStatuses(state : PanelUpdateState, now : number) : [string, PanelUpdateStatus][] {
    const ours = oursOf(state);
    const list : [string, PanelUpdateStatus][] = [
        [ "none@from", status(undefined, FROM) ],
        [ "none@to", status(undefined, TO) ],
        [ "foreign-running", status(applyOp(FOREIGN_ID, { phase: "prepared" })) ],
        [ "foreign-success", status(applyOp(FOREIGN_ID, { outcome: "success",
            finishedAt: now }), TO) ],
        [ "preview-running", status(previewOp(ours.preview, { running: true })) ],
        [ "preview-done", status(previewOp(ours.preview, { finishedAt: now })) ],
        [ "preview-refused", status(previewOp(ours.preview, { outcome: "refused",
            code: "updater-outdated",
            finishedAt: now })) ],
    ];
    for (const phase of [ undefined, ...PANEL_UPDATE_PHASES, "phase-from-the-future", "success" ]) {
        list.push([ `ours-running:${phase ?? "none"}`, status(applyOp(ours.apply, phase === undefined ? {} : { phase })) ]);
    }
    for (const outcome of FINISHED) {
        list.push([ `ours-${outcome}`, status(applyOp(ours.apply, { outcome,
            phase: "checking-target",
            finishedAt: now }), outcome === "success" ? TO : FROM) ]);
    }
    list.push([ "ours-success@from", status(applyOp(ours.apply, { outcome: "success",
        finishedAt: now }), FROM) ]);
    return list;
}

const alphabets = new Map<string, Labelled[]>();

/** The events that can happen next; they depend only on the ids, the clock and the counters */
function alphabet(model : ModelState) : Labelled[] {
    const ours = oursOf(model.state);
    const key = [ ours.apply, ours.preview, model.now, model.state.ctx.ask, model.state.ctx.closed, model.state.node.name === "preview" && model.state.node.request ].join("|");
    let events = alphabets.get(key);
    if (!events) {
        events = buildAlphabet(model);
        alphabets.set(key, events);
    }
    return events;
}

function buildAlphabet(model : ModelState) : Labelled[] {
    const { state, now } = model;
    const ours = oursOf(state);
    const events : Labelled[] = [];
    for (const [ label, s ] of modelStatuses(state, now)) {
        events.push({ label: `push ${label}`,
            event: push(s, now) });
        events.push({ label: `answer ${label}`,
            event: answer(state, s, now) });
    }
    events.push({ label: "answer lost",
        event: { type: "ACK",
            kind: "status",
            ask: state.ctx.ask,
            result: { kind: "lost" },
            now } });
    events.push({ label: "LINK_UP",
        event: { type: "LINK_UP",
            now } }, { label: "LINK_DOWN",
        event: { type: "LINK_DOWN",
            now } }, { label: "AUTH_LOST",
        event: { type: "AUTH_LOST" } });
    for (const step of TICK_STEPS) {
        events.push({ label: `TICK+${step}`,
            event: { type: "TICK",
                now: now + step } });
    }
    const requests : [ "preview" | "apply" | "cancel" | "dismiss", string ][] = [
        [ "preview", ours.preview ], [ "apply", ours.apply ], [ "cancel", ours.apply ], [ "dismiss", state.ctx.closed ?? ours.apply ],
    ];
    for (const [ kind, requestId ] of requests) {
        const results = [
            { kind: "lost" as const },
            { kind: "ok" as const,
                status: status(applyOp(ours.apply, { phase: "prepared" })) },
            { kind: "ok" as const,
                status: status(kind === "preview" ? previewOp(ours.preview, { running: true }) : undefined) },
            ...MODEL_ERRORS.map((code) => ({ kind: "error" as const,
                code,
                msg: null })),
        ];
        for (const result of results) {
            events.push({ label: `ack ${kind} ${JSON.stringify(result).slice(0, 40)}`,
                event: { type: "ACK",
                    kind,
                    requestId,
                    result,
                    now } });
        }
    }
    events.push(
        { label: "INFO",
            event: { type: "INFO",
                latestVersion: TO,
                updateAvailable: true } },
        { label: "CHECK",
            event: { type: "CHECK",
                owner: true,
                requestId: PREVIEW_ID } },
        { label: "CHECK viewer",
            event: { type: "CHECK",
                owner: false,
                requestId: PREVIEW_ID } },
        { label: "CONFIRM",
            event: { type: "CONFIRM",
                owner: true } },
        { label: "SUBMIT",
            event: { type: "SUBMIT",
                owner: true,
                password: PASSWORD,
                requestId: state.node.name === "preview" && state.node.request === APPLY_ID ? NEXT_ID : APPLY_ID,
                now } },
        { label: "CANCEL",
            event: { type: "CANCEL",
                owner: true } },
        { label: "CANCEL viewer",
            event: { type: "CANCEL",
                owner: false } },
        { label: "DISMISS",
            event: { type: "DISMISS",
                owner: true,
                now } },
        { label: "CLOSE",
            event: { type: "CLOSE" } },
    );
    return events;
}

const TIME_FIELDS = [ "startedAt", "heardAt", "requestedAt", "expires", "reloadAt" ];
const statusKeys = new WeakMap<object, string>();

/** Statuses come from the cached alphabet, so each one is serialised once */
function statusKey(status : PanelUpdateStatus | null) : string {
    if (!status) {
        return "-";
    }
    let key = statusKeys.get(status);
    if (key === undefined) {
        key = JSON.stringify(status, (name, value) => (name === "finishedAt" || name === "startedAt" ? undefined : value));
        statusKeys.set(status, key);
    }
    return key;
}

/** A state key without clock values and request counters, so equal situations merge */
function modelKey(state : PanelUpdateState) : string {
    const n : Record<string, unknown> = { ...state.node };
    for (const field of TIME_FIELDS) {
        if (field in n) {
            n[field] = n[field] === null ? null : "t";
        }
    }
    if (state.node.name === "running" && state.node.back) {
        n.back = { ...state.node.back,
            expires: "t" };
    }
    const { ctx } = state;
    const link = ctx.link.kind === "offline" ? `offline:${ctx.link.overdue}` : ctx.link.kind;
    const probe = ctx.probe === null ? "none" : ctx.probe === ctx.ask ? "current" : "old";
    return `${JSON.stringify(n)}|${link}|${statusKey(ctx.status)}|${ctx.latest}|${ctx.updateAvailable}|${probe}|${ctx.closed}`;
}

function statusOf(event : PanelUpdateEvent) : PanelUpdateStatus | null {
    if (event.type === "STATUS") {
        return event.status;
    }
    if (event.type === "ACK" && event.result.kind === "ok") {
        return event.result.status;
    }
    return null;
}

function confirmedUpdated(s : PanelUpdateStatus | null, request : string, to : string) : boolean {
    const op = s?.operation;
    return !!s && op?.kind === "apply" && op.requestId === request && !op.running && op.result?.outcome === "success" && s.panel.version === to;
}

const PROBE_ONLY = (state : PanelUpdateState) => (state.node.name === "preview" && state.node.refusal?.kind === "lost")
    || (state.node.name === "outcome" && state.node.result.code === "helper-removed");

interface Transition {
    prev : PanelUpdateState;
    event : PanelUpdateEvent;
    step : PanelUpdateStep;
    where : () => string;
}

const REQUEST_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const hasRequest = (n : PanelUpdateState["node"]) : n is Extract<PanelUpdateState["node"], { request : string }> & { name : "running" | "outcome" } => n.name === "running" || n.name === "outcome";

/** I1: Updated only when our finished success answers on the target version, in the status the machine holds */
function checkUpdated({ prev, event, step, where } : Transition) : void {
    const nn = step.state.node;
    const pn = prev.node;
    if (nn.name !== "outcome" || nn.sub !== "updated") {
        return;
    }
    const held = step.state.ctx.status;
    const wasUpdated = pn.name === "outcome" && pn.sub === "updated" && pn.request === nn.request;
    if (!wasUpdated) {
        const fromRecord = event.type === "BOOT" && nn.pending;
        assert.ok(fromRecord || confirmedUpdated(held, nn.request, nn.to), `I1 entry ${where()}`);
    } else if (pn.pending && !nn.pending) {
        const op = held?.operation;
        assert.ok(held && held.panel.version === nn.to && (op === undefined || op.kind === "preview" || confirmedUpdated(held, nn.request, nn.to)), `I1 pending ${where()}`);
    }
}

/** A reload only on entering Updated.Reloading, after the result is persisted */
function checkReload({ prev, step, where } : Transition) : void {
    if (!step.effects.some((effect) => effect.type === "reload")) {
        return;
    }
    const nn = step.state.node;
    const pn = prev.node;
    assert.ok(nn.name === "outcome" && nn.updated === "reloading" && !(pn.name === "outcome" && pn.updated === "reloading"), `reload ${where()}`);
    const persisted = step.effects.find((effect) => effect.type === "persist") as { record : PanelUpdateRecord } | undefined;
    assert.equal(persisted?.record.outcome, "success", `reload without the result ${where()}`);
}

/** I2: a Running state waits on a deadline, an acknowledgement or the owner; I3: no cancel from downloaded on */
function checkWaitsAndCancel({ prev, step, where } : Transition) : void {
    const next = step.state;
    const nn = next.node;
    if (nn.name === "running") {
        const waits = panelUpdateDeadline(next) !== null || nn.ackPending || next.ctx.link.kind === "need-auth" || panelUpdateHostCase(next) !== null;
        assert.ok(waits, `I2 ${where()}`);
    }
    // Updated after the reload keeps asking until a status confirms or contradicts it
    if (nn.name === "outcome" && nn.pending && next.ctx.link.kind === "online") {
        assert.ok(panelUpdateDeadline(next) !== null, `I2 pending ${where()}`);
    }
    // A check waits on the clock once acknowledged; before that the root bounds the acknowledgement
    if (nn.name === "preview" && nn.sub === "checking" && next.ctx.link.kind === "online") {
        assert.ok(panelUpdateDeadline(next) !== null || nn.heardAt === null, `I2 checking ${where()}`);
    }
    if (step.effects.some((effect) => effect.type === "emit" && effect.kind === "cancel")) {
        const pn = prev.node;
        assert.ok(pn.name === "running" && canCancelPanelUpdate(pn.phase ?? undefined), `I3 ${where()}`);
        assert.ok(phaseRank(pn.phase ?? undefined) < phaseRank("downloaded"), `I3 rank ${where()}`);
    }
}

/** Phases never go back, and a pushed status of another request changes nothing */
function checkForward(prev : PanelUpdateState, event : PanelUpdateEvent, step : PanelUpdateStep, where : () => string) : void {
    const nn = step.state.node;
    const pn = prev.node;
    if (pn.name === "running" && nn.name === "running" && nn.request === pn.request) {
        assert.ok(phaseRank(nn.phase ?? undefined) >= phaseRank(pn.phase ?? undefined), `phase went back ${where()}`);
    }
    const s = statusOf(event);
    if (pn.name === "running" && event.type === "STATUS" && !event.solicited && s?.operation && s.operation.requestId !== pn.request) {
        assert.deepEqual(nn, pn, `foreign push changed the operation ${where()}`);
    }
}

/** The request id is never lost, phases never go back, a foreign request never takes over */
function checkRequest({ prev, event, step, where } : Transition) : void {
    const nn = step.state.node;
    const pn = prev.node;
    if (hasRequest(nn)) {
        assert.match(nn.request, REQUEST_PATTERN, `request ${where()}`);
    }
    if (hasRequest(pn) && hasRequest(nn)) {
        // Only three hand-overs: an apply that never started gives way to the one that runs,
        // its record cleared in the same step; the owner closing a result; and an apply the
        // same status shows running, since only one apply helper exists at a time
        const op = statusOf(event)?.operation;
        const handedOver = (pn.name === "running" && pn.progress === "submitting" && !pn.seen && step.effects[0]?.type === "clearPersist")
            || (pn.name === "outcome" && (event.type === "DISMISS" || event.type === "CLOSE"))
            || (nn.name === "running" && nn.observer && op?.kind === "apply" && op.running && op.requestId === nn.request);
        assert.ok(nn.request === pn.request || handedOver, `request changed ${where()}`);
    }
    checkForward(prev, event, step, where);
}

/** Rows 8, 14 and 21 never on a push */
function checkPush({ prev, event, step, where } : Transition) : void {
    if (event.type !== "STATUS" || event.solicited) {
        return;
    }
    const nn = step.state.node;
    const pn = prev.node;
    assert.ok(PROBE_ONLY(prev) || !PROBE_ONLY(step.state), `probe-only transition on a push ${where()}`);
    const notStarted = (nn.name === "preview" || nn.name === "idle") && nn.notice === "not-started";
    const was = (pn.name === "preview" || pn.name === "idle") && pn.notice === "not-started";
    assert.ok(was || !notStarted, `not-started on a push ${where()}`);
}

/** The password never reaches a persisted record or the state */
function checkPassword({ event, step, where } : Transition) : void {
    const nn = step.state.node;
    for (const effect of step.effects) {
        if (effect.type === "persist") {
            const text = JSON.stringify(effect.record);
            assert.ok(!text.includes(PASSWORD), `password persisted ${where()}`);
            assert.deepEqual(readPanelUpdateRecord(text), effect.record, `record unreadable ${where()}`);
            assert.ok(!hasRequest(nn) || effect.record.request === nn.request, `record of another request ${where()}`);
        }
        assert.ok(effect.type !== "emit" || effect.kind !== "apply" || event.type === "SUBMIT", `apply without SUBMIT ${where()}`);
    }
    // The password enters only with SUBMIT, so a state it did not stay in cannot hold it later
    if (event.type === "SUBMIT") {
        assert.ok(!JSON.stringify(step.state).includes(PASSWORD), `password kept in state ${where()}`);
    }
}

/**
 * The invariants of section 6, asserted on one transition
 * @param prev State before
 * @param event What happened
 * @param step What the reducer returned
 * @param path Labels that led here, for the failure message
 */
function checkTransition(prev : PanelUpdateState, event : PanelUpdateEvent, step : PanelUpdateStep, path : string[]) : void {
    const transition : Transition = { prev,
        event,
        step,
        where: () => `after ${path.join(" > ")}\n${JSON.stringify(step.state.node)}` };
    checkUpdated(transition);
    checkReload(transition);
    checkWaitsAndCancel(transition);
    checkRequest(transition);
    checkPush(transition);
    checkPassword(transition);
}

type Seed = { label : string; model : ModelState };

interface Coverage {
    states : number;
    transitions : number;
    names : Set<string>;
}

function nameOf(state : PanelUpdateState) : string {
    const n = state.node;
    return n.name === "running" ? `running.${n.progress}` : `${n.name}.${"sub" in n ? n.sub : ""}`;
}

/**
 * Take one event in the model, checking the invariants on the way
 * @param model Where the model is
 * @param labelled The event
 * @param path Labels so far
 * @param coverage Counters
 * @returns The next model state, and whether it differs
 */
function advanceModel(model : ModelState, labelled : Labelled, path : string[], coverage : Coverage) : { model : ModelState; changed : boolean } {
    const { event } = labelled;
    const step = reducePanelUpdate(model.state, event);
    coverage.transitions++;
    const changed = step.state !== model.state || step.effects.length > 0;
    if (changed) {
        checkTransition(model.state, event, step, [ ...path, labelled.label ]);
    }
    coverage.names.add(nameOf(step.state));
    const now = "now" in event && typeof event.now === "number" ? Math.max(event.now, model.now) : model.now;
    return { model: { state: step.state,
        now },
    changed };
}

/** Every sequence up to `depth` events, equal situations merged */
function explore(seeds : Seed[], depth : number, coverage : Coverage) : void {
    const seen = new Set<string>();
    let frontier : { model : ModelState; path : string[] }[] = [];
    for (const seed of seeds) {
        const key = modelKey(seed.model.state);
        if (!seen.has(key)) {
            seen.add(key);
            frontier.push({ model: seed.model,
                path: [ seed.label ] });
        }
    }
    for (let level = 0; level < depth; level++) {
        const next : typeof frontier = [];
        for (const { model, path } of frontier) {
            for (const labelled of alphabet(model)) {
                const moved = advanceModel(model, labelled, path, coverage);
                if (!moved.changed) {
                    continue;
                }
                const key = modelKey(moved.model.state);
                if (!seen.has(key)) {
                    seen.add(key);
                    next.push({ model: moved.model,
                        path: [ ...path, labelled.label ] });
                }
            }
        }
        frontier = next;
    }
    coverage.states += seen.size;
}

/** A small deterministic generator, so a failing sequence can be replayed */
function mulberry32(seed : number) : () => number {
    let a = seed;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Random sequences of `length` events from every seed */
function sample(seeds : Seed[], walks : number, length : number, coverage : Coverage) : void {
    const random = mulberry32(20260925);
    for (const seed of seeds) {
        for (let walk = 0; walk < walks; walk++) {
            let model = seed.model;
            const path = [ seed.label ];
            for (let index = 0; index < length; index++) {
                const events = alphabet(model);
                const labelled = events[Math.floor(random() * events.length)]!;
                model = advanceModel(model, labelled, path, coverage).model;
                path.push(labelled.label);
            }
        }
    }
}

test("model check: every sequence of five events and sampled sequences of seven keep the invariants", () => {
    const boot = (persisted : PanelUpdateRecord | null) => booted(persisted).state;
    const seeds = [
        { label: "BOOT",
            model: { state: boot(null),
                now: T0 } },
        { label: "BOOT submitting",
            model: { state: boot(record("submitting", null)),
                now: T0 } },
        { label: "BOOT prepared",
            model: { state: boot(record("running", "prepared")),
                now: T0 } },
        { label: "BOOT stopping",
            model: { state: boot(record("running", "stopping")),
                now: T0 } },
        { label: "BOOT updated",
            model: { state: boot(record("finished", "checking-target", "success")),
                now: T0 } },
        { label: "BOOT recovered",
            model: { state: boot(record("finished", "stopping", "recovered")),
                now: T0 } },
        // The owner's own path from BOOT is seven events long by itself, so it is a seed too
        { label: "BOOT > ... > SUBMIT",
            model: { state: submitting(),
                now: T0 + 1_000 } },
        { label: "BOOT > ... > CHECK",
            model: { state: checking(),
                now: T0 } },
        // A page of the old build: finding the update finished reloads it
        { label: "BOOT old build > LINK_UP",
            model: { state: drive(createPanelUpdateState(), { type: "BOOT",
                persisted: null,
                now: T0,
                build: FROM }, { type: "LINK_UP",
                now: T0 }).state,
            now: T0 } },
    ];
    const coverage : Coverage = { states: 0,
        transitions: 0,
        names: new Set() };
    // Every sequence of five events, then sampled sequences of seven: the full search to
    // seven does not fit in memory, and the sample is seeded, so a failure replays
    explore(seeds, Number(process.env.PANEL_UPDATE_MODEL_DEPTH ?? 5), coverage);
    sample(seeds, Number(process.env.PANEL_UPDATE_MODEL_WALKS ?? 3_000), 7, coverage);
    for (const name of [ "idle.loading", "idle.manual", "idle.current", "idle.available", "preview.checking", "preview.ready", "preview.refused",
        "running.submitting", "running.starting", "running.downloading", "running.ready", "running.cancelling", "running.stopping",
        "running.snapshot", "running.target-starting", "running.verifying", "running.rolling-back", "running.finishing", "running.step-unknown",
        "outcome.updated", "outcome.not-changed", "outcome.rolled-back", "outcome.recovery-required", "outcome.unknown" ]) {
        assert.ok(coverage.names.has(name), `never reached ${name}`);
    }
    assert.ok(coverage.states > 1_000, `explored only ${coverage.states} states`);
});
