import assert from "node:assert/strict";
import test from "node:test";
import { ownModal } from "../../frontend/src/modal-lifecycle";

for (const phase of [ "closed", "opening", "open", "closing" ]) {
    test(`modal unmount while ${phase} releases once after hiding`, () => {
        let removals = 0;
        const element = Object.assign(new EventTarget(), { remove: () => {
            removals++;
        } });
        let hides = 0;
        let disposals = 0;
        const emit = (name: string) => element.dispatchEvent(new Event(`${name}.bs.modal`));
        const release = ownModal(element, {
            hide: () => {
                hides++;
                emit("hide");
            },
            dispose: () => {
                disposals++;
            },
        });
        if (phase !== "closed") {
            emit("show");
        }
        if (phase === "open" || phase === "closing") {
            emit("shown");
        }
        if (phase === "closing") {
            emit("hide");
        }
        release();
        release();
        if (phase === "opening") {
            assert.equal(hides, 0);
            assert.equal(disposals, 0);
            emit("shown");
        }
        if (phase !== "closed") {
            assert.equal(disposals, 0, "Bootstrap must finish restoring the body first");
            emit("hidden");
        }
        assert.equal(disposals, 1);
        assert.equal(removals, 1);
        assert.equal(hides, phase === "opening" || phase === "open" ? 1 : 0);
        emit("shown");
        emit("hidden");
        assert.equal(disposals, 1);
    });
}
