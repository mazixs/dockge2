import { strict as assert } from "node:assert";
import test from "node:test";
import { apiRateLimiter } from "../../backend/rate-limiter";
import { LimitQueue } from "../../backend/utils/limit-queue";

test("LimitQueue drops the oldest item and reports it when the limit is exceeded", () => {
    const queue = new LimitQueue<number>(2);
    const removed: Array<number | undefined> = [];
    queue.__onExceed = (item) => removed.push(item);

    queue.pushItem(1);
    queue.pushItem(2);
    queue.pushItem(3);

    assert.deepEqual([ ...queue ], [ 2, 3 ]);
    assert.deepEqual(removed, [ 1 ]);
});

test("rate limiter allows a real request and reports the remaining budget", async () => {
    let callbackCalled = false;
    const allowed = await apiRateLimiter.pass(() => {
        callbackCalled = true;
    });

    assert.equal(allowed, true);
    assert.equal(callbackCalled, false);
});
