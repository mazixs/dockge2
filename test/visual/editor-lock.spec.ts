import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * A stack's files are shown read-only until "Изменить" is pressed.
 *
 * Typing was blocked, but paste, drop and cut went through: CodeMirror gates those on
 * the read-only state, not on whether the element is editable. The changed text then
 * stayed in the editor after unlocking and was saved with the next edit. A pasted
 * compose file also opened "new stack", as if it were pasted into the stack list.
 */

const PASTED = "services:\n  pasted-by-test:\n    image: nginx:alpine\n";

/**
 * Text of one editor, read from CodeMirror's lines rather than the clipboard
 * @param editor The `.cm-content` element
 * @returns Editor text
 */
function editorText(editor : Locator) : Promise<string> {
    return editor.locator(".cm-line").allInnerTexts().then((lines) => lines.join("\n"));
}

/**
 * Drops text onto the first line of an editor, as dragging a selection from elsewhere does
 * @param page Page under test
 * @param editor The `.cm-content` element
 * @param text Dropped text
 */
async function dropText(page : Page, editor : Locator, text : string) : Promise<void> {
    const box = await editor.locator(".cm-line").first().boundingBox();
    expect(box).not.toBeNull();

    await editor.evaluate((node, { x, y, value }) => {
        const data = new DataTransfer();
        data.setData("text/plain", value);
        node.dispatchEvent(new DragEvent("drop", { dataTransfer: data,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true }));
    }, { x: box!.x + 4,
        y: box!.y + box!.height / 2,
        value: text });
}

test.beforeEach(async ({ context }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-light", "Editor behaviour does not depend on theme or width");
    await context.grantPermissions([ "clipboard-read", "clipboard-write" ]);
});

test("a locked file accepts neither paste, nor drop, nor cut", async ({ page }) => {
    await page.goto("/stack/paperless/files");

    // The env file is folded until asked for, so its editor has to be revealed first
    await page.locator(".env-hidden").getByRole("button", { name: "Показать" }).click();

    const editors = page.locator(".cm-content");
    await expect(editors).toHaveCount(2);
    await expect(editors.nth(1)).toBeVisible();
    await page.evaluate((text) => navigator.clipboard.writeText(text), PASTED);

    for (const editor of await editors.all()) {
        const before = await editorText(editor);

        await editor.locator(".cm-line").first().dblclick();
        await page.keyboard.press("ControlOrMeta+V");

        // Still on the stack: the pasted compose file was not taken for a new stack either
        await expect(page).toHaveURL(/\/stack\/paperless\/files$/);
        expect(await editorText(editor), "paste changed a locked file").toEqual(before);

        await page.keyboard.press("ControlOrMeta+X");
        expect(await editorText(editor), "cut changed a locked file").toEqual(before);

        await dropText(page, editor, PASTED);
        expect(await editorText(editor), "drop changed a locked file").toEqual(before);

        // Screen readers are told the same thing the keyboard finds out
        await expect(editor).toHaveAttribute("aria-readonly", "true");
    }
});

test("an unlocked file still takes a paste", async ({ page }) => {
    await page.goto("/stack/paperless/files");

    const compose = page.locator(".cm-content").first();
    await expect(compose).toBeVisible();
    await page.evaluate((text) => navigator.clipboard.writeText(text), "# pasted-by-test");

    await page.getByRole("button", { name: "Изменить" }).first().click();
    await expect(compose).not.toHaveAttribute("aria-readonly", "true");

    await compose.locator(".cm-line").first().click();
    await page.keyboard.press("End");
    await page.keyboard.press("ControlOrMeta+V");

    expect(await editorText(compose)).toContain("# pasted-by-test");
    await expect(page).toHaveURL(/\/stack\/paperless\/files$/);
});

test("pressing Edit opens the env file without a second click on Show", async ({ page }) => {
    await page.goto("/stack/paperless/files");

    const envPanel = page.locator("section.file-card").filter({ has: page.locator(".env-hidden") });
    await expect(envPanel.locator(".env-hidden")).toBeVisible();

    await envPanel.getByRole("button", { name: "Изменить" }).click();

    // Hidden values cannot be edited, so editing shows them at once
    await expect(page.locator(".env-hidden")).toHaveCount(0);
    const env = page.locator(".cm-content").nth(1);
    await expect(env).toBeVisible();
    await expect(env).not.toHaveAttribute("aria-readonly", "true");
});
