import { expect, test, type Page } from "@playwright/test";
import { openTerminal, terminalText } from "./terminal";

/** Text with the characters a naive paste implementation loses */
const TRICKY_TEXT = "echo \"a  b\" $HOME \\ 'q' ok";

/**
 * Put a value into the real clipboard of the browser
 * @param page Playwright page
 * @param text Value to copy
 */
async function writeClipboard(page : Page, text : string) : Promise<void> {
    await page.evaluate(async (value) => {
        await navigator.clipboard.writeText(value);
    }, text);
}

test.describe("pasting into the container terminal", () => {
    test("Ctrl+V pastes the exact text without executing it", async ({ page }) => {
        await openTerminal(page, "bash");
        await writeClipboard(page, TRICKY_TEXT);

        await page.locator(".xterm-screen").click();
        await page.keyboard.press("Control+V");

        // The pasted line is echoed by the shell; that it does not run is the last test
        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toContain(TRICKY_TEXT);
    });

    test("Ctrl+Shift+V pastes once, not twice", async ({ page }) => {
        await openTerminal(page, "bash");
        await writeClipboard(page, "unique-marker-42");

        await page.locator(".xterm-screen").click();
        await page.keyboard.press("Control+Shift+V");

        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toContain("unique-marker-42");

        const text = await terminalText(page);
        const occurrences = text.split("unique-marker-42").length - 1;
        expect(occurrences).toBe(1);
    });

    test("the right click menu pastes through the clipboard API", async ({ page }) => {
        await openTerminal(page, "bash");
        await writeClipboard(page, "menu-paste-7");

        await page.locator(".xterm-screen").click({ button: "right" });
        await expect(page.getByRole("menuitem", { name: "Paste" })).toBeVisible();
        await page.getByRole("menuitem", { name: "Paste" }).click();

        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toContain("menu-paste-7");

        // The menu closes after a successful paste
        await expect(page.getByRole("menuitem", { name: "Paste" })).toBeHidden();
    });

    test("a pasted command only runs after Enter", async ({ page }) => {
        await openTerminal(page, "bash");
        await writeClipboard(page, "echo paste-then-enter");

        await page.locator(".xterm-screen").click();
        await page.keyboard.press("Control+V");

        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toContain("echo paste-then-enter");

        // Still only the echoed input, no output line yet
        expect((await terminalText(page)).split("paste-then-enter").length - 1).toBe(1);

        await page.keyboard.press("Enter");

        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toMatch(/paste-then-enter[\s\S]*paste-then-enter/);
    });
});
