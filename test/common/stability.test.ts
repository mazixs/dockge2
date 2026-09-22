import { strict as assert } from "node:assert";
import test from "node:test";
import { buildStabilityHistory, containerUptime, normaliseContainerRuntime, runtimeStatus } from "../../common/stability";
import { ATTENTION, EXITED, RUNNING, UNKNOWN } from "../../common/util-common";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

test("Docker StartedAt gives runtime only for a currently running container", () => {
    assert.equal(containerUptime("running", NOW - HOUR, NOW), HOUR);
    assert.equal(containerUptime("exited", NOW - HOUR, NOW), null);
    assert.equal(containerUptime("running", NOW + HOUR, NOW), null);
    assert.equal(containerUptime("running", 0, NOW), null);
    assert.equal(containerUptime("running", null, NOW), null);
});

test("normalisation retains only safe runtime fields and valid Docker timestamps", () => {
    const result = normaliseContainerRuntime({ id: "a".repeat(64),
        name: "/demo-web-1",
        project: "demo",
        service: "web",
        workingDir: "/stacks/demo",
        state: "running",
        health: "healthy",
        startedAt: new Date(NOW - HOUR).toISOString(),
        restartCount: 3,
        env: [ "PASSWORD=secret" ] });
    assert.equal(result?.name, "demo-web-1");
    assert.equal(result?.startedAt, NOW - HOUR);
    assert.equal(result?.restartCount, 3);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(normaliseContainerRuntime({ id: "invalid" }), null);
    assert.equal(normaliseContainerRuntime({ id: "a".repeat(64),
        name: "demo",
        startedAt: "0001-01-01T00:00:00Z",
        restartCount: -1 })?.startedAt, null);
});

test("unhealthy and unknown runtime never become running", () => {
    assert.equal(runtimeStatus("running", "healthy"), RUNNING);
    assert.equal(runtimeStatus("running", "unhealthy"), ATTENTION);
    assert.equal(runtimeStatus("restarting", ""), ATTENTION);
    assert.equal(runtimeStatus("", ""), UNKNOWN);
});

test("history shows observation gaps separately from running and attention", () => {
    const history = buildStabilityHistory([
        { status: RUNNING,
            at: NOW - 4 * HOUR,
            until: NOW - 3 * HOUR },
        { status: ATTENTION,
            at: NOW - 2 * HOUR,
            until: NOW - HOUR },
        { status: UNKNOWN,
            at: NOW - HOUR,
            until: NOW },
    ], 4 * HOUR, NOW, 4);
    assert.deepEqual(history.map((bucket) => bucket.state), [ "running", "unknown", "attention", "unknown" ]);
    assert.deepEqual(history.map((bucket) => bucket.coverage), [ 1, 0, 1, 0 ]);
});

test("a brief success in a mostly unobserved bucket is explicitly partial", () => {
    const history = buildStabilityHistory([{ status: RUNNING,
        at: NOW - 60_000,
        until: NOW }], HOUR, NOW, 1);
    assert.equal(history[0]?.coverage, 1 / 60);
    assert.equal(history[0]?.state, "running");
});

test("a history bucket containing a stop is not painted as uninterrupted running", () => {
    const history = buildStabilityHistory([
        { status: RUNNING,
            at: NOW - HOUR,
            until: NOW - 60_000 },
        { status: EXITED,
            at: NOW - 60_000,
            until: NOW },
    ], HOUR, NOW, 1);
    assert.notEqual(history[0]?.state, "running");
});

test("history clips unsorted intervals, duplicate starts, gaps and future observations", () => {
    const history = buildStabilityHistory([
        { status: ATTENTION,
            at: NOW - HOUR,
            until: NOW + HOUR },
        { status: RUNNING,
            at: NOW - 5 * HOUR,
            until: NOW - 2 * HOUR },
        { status: RUNNING,
            at: NOW - HOUR,
            until: NOW },
        { status: EXITED,
            at: NOW + HOUR,
            until: NOW + 2 * HOUR },
    ], 4 * HOUR, NOW, 4);
    assert.deepEqual(history.map(bucket => [ bucket.state, bucket.coverage ]), [
        [ "running", 1 ], [ "running", 1 ], [ "unknown", 0 ], [ "running", 1 ],
    ]);
});

test("thousands of short alternating intervals retain exact coverage across bucket boundaries", () => {
    const changes = Array.from({ length: 5000 }, (_, i) => ({
        at: i * 1000,
        until: i * 1000 + 500,
        status: i % 2 === 0 ? RUNNING : ATTENTION,
    }));
    const history = buildStabilityHistory(changes, 5_000_000, 5_000_000, 50);
    assert.ok(history.every(bucket => bucket.state === "attention" && bucket.coverage === 0.5));
    assert.equal(history[0]?.from, 0);
    assert.equal(history.at(-1)?.to, 5_000_000);
});
