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

test("the panel's own containers are not recorded", async () => {
    await withDatabase(async () => {
        const panel : ContainerRuntime = { id: "b".repeat(64),
            name: "dockge2-dockge-1",
            project: "dockge2",
            service: "dockge",
            workingDir: "/opt/dockge2",
            state: "running",
            health: "healthy",
            startedAt: NOW - 60_000,
            restartCount: 0 };

        const collector = new StabilityCollector(async () => [ container, panel ]);
        await collector.observe(stacks, NOW, "dockge2");
        const result = await collector.read(24, NOW);

        const names = result.stacks.flatMap((stack) => stack.containers.map((c) => c.name));
        assert.deepEqual(names, [ "demo-web-1" ], "only the real stack is recorded");
        assert.equal(JSON.stringify(result).includes("dockge2"), false);

        // Without the project name nothing is filtered: the panel may run outside
        // Compose, and then there is no project of its own to leave out
        const everything = new StabilityCollector(async () => [ container, panel ]);
        await everything.observe(stacks, NOW);
        const all = await everything.read(24, NOW);
        assert.equal(all.stacks.flatMap((s) => s.containers).length, 2);
    });
});

test("a stop that lands inside the Docker read reaches the database too", async (context) => {
    await withDatabase(async () => {
        let reached = () => {};
        const reading = new Promise<void>((resolve) => {
            reached = resolve;
        });

        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Docker is what takes the time, and this read is caught in the middle of it:
        // the shutdown starts after the collector is already inside, which is where the
        // signal of the round used to stop arriving
        const collector = new StabilityCollector(async () => {
            reached();
            await held;
            return [ container ];
        });

        const touched : string[] = [];
        const realKnex = Database.getKnex.bind(Database);
        context.mock.method(Database, "getKnex", () => {
            touched.push("knex");
            return realKnex();
        });

        const controller = new AbortController();
        const observing = collector.observe(stacks, NOW, "", controller.signal);
        await reading;
        controller.abort();
        release();
        await observing;

        // A failed write is swallowed by the collector, so counting the writes is the
        // only honest measure: the warning "Cannot record a Docker runtime observation"
        // is what this used to produce against a database that was already closed
        assert.deepEqual(touched, [], "an abandoned observation reached the database anyway");

        // The same observation without a signal writes, which is what makes the check
        // above a statement about the abort and not about an empty sample
        const writing = new StabilityCollector(async () => [ container ]);
        await writing.observe(stacks, NOW, "");
        assert.ok(touched.length > 0, "a normal observation has to record what it read");
    });
});

test("a stop between two containers leaves the write rolled back, not half applied", async (context) => {
    await withDatabase(async () => {
        const second : ContainerRuntime = { ...container,
            id: "b".repeat(64),
            name: "demo-db-1",
            service: "db" };

        const controller = new AbortController();
        const collector = new StabilityCollector(async () => [ container, second ]);
        const knex = Database.getKnex();
        const real = knex.transaction.bind(knex);

        // The signal arrives once the transaction is open: the first container is written
        // and the second is where the round is asked to give up
        context.mock.method(knex, "transaction", (handler : (trx : unknown) => Promise<unknown>) => real(async (trx : unknown) => {
            const answer = handler(trx);
            controller.abort();
            return answer;
        }));

        await collector.observe(stacks, NOW, "", controller.signal);

        assert.equal((await Database.getKnex()("container_observation")).length, 0,
            "a cancelled observation left rows behind");

        // A cancelled round is not a Docker failure: what the panel knew it still knows
        const result = await collector.read(24, NOW);
        assert.equal(result.error, "noObservation");
    });
});
