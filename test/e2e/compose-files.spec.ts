import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_ADMIN_PASSWORD, E2E_FILES_STACK } from "./constants";

const stacksDir = process.env.DOCKGE_E2E_STACKS_DIR ?? "/tmp/dockge-e2e/stacks";
const stackDir = path.join(stacksDir, E2E_FILES_STACK);

test.describe("choosing stack files and handling secrets", () => {
    test("the compose file and the env order are stored and used", async ({ page }) => {
        await page.goto(`/compose/${E2E_FILES_STACK}`);

        // Several compose files in the directory means the UI has to ask
        await expect(page.getByText("This directory holds several compose files")).toBeVisible();

        await page.selectOption("#compose-file-select", "staging.yml");
        await page.locator("#env-file-\\.env").check();
        await page.locator("#env-file-\\.env\\.dev").check();
        await page.selectOption("#active-env-select", ".env.dev");
        await page.getByRole("button", { name: "Save file selection" }).click();

        // The question is gone and the selection survives a reload
        await page.reload();
        await expect(page.locator("#compose-file-select")).toHaveValue("staging.yml");
        await expect(page.locator("#active-env-select")).toHaveValue(".env.dev");
        await expect(page.getByText("This directory holds several compose files")).toBeHidden();

        // Neither compose file was rewritten by the selection
        expect(await readFile(path.join(stackDir, "compose.yaml"), "utf8")).toContain("# default file");
        expect(await readFile(path.join(stackDir, "compose.yaml"), "utf8")).toContain("mode: 01777");
        expect(await readFile(path.join(stackDir, "staging.yml"), "utf8")).toContain("# staging file");
    });

    test("a secret stays masked until the password is given", async ({ page }) => {
        await page.goto(`/compose/${E2E_FILES_STACK}`);

        const secretRow = page.locator(".secret", { hasText: ".secret.db" });
        await expect(secretRow).toBeVisible();

        // Metadata is shown, the value is not
        await expect(secretRow).toContainText("not bound");
        const maskedValue = secretRow.locator("input.secret-value");
        await expect(maskedValue).toHaveAttribute("type", "password");
        expect(await maskedValue.inputValue()).not.toContain("seeded-secret-value");

        // A wrong password keeps the secret hidden
        await secretRow.getByRole("button", { name: "Reveal" }).click();
        await page.getByLabel("Confirm with your password").locator("input[type=password]")
            .or(page.locator(".modal input[type=password]"))
            .fill("wrong-password");
        await page.locator(".modal").getByRole("button", { name: "Confirm" }).click();

        await expect(page.getByText("Incorrect current password")).toBeVisible();
        await expect(secretRow.locator("input.secret-value")).toHaveAttribute("type", "password");

        // The right password reveals it
        await secretRow.getByRole("button", { name: "Reveal" }).click();
        await page.locator(".modal input[type=password]").fill(E2E_ADMIN_PASSWORD);
        await page.locator(".modal").getByRole("button", { name: "Confirm" }).click();

        await expect(secretRow.locator("input.secret-value")).toHaveValue(/seeded-secret-value/);
    });

    test("binding a secret edits only the selected compose file", async ({ page }) => {
        await page.goto(`/compose/${E2E_FILES_STACK}`);

        const secretRow = page.locator(".secret", { hasText: ".secret.db" });
        await secretRow.locator("input.secret-name").fill("db_password");
        await secretRow.locator("select.secret-services").selectOption("app");
        await secretRow.getByRole("button", { name: "Bind" }).click();

        await expect(secretRow).toContainText("db_password");

        // The selected file got the reference, the other file did not
        const staging = await readFile(path.join(stackDir, "staging.yml"), "utf8");
        expect(staging).toContain("db_password");
        expect(staging).toContain("file: ./.secret.db");
        expect(staging).toContain("# staging file");
        expect(staging).not.toContain("seeded-secret-value");

        const defaultFile = await readFile(path.join(stackDir, "compose.yaml"), "utf8");
        expect(defaultFile).not.toContain("db_password");
    });
});
