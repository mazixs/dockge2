import assert from "node:assert/strict";
import test from "node:test";
import { SharedReading } from "../../backend/shared-reading";

test("callers that arrive while a reading runs share it", async () => {
    let reads = 0;
    const reading = new SharedReading(async () => {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return reads;
    }, 1000);

    const [ first, second, third ] = await Promise.all([ reading.get(), reading.get(), reading.get() ]);

    assert.equal(reads, 1, "three screens asking at once must not start three Docker calls");
    assert.deepEqual([ first, second, third ], [ 1, 1, 1 ]);
});

test("a fresh value is handed out again, an old one is read anew", async () => {
    let reads = 0;
    const reading = new SharedReading(async () => ++reads, 1000);
    const now = Date.now();

    assert.equal(await reading.get(now), 1);
    assert.equal(await reading.get(now + 500), 1);
    assert.equal(await reading.get(now + 1500), 2);
    assert.equal(reads, 2);
});

test("a failed reading is not remembered", async () => {
    let attempt = 0;
    const reading = new SharedReading(async () => {
        attempt++;
        if (attempt === 1) {
            throw new Error("docker is not running");
        }
        return attempt;
    }, 1000);

    await assert.rejects(reading.get(), /docker is not running/);
    assert.equal(await reading.get(), 2);
});

test("invalidating makes the next caller read again", async () => {
    let reads = 0;
    const reading = new SharedReading(async () => ++reads, 60_000);

    assert.equal(await reading.get(), 1);
    assert.equal(await reading.get(), 1);

    reading.invalidate();

    assert.equal(await reading.get(), 2);
});
