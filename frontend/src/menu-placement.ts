/**
 * Where a menu that floats above the page has to sit.
 *
 * A menu placed straight under its button is off the screen whenever the button is near
 * the bottom edge, and a menu that floats cannot be reached by scrolling the page: the
 * page moves out from under it and it closes. So the placement is decided from the space
 * that is actually there - below the button, above it, or, when neither side fits, the
 * larger side with the menu scrolling inside itself.
 */

/** Rectangle of the element the menu belongs to, in viewport coordinates */
export interface MenuAnchor {
    top : number;
    bottom : number;
    right : number;
}

/** Size of the window the menu has to stay inside */
export interface MenuViewport {
    width : number;
    height : number;
}

export interface MenuPlacementInput {
    /** Button the menu hangs from */
    anchor : MenuAnchor;
    /** Width of the menu, which is fixed by the stylesheet */
    width : number;
    /** Height the menu wants, measured after it was opened */
    height : number;
    /** Window the menu has to stay inside */
    viewport : MenuViewport;
    /** Distance kept from the window edges */
    margin? : number;
    /** Distance between the button and the menu */
    gap? : number;
}

export interface MenuPlacement {
    /** Distance from the top of the window */
    top : number;
    /** Distance from the left of the window */
    left : number;
    /** Height the menu may take, when it has to scroll inside itself */
    maxHeight : number | null;
    /** Which side of the button the menu ended up on */
    side : "below" | "above";
}

/**
 * Decide where a floating menu goes.
 * @param input Anchor, menu size and window
 * @returns Coordinates, and a height limit when the menu has to scroll
 */
export function placeMenu(input : MenuPlacementInput) : MenuPlacement {
    const margin = input.margin ?? 8;
    const gap = input.gap ?? 4;

    const left = Math.max(margin, Math.min(input.anchor.right - input.width, input.viewport.width - input.width - margin));

    const below = input.viewport.height - input.anchor.bottom - gap - margin;
    const above = input.anchor.top - gap - margin;

    if (input.height <= below) {
        return { top: input.anchor.bottom + gap,
            left,
            maxHeight: null,
            side: "below" };
    }

    if (input.height <= above) {
        return { top: input.anchor.top - gap - input.height,
            left,
            maxHeight: null,
            side: "above" };
    }

    // Neither side holds the whole menu: the larger one gets it, and the menu scrolls
    // inside itself rather than putting its last actions outside the window
    if (below >= above) {
        return { top: input.anchor.bottom + gap,
            left,
            maxHeight: Math.max(below, 0),
            side: "below" };
    }

    return { top: margin,
        left,
        maxHeight: Math.max(above, 0),
        side: "above" };
}
