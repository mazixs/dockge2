import assert from "node:assert/strict";
import test from "node:test";
import { BoundedCache } from "../../backend/bounded-cache";

test("cache evicts by payload bytes and usage, rejects oversized values", () => {
    const cache = new BoundedCache<object>(10, 3, 1000);
    cache.set("a", {}, 4);
    cache.set("b", {}, 4);
    cache.get("a");
    cache.set("c", {}, 4);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.bytes, 8);
    assert.equal(cache.set("large", {}, 11), false);
    assert.equal(cache.size, 2);
    cache.clear();
    assert.equal(cache.bytes, 0);
});

test("expiry releases idle entries without another read or write", (t) => {
    t.mock.timers.enable({ apis: [ "setTimeout", "Date" ],
        now: 1000 });
    const cache = new BoundedCache<object>(100, 2, 500);
    cache.set("a", {}, 10);
    t.mock.timers.tick(300);
    cache.set("b", {}, 20);
    t.mock.timers.tick(200);
    assert.equal(cache.size, 1);
    assert.equal(cache.bytes, 20);
    t.mock.timers.tick(300);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
});
