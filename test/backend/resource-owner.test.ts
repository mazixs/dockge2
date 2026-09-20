import assert from "node:assert/strict";
import test from "node:test";
import { ResourceOwner } from "../../backend/resource-owner";

test("stops resources in reverse order of registration", async () => {
    const owner = new ResourceOwner();
    const order : string[] = [];

    owner.add("database", () => {
        order.push("database");
    });
    owner.add("terminals", () => {
        order.push("terminals");
    });
    owner.add("timer", () => {
        order.push("timer");
    });

    const report = await owner.stop(1000);

    assert.deepEqual(order, [ "timer", "terminals", "database" ]);
    assert.deepEqual(report.stopped, [ "timer", "terminals", "database" ]);
    assert.equal(report.failed.length, 0);
});

test("a failing cleanup does not keep the others from stopping", async () => {
    const owner = new ResourceOwner();
    const stopped : string[] = [];

    owner.add("database", () => {
        stopped.push("database");
    });
    owner.add("agent connections", () => {
        throw new Error("socket already gone");
    });
    owner.add("timer", async () => {
        stopped.push("timer");
    });

    const report = await owner.stop(1000);

    assert.deepEqual(stopped, [ "timer", "database" ]);
    assert.deepEqual(report.stopped, [ "timer", "database" ]);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.name, "agent connections");
    assert.equal(report.failed[0]?.error, "socket already gone");
});

test("a cleanup that never finishes does not hold the shutdown", async () => {
    const owner = new ResourceOwner();
    let closed = false;

    owner.add("database", () => {
        closed = true;
    });
    owner.add("stuck terminal", () => new Promise(() => {}));

    const started = Date.now();
    const report = await owner.stop(1000);

    assert.equal(closed, true, "the database has to be closed even after a stuck resource");
    assert.deepEqual(report.timedOut, [ "stuck terminal" ]);
    assert.ok(Date.now() - started < 5000, "the shutdown has to stay inside its budget");
});

test("stopping twice runs the cleanup once", async () => {
    const owner = new ResourceOwner();
    let calls = 0;

    owner.add("database", () => {
        calls++;
    });

    const [ first, second ] = await Promise.all([ owner.stop(1000), owner.stop(1000) ]);

    await owner.stop(1000);

    assert.equal(calls, 1);
    assert.deepEqual(first?.stopped, [ "database" ]);
    assert.deepEqual(second?.stopped, [ "database" ]);
});

test("a resource that ended on its own is not stopped again", async () => {
    const owner = new ResourceOwner();
    let stops = 0;

    const forget = owner.add("terminal", () => {
        stops++;
    });

    assert.equal(owner.size, 1);
    forget();
    assert.equal(owner.size, 0);

    await owner.stop(1000);

    assert.equal(stops, 0);
});

test("a periodic task started before the shutdown stops using the database", async () => {
    const owner = new ResourceOwner();
    const queries : string[] = [];
    let databaseOpen = true;
    let rounds = 0;

    // The same shape as the server: a timer that asks the owner whether to start
    // another round, a cleanup that fails, and the database released last
    owner.add("database", () => {
        databaseOpen = false;
    });
    owner.add("agent connections", () => {
        throw new Error("refused to close");
    });

    const poll = setInterval(() => {
        if (owner.stopping) {
            return;
        }
        rounds++;
        queries.push(databaseOpen ? "ok" : "after close");
    }, 5);
    owner.addTimer("stack observation", poll);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const roundsBeforeStop = rounds;

    const report = await owner.stop(1000);
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.ok(roundsBeforeStop > 0, "the test needs the polling to have run");
    assert.equal(queries.includes("after close"), false, "no task may query a closed database");
    assert.equal(rounds, roundsBeforeStop, "no round may start once the shutdown began");
    assert.equal(report.failed.length, 1);
    assert.equal(databaseOpen, false);
});
