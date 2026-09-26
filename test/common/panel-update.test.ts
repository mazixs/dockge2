import { strict as assert } from "node:assert";
import test from "node:test";
import {
    canCancelPanelUpdate,
    derivePanelUpdateOperation,
    PANEL_UPDATE_MAX_LINE,
    PANEL_UPDATE_REQUEST_PATTERN,
    PANEL_VERSION_PATTERN,
    panelUpdateHelperName,
    parsePanelUpdateLine,
    phaseRank,
    type PanelUpdateHelper,
    type PanelUpdateJournalLine,
    type PanelUpdateLine,
} from "../../common/panel-update";

const REQUEST = "0b7c6a3e-5d1f-4c2a-9e8b-1f2d3c4b5a69";
const OP = "20261001T101500.000000000";

/**
 * Serialise a line the way the updater prints it
 * @param value Fields of the line
 * @returns One line of stdout
 */
function json(value : Record<string, unknown>) : string {
    return JSON.stringify(value);
}

function phase(name : string) : PanelUpdateLine {
    const line = parsePanelUpdateLine(json({ dockge2: "phase",
        v: 1,
        op: OP,
        phase: name,
        from: "0.0.14",
        to: "0.0.15",
        at: "2026-10-01T10:15:40Z" }));
    assert.ok(line);
    return line;
}

function result(outcome : string, extra : Record<string, unknown> = {}) : PanelUpdateLine {
    const line = parsePanelUpdateLine(json({ dockge2: "result",
        v: 1,
        op: OP,
        outcome,
        phase: outcome,
        from: "0.0.14",
        to: "0.0.15",
        ...extra }));
    assert.ok(line);
    return line;
}

function helper(overrides : Partial<PanelUpdateHelper> = {}) : PanelUpdateHelper {
    return {
        kind: "apply",
        requestId: REQUEST,
        from: "0.0.14",
        to: "0.0.15",
        startedAt: "2026-10-01T10:15:00Z",
        running: false,
        exitCode: 0,
        finishedAt: "2026-10-01T10:18:00Z",
        ...overrides,
    };
}

test("phase ranks only move forward and unknown phases rank before everything", () => {
    assert.equal(phaseRank(undefined), -1);
    assert.equal(phaseRank("mystery"), -1);
    assert.ok(phaseRank("prepared") < phaseRank("downloaded"));
    assert.ok(phaseRank("starting-target") < phaseRank("checking-target"));
    assert.equal(phaseRank("success"), phaseRank("recovery-required"));
    assert.ok(phaseRank("checking-target") < phaseRank("rolling-back"));
    assert.ok(phaseRank("starting-target") < phaseRank("rolling-back"));
    assert.ok(phaseRank("rolling-back") < phaseRank("recovered"));
});

test("cancel is offered only before the image is downloaded", () => {
    assert.equal(canCancelPanelUpdate(undefined), true);
    assert.equal(canCancelPanelUpdate("prepared"), true);
    assert.equal(canCancelPanelUpdate("downloaded"), false);
    assert.equal(canCancelPanelUpdate("stopping"), false);
    assert.equal(canCancelPanelUpdate("success"), false);
});

test("versions, request ids and helper names are strict", () => {
    assert.ok(PANEL_VERSION_PATTERN.test("0.0.15"));
    assert.ok(PANEL_VERSION_PATTERN.test("1.2.3-rc.1"));
    for (const bad of [ "latest", "0.0", "0.0.15; rm -rf /", "--yes", "0.0.15\n" ]) {
        assert.equal(PANEL_VERSION_PATTERN.test(bad), false, bad);
    }
    assert.ok(PANEL_UPDATE_REQUEST_PATTERN.test(REQUEST));
    assert.equal(PANEL_UPDATE_REQUEST_PATTERN.test(REQUEST.toUpperCase()), false);
    assert.equal(panelUpdateHelperName("dockge2", "apply"), "dockge2-update-dockge2-apply");
});

test("well formed lines of every kind are parsed", () => {
    assert.deepEqual(phase("downloaded"), {
        dockge2: "phase",
        v: 1,
        op: OP,
        phase: "downloaded",
        from: "0.0.14",
        to: "0.0.15",
        at: "2026-10-01T10:15:40Z",
    });
    assert.deepEqual(parsePanelUpdateLine(json({ dockge2: "preview",
        v: 1,
        from: "0.0.14",
        to: "0.0.15",
        channel: "ghcr.io/mazixs/dockge2:latest",
        fields: [ "image" ],
        schemaChanges: true })), {
        dockge2: "preview",
        v: 1,
        from: "0.0.14",
        to: "0.0.15",
        channel: "ghcr.io/mazixs/dockge2:latest",
        fields: [ "image" ],
        schemaChanges: true,
    });
    assert.deepEqual(result("recovered", { error: "target is not healthy",
        restoredData: true }), {
        dockge2: "result",
        v: 1,
        op: OP,
        outcome: "recovered",
        phase: "recovered",
        from: "0.0.14",
        to: "0.0.15",
        error: "target is not healthy",
        restoredData: true,
    });
    assert.deepEqual(parsePanelUpdateLine(json({ dockge2: "journal",
        v: 1,
        op: OP,
        phase: "starting-target",
        from: "0.0.14",
        to: "0.0.15" })), {
        dockge2: "journal",
        v: 1,
        op: OP,
        phase: "starting-target",
        from: "0.0.14",
        to: "0.0.15",
    });
    const recovered = { dockge2: "journal",
        v: 1,
        op: OP,
        phase: "recovered",
        from: "0.0.14",
        to: "0.0.15" };
    assert.equal((parsePanelUpdateLine(json({ ...recovered,
        restoredData: false })) as PanelUpdateJournalLine).restoredData, false);
    assert.equal((parsePanelUpdateLine(json({ ...recovered,
        restoredData: "yes" })) as PanelUpdateJournalLine).restoredData, undefined);
});

test("anything that is not a line of schema 1 is dropped", () => {
    const base = { dockge2: "phase",
        v: 1,
        op: OP,
        phase: "prepared",
        from: "0.0.14",
        to: "0.0.15",
        at: "2026-10-01T10:15:40Z" };
    const rejected = [
        "Verifying release 0.0.15 and deployment files (no branch checkout).",
        "",
        "{not json",
        "null",
        "[]",
        json({ ...base,
            v: 2 }),
        json({ ...base,
            dockge2: "telemetry" }),
        json({ ...base,
            dockge2: "constructor" }),
        json({ ...base,
            dockge2: "toString" }),
        json({ ...base,
            from: 14 }),
        json({ ...base,
            at: undefined }),
        json({ ...base,
            dockge2: "result",
            outcome: "unknown" }),
        json({ ...base,
            dockge2: "result",
            outcome: "exploded" }),
        json({ ...base,
            dockge2: "preview",
            fields: "image",
            channel: "x",
            schemaChanges: false }),
        json({ ...base,
            dockge2: "preview",
            fields: [ 1 ],
            channel: "x",
            schemaChanges: false }),
        json({ ...base,
            op: "x".repeat(PANEL_UPDATE_MAX_LINE) }),
    ];
    for (const line of rejected) {
        assert.equal(parsePanelUpdateLine(line), undefined, line.slice(0, 80));
    }
});

test("a running helper reports its furthest phase and no result", () => {
    const running : PanelUpdateHelper = {
        kind: "apply",
        requestId: REQUEST,
        from: "0.0.14",
        to: "0.0.15",
        startedAt: "2026-10-01T10:15:00Z",
        running: true,
    };
    const operation = derivePanelUpdateOperation(running, [ phase("prepared"), phase("downloaded"), phase("prepared") ], "0.0.14");
    assert.equal(operation.running, true);
    assert.equal(operation.phase, "downloaded");
    assert.equal(operation.op, OP);
    assert.equal(operation.result, undefined);
});

test("a late or unknown phase never moves the operation back", () => {
    const operation = derivePanelUpdateOperation(helper({ running: true }), [ phase("starting-target"), phase("mystery"), phase("stopping") ], "0.0.14");
    assert.equal(operation.phase, "starting-target");
});

test("success needs the result line, exit 0 and the answering panel on the target version", () => {
    const lines = [ phase("checking-target"), result("success") ];
    const confirmed = derivePanelUpdateOperation(helper(), lines, "0.0.15");
    assert.deepEqual(confirmed.result, { outcome: "success",
        finishedAt: "2026-10-01T10:18:00Z" });
    assert.equal(confirmed.phase, "success");

    // The old panel answering after a success line cannot confirm it
    assert.deepEqual(derivePanelUpdateOperation(helper(), lines, "0.0.14").result, { outcome: "unknown",
        code: "version-mismatch",
        finishedAt: "2026-10-01T10:18:00Z" });

    // Exit code and result disagree
    assert.equal(derivePanelUpdateOperation(helper({ exitCode: 1 }), lines, "0.0.15").result?.code, "exit-mismatch");
    assert.equal(derivePanelUpdateOperation(helper({ exitCode: 0 }), [ result("recovered") ], "0.0.14").result?.code, "exit-mismatch");
});

test("a dry run is previewed on any answering version and keeps the preview", () => {
    const operation = derivePanelUpdateOperation(helper({ kind: "preview" }), [
        parsePanelUpdateLine(json({ dockge2: "preview",
            v: 1,
            from: "0.0.14",
            to: "0.0.15",
            channel: "latest",
            fields: [ "image" ],
            schemaChanges: false })) as PanelUpdateLine,
        result("previewed", { op: "" }),
    ], "0.0.14");
    assert.equal(operation.kind, "preview");
    assert.equal(operation.result?.outcome, "previewed");
    assert.equal(operation.op, undefined);
    assert.deepEqual(operation.preview, { channel: "latest",
        fields: [ "image" ],
        schemaChanges: false });
});

test("failures carry the updater's outcome, error and restored data flag", () => {
    const recovered = derivePanelUpdateOperation(helper({ exitCode: 1 }), [ result("recovered", { error: "target is not healthy",
        restoredData: true }) ], "0.0.14");
    assert.deepEqual(recovered.result, { outcome: "recovered",
        error: "target is not healthy",
        restoredData: true,
        finishedAt: "2026-10-01T10:18:00Z" });
    const refused = derivePanelUpdateOperation(helper({ exitCode: 1 }), [ result("refused", { op: "" }) ], "0.0.14");
    assert.equal(refused.result?.outcome, "refused");
    const noChange = derivePanelUpdateOperation(helper({ to: "0.0.14" }), [ result("no-change", { to: "0.0.14" }) ], "0.0.14");
    assert.equal(noChange.result?.outcome, "no-change");
});

test("a helper that could not run is refused with the reason", () => {
    assert.deepEqual(derivePanelUpdateOperation(helper({ exitCode: 127 }), [], "0.0.14").result, { outcome: "refused",
        code: "updater-missing",
        finishedAt: "2026-10-01T10:18:00Z" });
    assert.equal(derivePanelUpdateOperation(helper({ exitCode: 126,
        startError: "permission denied" }), [], "0.0.14").result?.code, "updater-missing");
    assert.equal(derivePanelUpdateOperation(helper({ exitCode: 128,
        startError: "OCI runtime create failed" }), [], "0.0.14").result?.code, "start-failed");
    // An updater older than --progress json rejects the flag before printing anything
    assert.equal(derivePanelUpdateOperation(helper({ exitCode: 2 }), [], "0.0.14").result?.code, "updater-outdated");
    assert.equal(derivePanelUpdateOperation(helper({ exitCode: 2 }), [ result("refused", { op: "" }) ], "0.0.14").result?.outcome, "refused");
    assert.equal(derivePanelUpdateOperation(helper({ exitCode: 2 }), [ result("refused", { op: "" }) ], "0.0.14").result?.code, undefined);
    // 127 after the updater printed something is its own exit code, not a missing launcher
    assert.equal(derivePanelUpdateOperation(helper({ exitCode: 127 }), [ phase("prepared") ], "0.0.14").result?.code, "no-result");
});

test("without a result line the journal decides, and only for the same operation", () => {
    const journal = (phaseName : string, op = OP, to = "0.0.15") : PanelUpdateJournalLine => ({ dockge2: "journal",
        v: 1,
        op,
        phase: phaseName,
        from: "0.0.14",
        to });
    const killed = helper({ exitCode: 137 });
    const lines = [ phase("prepared"), phase("stopping") ];

    assert.deepEqual(derivePanelUpdateOperation(killed, lines, "0.0.14", journal("starting-target")).result, { outcome: "unknown",
        code: "interrupted",
        finishedAt: "2026-10-01T10:18:00Z" });
    assert.equal(derivePanelUpdateOperation(killed, lines, "0.0.14", journal("recovered")).result?.outcome, "recovered");
    // The journal carries the restore of the snapshot; an older updater's journal leaves it unknown
    for (const restoredData of [ true, false ]) {
        assert.deepEqual(derivePanelUpdateOperation(killed, lines, "0.0.14", { ...journal("recovered"),
            restoredData }).result, { outcome: "recovered",
            restoredData,
            finishedAt: "2026-10-01T10:18:00Z" });
    }
    assert.equal(derivePanelUpdateOperation(killed, lines, "0.0.14", journal("recovered")).result?.restoredData, undefined);
    assert.equal(derivePanelUpdateOperation(killed, lines, "0.0.15", journal("success")).result?.outcome, "success");
    assert.equal(derivePanelUpdateOperation(killed, lines, "0.0.14", journal("success")).result?.code, "version-mismatch");

    // A journal of another operation says nothing about this one
    assert.equal(derivePanelUpdateOperation(killed, lines, "0.0.14", journal("recovered", "20261002T000000.000000000")).result?.code, "no-result");
    // Without any journal the result stays unknown
    assert.equal(derivePanelUpdateOperation(killed, lines, "0.0.14").result?.code, "no-result");
    // A dry run never consults the journal
    assert.equal(derivePanelUpdateOperation(helper({ kind: "preview",
        exitCode: 137 }), [], "0.0.14", journal("success")).result?.code, "no-result");
});

test("a helper killed before its first line takes only a journal recorded after it started", () => {
    const journal = (phaseName : string, op : string, from = "0.0.14", to = "0.0.15") : PanelUpdateJournalLine => ({ dockge2: "journal",
        v: 1,
        op,
        phase: phaseName,
        from,
        to });
    const killed = helper({ exitCode: 137 });

    assert.equal(derivePanelUpdateOperation(killed, [], "0.0.14", journal("recovered", "20261001T101502.500000000")).result?.outcome, "recovered");
    // The journal keeps the previous update until this one records its operation
    assert.equal(derivePanelUpdateOperation(killed, [], "0.0.14", journal("recovered", "20260920T080000.000000000")).result?.code, "no-result");
    assert.equal(derivePanelUpdateOperation(killed, [], "0.0.14", journal("failed-before-cutover", "20261001T101502.500000000", "0.0.13", "0.0.14")).result?.code, "no-result");
    assert.equal(derivePanelUpdateOperation(killed, [], "0.0.14", journal("recovered", "not-an-operation")).result?.code, "no-result");
    // An id from the lines does not excuse other versions
    assert.equal(derivePanelUpdateOperation(killed, [ phase("prepared") ], "0.0.14", journal("recovered", OP, "0.0.14", "0.0.16")).result?.code, "no-result");
});
