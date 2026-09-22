import assert from "node:assert/strict";
import test from "node:test";
import { VisibleTask } from "../../frontend/src/visible-task";

test("hidden pages pause periodic work and resume once without a catch-up burst", (t) => {
    t.mock.timers.enable({ apis: [ "setTimeout" ] });
    const source = Object.assign(new EventTarget(), { hidden: false });
    let calls = 0;
    const task = new VisibleTask(source, 5000, () => calls++);
    task.start();
    task.start();
    assert.equal(calls, 1);
    t.mock.timers.tick(5000);
    assert.equal(calls, 2);
    source.hidden = true;
    source.dispatchEvent(new Event("visibilitychange"));
    t.mock.timers.tick(600_000);
    assert.equal(calls, 2);
    source.hidden = false;
    source.dispatchEvent(new Event("visibilitychange"));
    assert.equal(calls, 3);
    task.stop();
    t.mock.timers.tick(600_000);
    source.dispatchEvent(new Event("visibilitychange"));
    assert.equal(calls, 3);
});
