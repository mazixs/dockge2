import { strict as assert } from "node:assert";
import test from "node:test";
import { StabilityCollector } from "../../backend/stability";
import { Database } from "../../backend/database";
import type { ContainerRuntime } from "../../common/stability";
import { UNKNOWN } from "../../common/util-common";
import { withDatabase } from "../helpers/database";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const container : ContainerRuntime = { id: "a".repeat(64),
    name: "demo-web-1",
    project: "renamed-demo",
    service: "web",
    workingDir: "/stacks/demo",
    state: "running",
    health: "healthy",
    startedAt: NOW - 3_600_000,
    restartCount: 2 };
const stacks = new Map([[ "demo", { name: "demo",
    path: "/stacks/demo",
    isManagedByDockge: true }]]);

test("collector persists runtime, maps project directory, and limits Docker sampling", async () => {
    await withDatabase(async () => {
        let calls = 0;
        const collector = new StabilityCollector(async () => {
            calls += 1;
            return [ container ];
        });
        await collector.observe(stacks, NOW);
        await collector.observe(stacks, NOW + 10_000);
        await collector.observe(stacks, NOW + MINUTE);
        assert.equal(calls, 2);
        const result = await collector.read(24, NOW + MINUTE);
        assert.equal(result.stacks[0]?.name, "demo");
        assert.equal(result.stacks[0]?.managed, true);
        assert.equal(result.stacks[0]?.containers[0]?.uptimeMs, 3_660_000);
        assert.equal(result.stacks[0]?.containers[0]?.availability.coveredMs, MINUTE);
        assert.equal(JSON.stringify(result).includes("/stacks/demo"), false);
        assert.equal((await Database.getKnex()("container_observation")).length, 1);
    });
});

test("stale or failed samples preserve history but expose no current green or uptime", async () => {
    await withDatabase(async () => {
        let failed = false;
        const collector = new StabilityCollector(async () => {
            if (failed) {
                throw new Error("Docker unavailable");
            }
            return [ container ];
        });
        await collector.observe(stacks, NOW);
        await collector.observe(stacks, NOW + MINUTE);
        failed = true;
        await collector.observe(stacks, NOW + 2 * MINUTE);
        const result = await collector.read(24, NOW + 2 * MINUTE);
        assert.equal(result.stale, true);
        assert.equal(result.error, "dockerUnavailable");
        assert.equal(result.stacks[0]?.containers[0]?.state, "unknown");
        assert.equal(result.stacks[0]?.containers[0]?.uptimeMs, null);
        assert.equal(result.stacks[0]?.containers[0]?.availability.coveredMs, MINUTE);
        assert.equal(result.stacks[0]?.containers[0]?.availability.currentStatus, UNKNOWN);
        const restarted = new StabilityCollector(async () => [ container ]);
        assert.equal((await restarted.read(24, NOW + 2 * MINUTE)).stale, true);
        await restarted.observe(stacks, NOW + 10 * MINUTE);
        await restarted.observe(stacks, NOW + 11 * MINUTE);
        assert.equal((await restarted.read(24, NOW + 11 * MINUTE)).stacks[0]?.containers[0]?.availability.coveredMs, 2 * MINUTE);
    });
});

test("standalone containers get their own group and replaced IDs keep distinct history", async () => {
    await withDatabase(async () => {
        let rows = [{ ...container,
            project: "",
            service: "",
            workingDir: "" }];
        const collector = new StabilityCollector(async () => rows);
        await collector.observe(stacks, NOW);
        await collector.observe(stacks, NOW + MINUTE);
        rows = [{ ...rows[0]!,
            id: "b".repeat(64),
            startedAt: NOW + MINUTE }];
        await collector.observe(stacks, NOW + 2 * MINUTE);
        const result = await collector.read(24, NOW + 2 * MINUTE);
        assert.equal(result.stacks[0]?.standalone, true);
        assert.equal(result.stacks[0]?.managed, false);
        assert.equal(result.stacks[0]?.containers[0]?.availability.coveredMs, 0);
        assert.equal(result.stacks[0]?.containers[0]?.uptimeMs, MINUTE);
        rows = [];
        await collector.observe(stacks, NOW + 3 * MINUTE);
        assert.deepEqual((await collector.read(24, NOW + 3 * MINUTE)).stacks, []);
    });
});

test("no snapshot is distinguished from an observed empty Docker host", async () => {
    await withDatabase(async () => {
        const collector = new StabilityCollector(async () => []);
        assert.equal((await collector.read(24, NOW)).error, "noObservation");
        await collector.observe(stacks, NOW);
        const empty = await collector.read(24, NOW);
        assert.equal(empty.stale, false);
        assert.equal(empty.error, null);
        assert.deepEqual(empty.stacks, []);
    });
});
