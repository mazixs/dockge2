import { expect, test } from "@playwright/test";

for (const phase of [ "opening", "open", "closing" ] as const) {
    test(`unmounting a modal while ${phase} releases its element and backdrop`, async ({ page }) => {
        const errors : string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto("/login");
        await expect(page.locator(".auth-screen")).toBeVisible();
        await page.evaluate(async value => {
            const url = "/modal-probe.ts";
            const probe = await import(/* @vite-ignore */ url);
            await probe.unmountModal(value);
        }, phase);
        await expect(page.locator(".modal-backdrop")).toHaveCount(0);
        await expect(page.locator("[data-modal-probe]")).toHaveCount(0);
        await expect(page.locator("body")).not.toHaveClass(/modal-open/);
        expect(errors).toEqual([]);
    });
}
