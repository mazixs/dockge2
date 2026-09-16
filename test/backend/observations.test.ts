import { strict as assert } from "node:assert";
import test from "node:test";
import { Database } from "../../backend/database";
import { pruneOldObservations, readAvailability, readChanges, recordScan, recordStatus, resetObservationState, RETENTION_MS } from "../../backend/observations";
import { ATTENTION, EXITED, RUNNING, UNKNOWN } from "../../common/util-common";
import { withDatabase } from "../helpers/database";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

test("continuous equal samples extend one row and a change closes the previous interval", async () => {
    await withDatabase(async () => {
        resetObservationState();
        assert.equal(await recordStatus("demo", "", RUNNING, NOW - 20_000), true);
        assert.equal(await recordStatus("demo", "", RUNNING, NOW - 10_000), false);
        assert.equal(await recordStatus("demo", "", ATTENTION, NOW), true);
        const rows = await Database.getKnex()("stack_observation").orderBy("observed_at");
        assert.equal(rows.length, 2);
        assert.equal(Number(rows[0].observed_until), NOW);
    });
});

test("an old timestamp without later confirmation never implies continuous running", async () => {
    await withDatabase(async () => {
        resetObservationState();
        await recordStatus("demo", "", RUNNING, NOW - 30 * DAY);
        assert.equal((await readChanges("demo", "", DAY, NOW)).length, 1);
        const availability = await readAvailability("demo", "", DAY, NOW);
        assert.equal(availability.verdict, "noData");
        assert.equal(availability.coveredMs, 0);
        assert.equal(availability.currentStatus, UNKNOWN);
    });
});

test("confirmed intervals are read across the left window edge and agent histories stay distinct", async () => {
    await withDatabase(async () => {
        await Database.getKnex()("stack_observation").insert([
            { stack_name: "demo",
                endpoint: "",
                status: RUNNING,
                observed_at: NOW - 2 * DAY,
                observed_until: NOW },
            { stack_name: "demo",
                endpoint: "nas:5001",
                status: EXITED,
                observed_at: NOW - 2 * DAY,
                observed_until: NOW },
        ]);
        assert.equal((await readAvailability("demo", "", DAY, NOW)).verdict, "clean");
        assert.equal((await readAvailability("demo", "nas:5001", DAY, NOW)).verdict, "stopped");
    });
});

test("a scan writes new rows only for changed states within uninterrupted observation", async () => {
    await withDatabase(async () => {
        resetObservationState();
        const scan = [{ name: "a",
            endpoint: "",
            status: RUNNING }, { name: "b",
            endpoint: "",
            status: EXITED }];
        assert.equal(await recordScan(scan, NOW - 20_000), 2);
        assert.equal(await recordScan(scan, NOW - 10_000), 0);
        scan[1] = { name: "b",
            endpoint: "",
            status: RUNNING };
        assert.equal(await recordScan(scan, NOW), 1);
    });
});

test("retention keeps a long active interval while removing old unconfirmed timestamps", async () => {
    await withDatabase(async () => {
        await Database.getKnex()("stack_observation").insert([
            { stack_name: "old",
                endpoint: "",
                status: RUNNING,
                observed_at: NOW - RETENTION_MS - DAY,
                observed_until: NOW - RETENTION_MS - DAY },
            { stack_name: "active",
                endpoint: "",
                status: RUNNING,
                observed_at: NOW - RETENTION_MS - DAY,
                observed_until: NOW },
        ]);
        assert.equal(await pruneOldObservations(NOW), 1);
        assert.equal((await readAvailability("active", "", 30 * DAY, NOW)).coveredMs, 30 * DAY);
    });
});

test("a confirmed one hour incident gives 23/24 availability without counting missing time", async () => {
    await withDatabase(async () => {
        await Database.getKnex()("stack_observation").insert([
            { stack_name: "demo",
                endpoint: "",
                status: RUNNING,
                observed_at: NOW - DAY,
                observed_until: NOW - 3 * HOUR },
            { stack_name: "demo",
                endpoint: "",
                status: ATTENTION,
                observed_at: NOW - 3 * HOUR,
                observed_until: NOW - 2 * HOUR },
            { stack_name: "demo",
                endpoint: "",
                status: RUNNING,
                observed_at: NOW - 2 * HOUR,
                observed_until: NOW },
        ]);
        const availability = await readAvailability("demo", "", DAY, NOW);
        assert.equal(availability.verdict, "degraded");
        assert.equal(availability.incidents, 1);
        assert.equal(availability.ratio, 23 / 24);
    });
});

test("unchanged observations confirm a bounded interval and a later gap starts a new one", async () => {
    await withDatabase(async () => {
        resetObservationState();
        await recordStatus("bounded", "", RUNNING, NOW - 60_000);
        await recordStatus("bounded", "", RUNNING, NOW - 50_000);
        await recordStatus("bounded", "", RUNNING, NOW);
        const changes = await readChanges("bounded", "", DAY, NOW);
        assert.equal(changes.length, 2);
        assert.equal(changes[0]?.until, NOW - 50_000);
        assert.equal((await readAvailability("bounded", "", DAY, NOW)).coveredMs, 10_000);
    });
});

test("process restart does not reconnect an old observation interval", async () => {
    await withDatabase(async () => {
        resetObservationState();
        await recordStatus("restart", "", RUNNING, NOW - 20_000);
        await recordStatus("restart", "", RUNNING, NOW - 10_000);
        resetObservationState();
        await recordStatus("restart", "", RUNNING, NOW);
        assert.equal((await readAvailability("restart", "", DAY, NOW)).coveredMs, 10_000);
    });
});
