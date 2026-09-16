import { expect, test } from "@playwright/test";
import { E2E_ADMIN_PASSWORD, E2E_STACK_NAME } from "./constants";

// This flow intentionally handles a one-time credential. Never retain network traces,
// screenshots or video that could capture the issue response or the reveal panel.
test.use({ trace: "off",
    screenshot: "off",
    video: "off" });

test.describe("owner MCP key management", () => {
    test.afterEach(async ({ page }) => {
        // Ensure even an assertion failure cannot leave a credential in an error-context snapshot.
        await page.evaluate(() => {
            document.querySelectorAll(".mcp-secret").forEach(element => {
                element.textContent = "";
            });
        }).catch(() => {});
    });

    test("enable, issue a scoped viewer key, dismiss its only reveal and revoke", async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.locale = "en";
        });
        await page.goto("/settings/mcp");
        // Доступ, ключи и разовый показ секрета - разные панели одного раздела
        const settings = page.locator(".mcp");
        const access = settings.locator("section[aria-labelledby=\"mcp-heading\"]");
        await expect(access.getByRole("heading", { name: "AI access / MCP",
            exact: true })).toBeVisible();
        const password = access.getByLabel("Password", { exact: true });
        await password.fill(E2E_ADMIN_PASSWORD);
        await access.getByLabel("Enable MCP", { exact: true }).check();
        await access.getByLabel("Connection URL", { exact: true }).fill("http://localhost:5001/mcp");
        const [ saved ] = await Promise.all([
            page.waitForResponse(response => response.url().endsWith("/api/mcp/config") && response.request().method() === "POST"),
            access.getByRole("button", { name: "Save",
                exact: true }).click(),
        ]);
        expect(saved.status()).toBe(200);

        await settings.getByRole("button", { name: "Create key",
            exact: true }).click();
        const form = settings.locator("section").filter({ has: page.getByRole("heading", { name: "Create key",
            exact: true }) }).locator("form");
        const keyName = "E2E viewer key";
        await form.getByLabel("Key name", { exact: true }).fill(keyName);
        await expect(form.getByLabel("Role", { exact: true })).toHaveValue("viewer");
        await form.getByLabel(E2E_STACK_NAME, { exact: true }).check();
        await expect(form.locator("input[type=\"checkbox\"]:checked")).toHaveCount(1);

        let validReveal: boolean;
        let issueStatus: number;
        try {
            const [ issued ] = await Promise.all([
                page.waitForResponse(response => response.url().endsWith("/api/mcp/issue") && response.request().method() === "POST"),
                form.getByRole("button", { name: "Create key",
                    exact: true }).click(),
            ]);
            issueStatus = issued.status();
            await settings.locator(".mcp-secret").waitFor({ state: "visible" });
            // Return a boolean only. The key never enters a Node variable or assertion message.
            validReveal = await page.evaluate(() => /^dg_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(document.querySelector(".mcp-secret")?.textContent ?? ""));
        } finally {
            // Scrub the rendered credential before any fallible assertion or diagnostic capture.
            await page.evaluate(() => {
                document.querySelectorAll(".mcp-secret").forEach(element => {
                    element.textContent = "";
                });
            });
            const close = settings.locator(".mcp-secret-box").getByRole("button", { name: "Close",
                exact: true });
            if (await close.count()) {
                await close.click();
            }
        }
        expect(issueStatus).toBe(200);
        expect(validReveal).toBe(true);
        await expect(settings.locator(".mcp-secret")).toHaveCount(0);

        await page.reload();
        await expect(settings.locator(".mcp-secret")).toHaveCount(0);
        const key = settings.locator(".panel-row").filter({ has: page.locator(".row-name", { hasText: keyName }) });
        await expect(key).toBeVisible();
        await expect(key).toContainText(E2E_STACK_NAME);
        await password.fill(E2E_ADMIN_PASSWORD);
        const [ revoked ] = await Promise.all([
            page.waitForResponse(response => response.url().endsWith("/api/mcp/revoke") && response.request().method() === "POST"),
            key.getByRole("button", { name: "Revoke",
                exact: true }).click(),
        ]);
        expect(revoked.status()).toBe(200);
        await expect(key.getByText("Revoked", { exact: true })).toBeVisible();
        await expect(key.getByRole("button", { name: "Revoke",
            exact: true })).toHaveCount(0);
        await expect(settings.locator(".mcp-secret")).toHaveCount(0);

        // Restore the disabled transport for subsequent scenarios in the isolated suite.
        await access.getByLabel("Enable MCP", { exact: true }).uncheck();
        const [ disabled ] = await Promise.all([
            page.waitForResponse(response => response.url().endsWith("/api/mcp/config") && response.request().method() === "POST"),
            access.getByRole("button", { name: "Save",
                exact: true }).click(),
        ]);
        expect(disabled.status()).toBe(200);
    });
});
