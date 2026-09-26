import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Every state the overview and the list can be in is named in words.
 *
 * Colour only supports a label, so each cell of the matrix is checked by its text rather
 * than by a screenshot: a state that lost its words would still pass a snapshot of a
 * frame nobody approved. The cells come from `?matrix=` of the scene, which changes only
 * what the fixture answers; the components are the production ones.
 */

/** The scene speaks Russian; a JSON import would need an attribute Playwright's loader insists on */
const catalogue = JSON.parse(readFileSync(new URL("../../frontend/src/lang/ru.json", import.meta.url), "utf8")) as Record<string, unknown>;

/**
 * Text of a catalogue entry
 * @param key Catalogue key
 * @returns The Russian text
 */
function ru(key : string) : string {
    const text = catalogue[key];
    if (typeof text !== "string") {
        throw new Error(`No catalogue entry ${key}`);
    }
    return text;
}

test.beforeEach(async ({ context }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "The words of a state do not depend on theme; widths are set per test");
    await context.clearCookies();
});

/**
 * The page never scrolls sideways
 * @param page Page under test
 * @returns Whether the document fits the window width
 */
function fitsWidth(page : Page) : Promise<boolean> {
    return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

test("loading: the overview says it is reading", async ({ page }) => {
    await page.goto("/?matrix=loading");
    await expect(page.locator(".stability-dashboard .host-message[role=status]")).toHaveText(ru("stabilityLoading"));
});

test("empty: the list and the overview say there is nothing yet", async ({ page }) => {
    await page.goto("/?matrix=empty");
    await expect(page.locator(".list-box")).toContainText(ru("emptyStacksTitle"));
    await expect(page.locator(".stability-dashboard")).toContainText(ru("stabilityEmpty"));
});

test("stale: current figures are unknown, not the last good ones", async ({ page }) => {
    await page.goto("/?matrix=stale");
    const dashboard = page.locator(".stability-dashboard");
    await expect(dashboard.locator(".panel-bar")).toContainText(ru("stabilityNoFreshData"));
    await expect(dashboard.locator("tr.managed-container").first()).toContainText(ru("stabilityContainerState_unknown"));
    await expect(dashboard.locator("tr.managed-container .uptime-cell").first()).toHaveText(ru("stabilityNotAvailable"));
});

test("Docker unavailable: the overview says so and offers a retry, the list says unknown", async ({ page }) => {
    await page.goto("/?matrix=docker-down");
    const message = page.locator(".stability-dashboard .host-message[role=status]");
    await expect(message).toContainText(ru("stabilityDockerError"));
    await expect(message.getByRole("button", { name: ru("stabilityRetry") })).toBeVisible();
    await expect(page.locator(".list-box a.item", { hasText: "paperless" })).toContainText(ru("pagesUnknown"));
    // Unknown is not stopped: no stack of the list may claim a state Docker did not report
    await expect(page.locator(".list-box a.item", { hasText: ru("pagesStopped") })).toHaveCount(0);
});

test("attention: the strip names the stack and the list marks it in words", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".attention-strip")).toContainText("immich");
    await expect(page.locator(".list-box a.item", { hasText: "immich" })).toContainText(ru("pagesAttention"));
});

test("no history: availability is being collected, not a percentage", async ({ page }) => {
    await page.goto("/?matrix=no-history");
    await expect(page.locator(".stability-dashboard .availability-value").first()).toContainText(ru("stabilityLearning"));
});

test("viewer: the stack page says it is read only and offers no action", async ({ page }) => {
    await page.goto("/stack/paperless?matrix=viewer");
    const inspector = page.locator(".inspector");
    await expect(inspector).toContainText(ru("familiarViewOnly"));
    await expect(inspector.getByRole("link", { name: ru("familiarFiles") })).toHaveCount(0);
    await expect(inspector.locator(".actions")).toHaveCount(0);
});

test("1440x1000: the first five stacks of hundreds are on the first screen", async ({ page }) => {
    await page.setViewportSize({ width: 1440,
        height: 1000 });
    await page.goto("/?matrix=many");
    const items = page.locator(".list-box a.item");
    await expect(items.nth(4)).toBeVisible();
    const fifth = await items.nth(4).boundingBox();
    expect(fifth).not.toBeNull();
    expect(fifth!.y + fifth!.height).toBeLessThanOrEqual(1000);
    expect(await fitsWidth(page)).toBe(true);
});

test("390x844: the create form shows its heading and first field without scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 390,
        height: 844 });
    await page.goto("/new");
    const heading = page.locator(".create-page h1");
    const field = page.locator(".create-page").locator("input, textarea, select").first();
    await expect(heading).toBeVisible();
    await expect(field).toBeVisible();
    for (const box of [ await heading.boundingBox(), await field.boundingBox() ]) {
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    }
    expect(await fitsWidth(page)).toBe(true);
});

const LONG_NAME = "nextcloud-production-with-collabora-and-imaginary-previews-2026";

test("long names: the list column shortens one and keeps the full text in a title", async ({ page }) => {
    await page.setViewportSize({ width: 1440,
        height: 1000 });
    await page.goto("/?matrix=long-names");
    const row = page.locator(".list-box a.item .name", { hasText: LONG_NAME });
    await expect(row).toBeVisible();
    expect(await row.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await row.hover();
    await expect(row).toHaveAttribute("title", LONG_NAME);
    expect(await fitsWidth(page)).toBe(true);
});

test("200% zoom: the list and a stack with a long name never scroll sideways", async ({ page }) => {
    // 1440x1000 at 200% leaves 720x500 CSS pixels
    await page.setViewportSize({ width: 720,
        height: 500 });

    await page.goto("/?matrix=long-names");
    // At this width the list folds under a button above the work area
    await page.getByRole("button", { name: new RegExp(`^${ru("stacksTab")}`) }).click();
    await expect(page.locator(".list-box a.item .name", { hasText: LONG_NAME })).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);

    await page.goto(`/stack/${LONG_NAME}?matrix=long-names`);
    await expect(page.locator(".inspector h1")).toContainText(LONG_NAME);
    expect(await fitsWidth(page)).toBe(true);
});
