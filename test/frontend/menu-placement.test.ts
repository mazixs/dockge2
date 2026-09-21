import { strict as assert } from "node:assert";
import test from "node:test";
import { placeMenu } from "../../frontend/src/menu-placement";

/** A phone-sized window, which is where the menu ran out of room */
const phone = { width: 390,
    height: 640 };

test("a menu that fits below the button hangs under it", () => {
    const placement = placeMenu({ anchor: { top: 200,
        bottom: 232,
        right: 370 },
    width: 190,
    height: 98,
    viewport: phone });

    assert.equal(placement.side, "below");
    assert.equal(placement.top, 236);
    assert.equal(placement.maxHeight, null);

    // The right edge of the menu meets the right edge of the button
    assert.equal(placement.left, 180);
});

test("a button near the bottom edge gets its menu above it", () => {
    // The row the review measured: the button ends at 597,5 in a 640 high window, and
    // the menu used to run from 601,5 to 699,5 - sixty pixels of it outside the window,
    // unreachable because a floating menu closes when the page scrolls
    const placement = placeMenu({ anchor: { top: 565,
        bottom: 597,
        right: 370 },
    width: 190,
    height: 98,
    viewport: phone });

    assert.equal(placement.side, "above");
    assert.equal(placement.top, 463);
    assert.equal(placement.top + 98 <= 597, true, "the menu overlaps its own button");
    assert.equal(placement.maxHeight, null);
});

test("a menu taller than the window scrolls inside itself on the roomier side", () => {
    // Long menus exist: a service with every action available, or a browser zoomed in
    const below = placeMenu({ anchor: { top: 60,
        bottom: 92,
        right: 370 },
    width: 190,
    height: 900,
    viewport: phone });

    assert.equal(below.side, "below");
    assert.equal(below.top, 96);
    assert.equal(below.maxHeight, 536);
    assert.equal(below.top + (below.maxHeight ?? 0) <= phone.height, true);

    const above = placeMenu({ anchor: { top: 560,
        bottom: 592,
        right: 370 },
    width: 190,
    height: 900,
    viewport: phone });

    assert.equal(above.side, "above");
    assert.equal(above.top, 8);
    assert.equal(above.maxHeight, 548);
    assert.equal(above.top + (above.maxHeight ?? 0) <= 560, true, "the menu covers its own button");
});

test("the menu stays inside the side edges of the window", () => {
    // A button close to the left edge would pull the menu off the screen
    const left = placeMenu({ anchor: { top: 100,
        bottom: 132,
        right: 40 },
    width: 190,
    height: 98,
    viewport: phone });

    assert.equal(left.left, 8);

    // And one at the right edge would push it past the other side
    const right = placeMenu({ anchor: { top: 100,
        bottom: 132,
        right: 390 },
    width: 190,
    height: 98,
    viewport: phone });

    assert.equal(right.left, 192);
    assert.equal(right.left + 190 <= phone.width, true);
});
