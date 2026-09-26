import { strict as assert } from "node:assert";
import test from "node:test";
import { admitInOrder } from "../../backend/util-server";
import { sleep } from "../../common/util-common";

test("packets are admitted in the order they arrived, whichever check finishes first", async () => {
    const admitted : string[] = [];
    // The first key waits longest for its session, as a lookup that misses a cache does
    const delays : Record<string, number> = { c: 30,
        m: 0,
        d: 10 };
    const middleware = admitInOrder<string>(async (key) => {
        await sleep(delays[key] ?? 0);
    }, () => assert.fail("nothing was refused"));

    await Promise.all([ "c", "m", "d" ].map((key) => new Promise<void>((resolve) => middleware(key, () => {
        admitted.push(key);
        resolve();
    }))));
    assert.deepEqual(admitted, [ "c", "m", "d" ]);
});

test("a refused packet is answered in its turn and does not hold back the next", async () => {
    const events : string[] = [];
    const middleware = admitInOrder<string>(async (packet) => {
        // The refusal is decided before the packet ahead of it is admitted
        if (packet === "refused") {
            throw new Error("authPermissionDenied");
        }
        await sleep(20);
    }, (packet, error) => events.push(`${packet}: ${(error as Error).message}`));

    await new Promise<void>((resolve) => {
        middleware("first", () => events.push("first"));
        middleware("refused", () => events.push("refused was admitted"));
        middleware("last", () => {
            events.push("last");
            resolve();
        });
    });
    assert.deepEqual(events, [ "first", "refused: authPermissionDenied", "last" ]);
});
