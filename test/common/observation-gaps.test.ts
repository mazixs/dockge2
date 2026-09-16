import { strict as assert } from "node:assert";
import test from "node:test";
import { computeAvailability } from "../../common/availability";
import { RUNNING, UNKNOWN } from "../../common/util-common";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

test("unconfirmed legacy change cannot describe a day of uptime", () => {
    const result = computeAvailability([{ status: RUNNING,
        at: NOW - 24 * HOUR }], 24 * HOUR, NOW);
    assert.equal(result.coveredMs, 0);
    assert.equal(result.ratio, null);
    assert.equal(result.currentStatus, UNKNOWN);
});

test("explicit observations leave the server restart gap uncovered", () => {
    const result = computeAvailability([
        { status: RUNNING,
            at: NOW - 24 * HOUR,
            until: NOW - 12 * HOUR },
        { status: RUNNING,
            at: NOW - 6 * HOUR,
            until: NOW },
    ], 24 * HOUR, NOW);
    assert.equal(result.coveredMs, 18 * HOUR);
    assert.equal(result.ratio, 1);
    assert.equal(result.currentForMs, 6 * HOUR);
});

test("unknown Docker observations are not known downtime or uptime", () => {
    const result = computeAvailability([
        { status: RUNNING,
            at: NOW - 24 * HOUR,
            until: NOW - 12 * HOUR },
        { status: UNKNOWN,
            at: NOW - 12 * HOUR,
            until: NOW },
    ], 24 * HOUR, NOW);
    assert.equal(result.coveredMs, 12 * HOUR);
    assert.equal(result.currentStatus, UNKNOWN);
    assert.equal(result.currentForMs, null);
    assert.equal(result.incidents, 0);
});
