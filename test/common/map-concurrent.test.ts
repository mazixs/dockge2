import assert from "node:assert/strict";
import test from "node:test";
import { mapConcurrent } from "../../common/map-concurrent";

test("directory reads have a bounded active count and preserve result order", async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapConcurrent([ 4, 3, 2, 1, 0 ], 2, async (value) => {
        maximum = Math.max(maximum, ++active);
        await new Promise(resolve => setTimeout(resolve, value));
        active--;
        return value * 2;
    });
    assert.equal(maximum, 2);
    assert.deepEqual(result, [ 8, 6, 4, 2, 0 ]);
    assert.deepEqual(await mapConcurrent([], 2, async () => 1), []);
});
