import { expect, test, type Page } from "@playwright/test";
import { E2E_STACK_NAME } from "./constants";

const SERVICE = "shellbox";

/**
 * Open the interactive container terminal of one shell
 * @param page Playwright page
 * @param shell Shell to open
 */
async function openTerminal(page : Page, shell : string) : Promise<void> {
    await page.goto(`/terminal/${E2E_STACK_NAME}/${SERVICE}/${shell}`);
    await expect(page.locator(".xterm-screen")).toBeVisible();
    await page.waitForTimeout(1500);
}

/**
 * Read the visible terminal text
 * @param page Playwright page
 * @returns Text of the terminal rows
 */
async function terminalText(page : Page) : Promise<string> {
    return page.locator(".xterm-rows").innerText();
}

test.describe("switching the container shell", () => {
    test("each shell gets its own session instead of reusing the other PTY", async ({ page }) => {
        await openTerminal(page, "bash");

        // Leave a marker in the bash session
        await page.locator(".xterm-screen").click();
        await page.keyboard.type("echo bash-session-marker");
        await page.keyboard.press("Enter");

        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toMatch(/bash-session-marker[\s\S]*bash-session-marker/);

        // Switch to the other shell, which is a different session
        await page.getByRole("link", { name: /Switch to sh/ }).click();
        await expect(page).toHaveURL(new RegExp(`/terminal/${E2E_STACK_NAME}/${SERVICE}/sh$`));
        await expect(page.locator(".xterm-screen")).toBeVisible();
        await page.waitForTimeout(1500);

        // The new session starts clean, the marker of the bash session is not there
        expect(await terminalText(page)).not.toContain("bash-session-marker");

        // The button now offers the way back
        await expect(page.getByRole("link", { name: /Switch to bash/ })).toBeVisible();

        // And the sh session is usable on its own
        await page.locator(".xterm-screen").click();
        await page.keyboard.type("echo sh-session-marker");
        await page.keyboard.press("Enter");

        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toMatch(/sh-session-marker[\s\S]*sh-session-marker/);
    });

    test("an unknown shell in the URL falls back to sh instead of reaching Docker", async ({ page }) => {
        await openTerminal(page, "zsh");

        // The badge shows the shell that is really used
        await expect(page.locator(".badge", { hasText: "sh" })).toBeVisible();
        await expect(page.getByRole("link", { name: /Switch to bash/ })).toBeVisible();

        await page.locator(".xterm-screen").click();
        await page.keyboard.type("echo fallback-works");
        await page.keyboard.press("Enter");

        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toMatch(/fallback-works[\s\S]*fallback-works/);
    });
});
