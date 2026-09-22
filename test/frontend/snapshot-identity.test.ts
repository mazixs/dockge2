import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSnapshot } from "../../frontend/src/snapshot-identity";
import { TerminalBindings } from "../../frontend/src/terminal-bindings";

test("authoritative snapshots retain equal rows and remove revoked fields", () => {
    const old = { a: { status: 1,
        services: [{ name: "web" }],
        source: "private" },
    b: { status: 2 } };
    assert.equal(reconcileSnapshot(old, structuredClone(old)), old);
    const fresh = reconcileSnapshot<Record<string, unknown>>(old, { a: { status: 3,
        services: [{ name: "web" }] },
    b: { status: 2 } });
    assert.equal(fresh.b, old.b);
    assert.notEqual(fresh.a, old.a);
    assert.deepEqual(fresh.a, { status: 3,
        services: [{ name: "web" }] });
    assert.deepEqual(reconcileSnapshot<Record<string, unknown>>(old, {}), {});
    assert.deepEqual(reconcileSnapshot([ 1, 2 ], [ 2, 1 ]), [ 2, 1 ]);
});

test("late terminal acknowledgements cannot resurrect released or replaced renderers", () => {
    const bindings = new TerminalBindings<object>();
    const first = bindings.begin("logs");
    bindings.delete("logs");
    assert.equal(bindings.accept("logs", first, {}), false);
    const second = bindings.begin("logs");
    const third = bindings.begin("logs");
    assert.equal(bindings.accept("logs", second, {}), false);
    const terminal = {};
    assert.equal(bindings.accept("logs", third, terminal), true);
    assert.equal(bindings.get("logs"), terminal);
    const pending = bindings.begin("other");
    bindings.clear();
    assert.equal(bindings.get("logs"), undefined);
    assert.equal(bindings.accept("other", pending, {}), false);
    const failed = bindings.begin("failed");
    assert.equal(bindings.reject("failed", failed), true);
    assert.equal(bindings.accept("failed", failed, {}), false);
    assert.equal(bindings.reject("other", pending), false);
});
