import { strict as assert } from "node:assert";
import { getEventListeners } from "node:events";
import test from "node:test";
import { FakeMediaQuery, installGlobal, mountOptions } from "../helpers/vue-instance";

const narrow = new FakeMediaQuery("(max-width: 800px)");
const queries : string[] = [];
installGlobal("window", () => ({
    matchMedia(query : string) {
        queries.push(query);
        return narrow;
    },
}));

const { default: responsive } = await import("../../frontend/src/mixins/responsive");

type Responsive = InstanceType<typeof responsive>;

/**
 * A page opened on a screen of the given width
 * @param isNarrow Whether the screen is at most 800 pixels wide
 * @returns The mounted mixin
 */
function openPage(isNarrow : boolean) {
    narrow.matches = isNarrow;
    return mountOptions<Responsive>({ mixins: [ responsive ] });
}

test("one media query decides the narrow layout for every instance", () => {
    assert.deepEqual(queries, [ "(max-width: 800px)" ]);
});

test("the narrow flag starts from the screen the page opens on", () => {
    const phone = openPage(true);
    const desktop = openPage(false);
    assert.equal(phone.vm.isMobile, true);
    assert.equal(desktop.vm.isMobile, false);
    phone.unmount();
    desktop.unmount();
});

test("a rotation or a resize across the breakpoint switches the layout both ways", () => {
    const { vm, errors, unmount } = openPage(false);

    narrow.change(true);
    assert.equal(vm.isMobile, true);
    narrow.change(false);
    assert.equal(vm.isMobile, false);

    assert.deepEqual(errors, []);
    unmount();
});

test("unmounting removes exactly the listener it added", () => {
    const first = openPage(false);
    const second = openPage(false);
    assert.equal(getEventListeners(narrow, "change").length, 2);

    first.unmount();
    assert.equal(getEventListeners(narrow, "change").length, 1);

    // The instance still on screen keeps following the screen, the removed one does not
    narrow.change(true);
    assert.equal(first.vm.isMobile, false);
    assert.equal(second.vm.isMobile, true);

    second.unmount();
    assert.equal(getEventListeners(narrow, "change").length, 0);
});
