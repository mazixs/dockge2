import { strict as assert } from "node:assert";
import test from "node:test";
import { ResourceOwner } from "../../backend/resource-owner";
import { ScheduledRounds } from "../../backend/scheduled-rounds";

/** Every second, so a test sees a real firing of the real scheduler */
const EVERY_SECOND = "* * * * * *";

/** A promise together with the functions that settle it from the outside */
interface Gate {
    promise : Promise<void>;
    open : () => void;
    fail : (error : Error) => void;
}

/**
 * Something a test can wait for and release by hand
 * @returns The promise and its controls
 */
function gate() : Gate {
    let open : () => void = () => undefined;
    let fail : (error : Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
        open = resolve;
        fail = reject;
    });

    return { promise,
        open,
        fail };
}

/**
 * Wait a moment, used where a test has to give other work the chance to happen
 * @param ms How long to wait
 */
function pause(ms : number) : Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the shutdown waits for the round that is already running before releasing what it uses", async () => {
    const owner = new ResourceOwner();
    const started = gate();
    const docker = gate();
    let databaseOpen = true;
    let sawClosedDatabase = false;

    // Registered first means released last, exactly as the server registers it
    owner.add("database", () => {
        databaseOpen = false;
    });

    const rounds = new ScheduledRounds("stack observation", EVERY_SECOND, async () => {
        started.open();
        await docker.promise;

        // The round continues where a real one would use the database
        if (!databaseOpen) {
            sawClosedDatabase = true;
        }
    });
    owner.add("stack observation", () => rounds.stop());
    rounds.start();

    try {
        await started.promise;

        // The shutdown begins while the round is waiting for Docker
        const shutdown = owner.stop(5000);
        await pause(150);

        assert.equal(rounds.running, true, "the round is still the one this shutdown has to wait for");
        assert.equal(databaseOpen, true, "the database must not be closed while a round is still using it");

        docker.open();
        const report = await shutdown;

        assert.equal(sawClosedDatabase, false, "the round has to finish before its dependencies are released");
        assert.equal(databaseOpen, false);
        assert.deepEqual(report.stopped, [ "stack observation", "database" ]);
        assert.deepEqual(report.timedOut, []);
    } finally {
        docker.open();
        await owner.stop(1000);
    }
});

test("no further round starts once the schedule was stopped", async () => {
    let roundsRun = 0;
    const rounds = new ScheduledRounds("counted", EVERY_SECOND, async () => {
        roundsRun += 1;
    });

    rounds.start();

    // Long enough for the real scheduler to fire at least once
    await pause(1200);
    const before = roundsRun;
    assert.ok(before > 0, "the schedule has to run on its own before this proves anything");

    await rounds.stop();
    await pause(1200);

    assert.equal(roundsRun, before, "a stopped schedule must not fire again");

    // Starting again after a stop is refused: the owner released it, it is over
    rounds.start();
    await pause(1200);
    assert.equal(roundsRun, before);
});

test("a round that never finishes ends as a resource that timed out, not as silent work", async () => {
    const owner = new ResourceOwner();
    const started = gate();
    const stuck = gate();
    let finished = false;

    const rounds = new ScheduledRounds("stuck", EVERY_SECOND, async () => {
        started.open();
        await stuck.promise;
        finished = true;
    });
    owner.add("stuck", () => rounds.stop());
    rounds.start();

    try {
        await started.promise;
        const report = await owner.stop(600);

        assert.deepEqual(report.timedOut, [ "stuck" ]);
        assert.equal(finished, false, "the round really was still running when the budget ran out");
        assert.ok(report.durationMs < 5000, "the shutdown must not wait for a round that never ends");
    } finally {
        stuck.open();
    }
});

test("a round that fails is logged and does not keep the schedule from stopping", async () => {
    const started = gate();
    const rounds = new ScheduledRounds("failing", EVERY_SECOND, async () => {
        started.open();
        await pause(10);
        throw new Error("docker is not there");
    });

    rounds.start();
    await started.promise;
    await rounds.stop();

    assert.equal(rounds.running, false);
});

test("a stop that arrives between two rounds does not wait for anything", async () => {
    const rounds = new ScheduledRounds("idle", EVERY_SECOND, async () => {
        await pause(5);
    });

    rounds.start();
    await pause(1200);

    const startedAt = Date.now();
    await rounds.stop();

    assert.ok(Date.now() - startedAt < 500, "there is nothing running, so there is nothing to wait for");
});
