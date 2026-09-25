import { expect, type Page } from "@playwright/test";
import { E2E_STACK_NAME } from "./constants";

/** The service of the seeded stack that has both bash and sh */
export const SHELL_SERVICE = "shellbox";

/**
 * Read the visible terminal text
 * @param page Playwright page
 * @returns Text of the terminal rows
 */
export async function terminalText(page : Page) : Promise<string> {
    return (await page.locator(".xterm-rows").innerText()).replace(/\u00a0/g, " ");
}

/**
 * Wait until the last line of the terminal is a shell prompt with nothing typed after it.
 * Keys sent before the PTY answers are lost, so a fixed pause would only be a guess.
 * @param page Playwright page
 */
export async function waitForPrompt(page : Page) : Promise<void> {
    await expect.poll(async () => (await terminalText(page)).trimEnd().split("\n").at(-1) ?? "", { timeout: 15_000 })
        .toMatch(/[#$]$/);
}

/**
 * Open the interactive container terminal on a clean screen.
 *
 * A closed page never sends terminalLeave, so a session outlives its test and replays what
 * the previous one left. Ctrl+U drops a half typed line and Ctrl+L clears the screen, so
 * every test reads only its own output.
 * @param page Playwright page
 * @param shell Shell in the URL
 */
export async function openTerminal(page : Page, shell : string) : Promise<void> {
    await page.goto(`/terminal/${E2E_STACK_NAME}/${SHELL_SERVICE}/${shell}`);
    await expect(page.locator(".xterm-screen")).toBeVisible();

    // The prompt, possibly with text a previous test left after it
    await expect.poll(() => terminalText(page), { timeout: 15_000 }).toMatch(/[#$]/);

    await page.locator(".xterm-screen").click();
    await page.keyboard.press("Control+U");
    await page.keyboard.press("Control+L");
    await waitForPrompt(page);
}
