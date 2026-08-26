import { expect, test, type Page } from "@playwright/test";
import { E2E_STACK_NAME } from "./constants";

const SERVICE = "shellbox";

/** Text with the characters a naive paste implementation loses */
const TRICKY_TEXT = "echo \"a  b\" $HOME \\ 'q' ok";

/**
 * Open the interactive container terminal and wait until the shell prompt is there
 * @param page Playwright page
 * @param shell Shell to open
 */
async function openTerminal(page : Page, shell : "sh" | "bash") : Promise<void> {
    await page.goto(`/terminal/${E2E_STACK_NAME}/${SERVICE}/${shell}`);
    await expect(page.locator(".xterm-screen")).toBeVisible();

    // The PTY needs a moment before it echoes anything back
    await page.waitForTimeout(1500);
}

/**
 * Read the visible terminal text
 * @param page Playwright page
 * @returns Text of the terminal rows
 */
async function terminalText(page : Page) : Promise<string> {
    return (await page.locator(".xterm-rows").innerText()).replace(/\u00a0/g, " ");
}

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

        // The pasted line is echoed by the shell, and nothing ran yet
        await expect.poll(() => terminalText(page), { timeout: 15_000 })
            .toContain(TRICKY_TEXT);

        const before = await terminalText(page);
        expect(before).not.toContain("command not found");
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
