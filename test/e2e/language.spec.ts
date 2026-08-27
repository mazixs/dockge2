import { expect, test } from "@playwright/test";

test.describe("switching the interface language", () => {
    test("the language selector really translates the interface", async ({ page }) => {
        await page.goto("/settings/appearance");

        const selector = page.locator("#language");
        await expect(selector).toBeVisible();

        // English first, so the test does not depend on the browser language
        await selector.selectOption("en");
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

        // The selector offers real language names, not locale codes
        await expect(selector.locator("option", { hasText: "Русский" })).toHaveCount(1);

        await selector.selectOption("ru");

        // The heading is translated, which means the locale switch reached vue-i18n
        await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();
        await expect(selector).toHaveValue("ru");

        // And the choice survives a reload, because it is stored
        await page.reload();
        await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();

        // Back to English for the other tests that share this browser profile
        await page.locator("#language").selectOption("en");
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    });
});
