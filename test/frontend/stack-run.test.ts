import { strict as assert } from "node:assert";
import test from "node:test";
import { StackRun, type StackRunTarget } from "../../frontend/src/stack-run";
import type { ComposeTask } from "../../common/compose-progress";

const alpha : StackRunTarget = { endpoint: "",
    stack: "alpha" };
const beta : StackRunTarget = { endpoint: "",
    stack: "beta" };

/** Tick fast, so a test does not wait the two seconds the screen waits */
const TICK_MS = 10;

/**
 * One step of a command, as the progress line reports it
 * @param name Container the step is about
 * @returns The step
 */
function task(name : string) : ComposeTask {
    return { key: `container:${name}`,
        kind: "container",
        name,
        verb: "starting",
        state: "working",
        seconds: null };
}

/**
 * A run whose clock and calendar the test controls
 * @returns The run, how often it ticked and the clock it reads
 */
function makeRun() {
    const ticks = { count: 0 };
    let now = 1_000_000;
    const run = new StackRun(() => {
        ticks.count++;
    }, TICK_MS, () => now);

    return { run,
        ticks,
        advance: (ms : number) => {
            now += ms;
        } };
}

/**
 * Give the interval the chance to fire
 * @param ms How long to wait
 */
function pause(ms : number) : Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("a running command counts its seconds and asks for the status again", async () => {
    const { run, ticks, advance } = makeRun();

    try {
        run.start(alpha, "updateStack");
        advance(4000);
        await pause(TICK_MS * 4);

        assert.equal(run.running, true);
        assert.equal(run.event, "updateStack");
        assert.ok(ticks.count > 0, "the screen has to be refreshed while the command runs");
        assert.equal(run.elapsed, 4, "the clock shows the seconds of the command, not of the ticks");
    } finally {
        run.release();
    }
});

test("moving to another stack takes the clock, the steps and the outcome with it", async () => {
    const { run, ticks } = makeRun();

    run.start(alpha, "updateStack");
    run.setProgress(alpha, { tasks: [ task("alpha-app-1") ],
        hasOutput: true });
    await pause(TICK_MS * 3);
    assert.ok(ticks.count > 0);

    // The user picks another stack while the update is still running
    run.release();
    const ticksAtSwitch = ticks.count;
    await pause(TICK_MS * 5);

    assert.equal(ticks.count, ticksAtSwitch, "the timer of the stack that was left must not keep polling");
    assert.equal(run.running, false);
    assert.equal(run.event, "");
    assert.equal(run.elapsed, 0);
    assert.equal(run.outcome, "");
    assert.deepEqual(run.tasks, []);
    assert.equal(run.hasOutput, false);
});

test("the answer of the stack that was left does not reach the new screen", async () => {
    const { run, ticks } = makeRun();

    run.start(alpha, "updateStack");
    run.setProgress(alpha, { tasks: [ task("alpha-app-1") ],
        hasOutput: true });
    run.release();

    // Nothing is running on beta: the user only opened it
    assert.equal(run.finish(alpha, "failed"), false, "the answer belongs to a stack that is no longer on the screen");
    assert.equal(run.running, false);
    assert.equal(run.outcome, "", "beta must not show how the command of alpha ended");
    assert.deepEqual(run.tasks, []);

    await pause(TICK_MS * 3);
    assert.equal(ticks.count, 0, "the released operation must not leave a timer behind");
});

test("a late answer of the previous stack leaves a command of the new stack alone", async () => {
    const { run } = makeRun();

    try {
        run.start(alpha, "updateStack");
        run.release();
        run.start(beta, "startStack");

        assert.equal(run.finish(alpha, "ok"), false);
        assert.equal(run.running, true, "the command of the current stack is still running");
        assert.equal(run.event, "startStack");
        assert.equal(run.outcome, "");

        // The progress of the stack that was left does not describe this one either
        assert.equal(run.setProgress(alpha, { tasks: [ task("alpha-app-1") ],
            hasOutput: true }), false);
        assert.deepEqual(run.tasks, []);
    } finally {
        run.release();
    }
});

test("the answer of the stack on the screen is applied and stops the clock", async () => {
    const { run, ticks } = makeRun();

    run.start(alpha, "updateStack");
    await pause(TICK_MS * 3);
    assert.ok(ticks.count > 0);

    assert.equal(run.finish(alpha, "ok"), true);
    const ticksAtFinish = ticks.count;

    assert.equal(run.running, false);
    assert.equal(run.outcome, "ok");

    await pause(TICK_MS * 5);
    assert.equal(ticks.count, ticksAtFinish, "a finished command must not keep polling");
});

test("a second command replaces the first one instead of counting twice", async () => {
    const { run, ticks, advance } = makeRun();

    try {
        run.start(alpha, "updateStack");
        await pause(TICK_MS * 2);
        run.start(alpha, "restartStack");
        advance(3000);
        await pause(TICK_MS * 2);

        const afterTwoCommands = ticks.count;
        assert.equal(run.event, "restartStack");
        assert.equal(run.elapsed, 3, "the clock counts the command that is running, not the one before it");

        run.finish(alpha, "ok");
        await pause(TICK_MS * 4);
        assert.equal(ticks.count, afterTwoCommands, "the first command must not have left a timer of its own");
    } finally {
        run.release();
    }
});

test("progress that arrives while nothing runs belongs to the screen that is open", () => {
    const { run } = makeRun();

    // Somebody deployed this stack from another place: the terminal reports it
    assert.equal(run.setProgress(beta, { tasks: [ task("beta-app-1") ],
        hasOutput: false }), true);
    assert.deepEqual(run.tasks.map((item) => item.name), [ "beta-app-1" ]);
});

test("releasing a run that owns nothing is allowed and changes nothing", () => {
    const { run } = makeRun();

    run.release();
    run.release();

    assert.equal(run.running, false);
    assert.equal(run.finish(alpha, "ok"), false);
});
