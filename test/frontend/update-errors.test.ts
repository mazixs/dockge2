import { strict as assert } from "node:assert";
import test from "node:test";
import { UPDATE_CHECK_MESSAGES } from "../../common/update-check";
import en from "../../frontend/src/lang/en.json" with { type: "json" };
import ru from "../../frontend/src/lang/ru.json" with { type: "json" };
import { componentOptions } from "../helpers/sfc";

/** Evaluate the component's real methods with only its browser imports replaced.
 * @param file Component path relative to this test
 * @param globals Imports the component requires when defining its options
 * @returns Vue options
 */
function component(file : string, globals : Record<string, unknown>) {
    return componentOptions<{ methods : Record<string, (this: Record<string, unknown>) => Promise<void>>; computed : Record<string, (this: Record<string, unknown>) => unknown> }>(new URL(file, import.meta.url), globals);
}

test("manual update checks retain server error categories and distinguish a lost acknowledgement", async () => {
    const about = component("../../frontend/src/components/settings/About.vue", { BrandMark: {},
        InterfaceIcon: {},
        PanelContainerCard: {},
        UPDATE_CHECK_MESSAGES });
    for (const [ code, key ] of Object.entries(UPDATE_CHECK_MESSAGES)) {
        const ctx = { $root: { getSocket: () => ({ timeout: () => ({ emitWithAck: async () => ({ ok: false,
            code }) }) }) } };
        await about.methods.checkNow!.call(ctx);
        assert.equal((ctx as Record<string, unknown>).manualErrorKey, key);
        assert.equal((ctx as Record<string, unknown>).checking, false);
        assert.equal(typeof en[key], "string");
        assert.equal(typeof ru[key], "string");
    }
    const denied = { $root: { getSocket: () => ({ timeout: () => ({ emitWithAck: async () => ({ ok: false,
        msg: "authPermissionDenied" }) }) }) } };
    await about.methods.checkNow!.call(denied);
    assert.equal((denied as Record<string, unknown>).manualErrorKey, "authPermissionDenied");
    const lost = { $root: { getSocket: () => ({ timeout: () => ({ emitWithAck: async () => {
        throw new Error("timeout");
    } }) }) } };
    await about.methods.checkNow!.call(lost);
    assert.equal((lost as Record<string, unknown>).manualErrorKey, "updateCheckConnection");
});

test("parsed log errors cannot override the server acknowledgement or an unknown result", () => {
    const progress = component("../../frontend/src/components/StackProgress.vue", { Terminal: {},
        InterfaceIcon: {} });
    for (const outcome of [ "ok", "unknown", "failed", "" ]) {
        const ctx = { outcome,
            stepFailed: true,
            running: "" };
        assert.equal(progress.computed.failed!.call(ctx), outcome === "failed" || outcome === "");
        assert.equal(progress.computed.resultUnknown!.call(ctx), outcome === "unknown");
        assert.equal(progress.computed.finished!.call(ctx), outcome === "ok");
    }
});
