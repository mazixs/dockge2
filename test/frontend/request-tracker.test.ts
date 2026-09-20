import { strict as assert } from "node:assert";
import test from "node:test";
import { RequestTracker } from "../../frontend/src/request-tracker";

/**
 * A request whose answer the test decides when to deliver
 * @returns The promise to hand to the tracker and the way to answer it
 */
function deferred<T>() {
    let resolve : (value : T) => void = () => undefined;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });

    return { promise,
        resolve };
}

test("an answer of the previous stack does not reach the current screen", async () => {
    const tracker = new RequestTracker();
    const alpha = deferred<string>();
    const beta = deferred<string>();

    // The page asks for alpha, then the user picks beta before the answer arrives
    const first = tracker.run("stack", tracker.next(), () => alpha.promise);
    const second = tracker.run("stack", tracker.next(), () => beta.promise);

    // The answers come back in the other order, which is the whole point
    beta.resolve("beta");
    alpha.resolve("alpha");

    assert.equal(await second, "beta");
    assert.equal(await first, null, "the answer of the stack that is no longer open must be dropped");
});

test("only one request of a kind is in flight, the rest are not sent", async () => {
    const tracker = new RequestTracker();
    const answer = deferred<string>();
    let sent = 0;

    const generation = tracker.next();
    const ask = () => tracker.run("status", generation, () => {
        sent++;
        return answer.promise;
    });

    const first = ask();
    const second = ask();
    const third = ask();

    assert.equal(sent, 1, "a slow answer must not turn every tick into another request");
    assert.equal(await second, null);
    assert.equal(await third, null);

    answer.resolve("running");
    assert.equal(await first, "running");

    // Once the answer is in, the next poll is sent again
    answer.resolve("running");
    const next = deferred<string>();
    const fourth = tracker.run("status", generation, () => next.promise);
    next.resolve("stopped");
    assert.equal(await fourth, "stopped");
});

test("different kinds of data do not block each other", async () => {
    const tracker = new RequestTracker();
    const generation = tracker.next();
    const status = deferred<string>();
    const stats = deferred<string>();

    const statusAnswer = tracker.run("status", generation, () => status.promise);
    const statsAnswer = tracker.run("stats", generation, () => stats.promise);

    assert.equal(tracker.busy("status"), true);
    assert.equal(tracker.busy("stats"), true);

    stats.resolve("cpu");
    status.resolve("running");

    assert.equal(await statusAnswer, "running");
    assert.equal(await statsAnswer, "cpu");
    assert.equal(tracker.busy("status"), false);
});

test("a slow request of the previous selection does not block the new one", async () => {
    const tracker = new RequestTracker();
    const first = deferred<string>();
    const second = deferred<string>();
    let sent = 0;

    // Availability of the stack that was open is still being read when another is chosen
    const oldAnswer = tracker.run("availability", tracker.next(), () => {
        sent++;
        return first.promise;
    });
    const newAnswer = tracker.run("availability", tracker.next(), () => {
        sent++;
        return second.promise;
    });

    assert.equal(sent, 2, "the new screen has to be allowed to read, whatever the old one is waiting for");

    second.resolve("current");
    first.resolve("previous");

    assert.equal(await newAnswer, "current");
    assert.equal(await oldAnswer, null, "what was left behind must not replace what is shown");
});

test("leaving the screen drops the answers that are still on their way", async () => {
    const tracker = new RequestTracker();
    const answer = deferred<string>();
    const pending = tracker.run("stack", tracker.next(), () => answer.promise);

    tracker.invalidate();
    answer.resolve("late");

    assert.equal(await pending, null);
});

test("a failed request frees its kind for the next attempt", async () => {
    const tracker = new RequestTracker();
    const generation = tracker.next();

    await assert.rejects(tracker.run("status", generation, () => Promise.reject(new Error("no connection"))));
    assert.equal(tracker.busy("status"), false, "a failure must not block the polling for good");

    assert.equal(await tracker.run("status", generation, () => Promise.resolve("running")), "running");
});
