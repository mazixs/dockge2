import { expect, test } from "@playwright/test";

/**
 * A toast slides in from far beyond the right edge and leaves the same way.
 *
 * Its container used to carry Bootstrap's `.toast-container` class, which made it
 * absolute, narrow and click-through: every "Saved" put a horizontal scrollbar on the
 * page for as long as the toast was moving, and its close button did nothing.
 */
test("a toast neither widens the page nor lets clicks through", async ({ page }) => {
    await page.goto("/settings/about");

    const beta = page.getByRole("checkbox", { name: "Include beta releases" });
    await expect(beta).toBeEnabled();
    const initial = await beta.isChecked();

    await page.evaluate(() => {
        const probe = window as unknown as { maxOverflow : number; stopProbe : boolean };
        probe.maxOverflow = 0;
        probe.stopProbe = false;
        const tick = () => {
            const root = document.documentElement;
            probe.maxOverflow = Math.max(probe.maxOverflow, root.scrollWidth - root.clientWidth);
            if (!probe.stopProbe) {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    });

    await beta.click();

    const toast = page.locator(".Toastify__toast", { hasText: "Saved" });
    await expect(toast).toBeVisible();
    await expect(page.locator(".Toastify__toast-container")).toHaveCSS("position", "fixed");

    // A real click reaches the toast: Playwright refuses to click through to the page below
    await toast.locator(".Toastify__close-button").click();
    await expect(toast).toHaveCount(0);

    const maxOverflow = await page.evaluate(() => {
        const probe = window as unknown as { maxOverflow : number; stopProbe : boolean };
        probe.stopProbe = true;
        return probe.maxOverflow;
    });
    expect(maxOverflow, "the page grew wider than the window while a toast moved").toBeLessThanOrEqual(0);

    // Leave the setting as the other tests found it
    await beta.setChecked(initial);
    await expect(page.locator(".Toastify__toast", { hasText: "Saved" })).toBeVisible();
});
