import { strict as assert } from "node:assert";
import test from "node:test";
import { Database } from "../../backend/database";
import type { DockgeServer } from "../../backend/dockge-server";
import { Stack } from "../../backend/stack";
import { stabilityCollector } from "../../backend/stability";
import { RUNNING } from "../../common/util-common";
import { withDatabase } from "../helpers/database";

/**
 * A round of the observation, run against a server that owns nothing but this method
 * @returns The server the test calls
 */
async function observer() : Promise<DockgeServer> {
    const { DockgeServer } = await import("../../backend/dockge-server");
    return Object.create(DockgeServer.prototype) as DockgeServer;
}

/** The stack list a round comes back from Docker with */
const observed = new Map([
    [ "observed", { name: "observed",
        status: RUNNING }],
]);

test("an observation whose shutdown started does not reach for the database", async (context) => {
    await withDatabase(async () => {
        const server = await observer();

        // Docker is what takes the time in a round, and this one is already past it: the
        // list is in hand, nothing is written yet, and this is when a shutdown can begin
        context.mock.method(Stack, "getStackList", async () => observed);

        const reached : string[] = [];
        const realKnex = Database.getKnex.bind(Database);
        context.mock.method(Database, "getKnex", () => {
            reached.push("knex");
            return realKnex();
        });

        const controller = new AbortController();
        controller.abort();

        // Told that its answer is no longer wanted, the round drops it. A failed write is
        // swallowed by the history, so counting the writes is the only honest measure:
        // the log line "Database is not connected" is what this used to produce instead
        await server.observeStacks(controller.signal);
        assert.deepEqual(reached, [], "an abandoned round asked the database anyway");

        // Without the signal the same round writes, which is what makes the check above
        // a statement about the abort rather than about an empty list
        await server.observeStacks();
        assert.ok(reached.length > 0, "a normal round has to record what it read");
    });
});

test("the round hands its signal to the stability collector", async (context) => {
    await withDatabase(async () => {
        const server = await observer();
        context.mock.method(Stack, "getStackList", async () => observed);

        // The collector reads Docker a second time, so it needs the abort of the round
        // as much as the round itself does: without it a stop landing inside that read
        // came back to a database that was already closed
        const given : (AbortSignal | undefined)[] = [];
        context.mock.method(stabilityCollector, "observe",
            async (_stacks : unknown, _now : unknown, _ownProject : unknown, signal? : AbortSignal) => {
                given.push(signal);
            });

        const controller = new AbortController();
        await server.observeStacks(controller.signal);

        assert.equal(given.length, 1);
        assert.equal(given[0], controller.signal, "the collector was called without the signal of the round");
    });
});
