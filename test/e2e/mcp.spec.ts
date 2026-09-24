import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_ADMIN_PASSWORD, E2E_STACK_NAME } from "./constants";

// This flow intentionally handles a one-time credential. Never retain network traces,
// screenshots or video that could capture the issue response or the reveal panel.
test.use({ trace: "off",
    screenshot: "off",
    video: "off" });

const ENDPOINT = "http://localhost:5001/mcp";

/**
 * Click a button and wait for the owner action it sends
 * @param page Page under test
 * @param action Action name after /api/mcp/
 * @param button Button that sends it
 * @returns HTTP status of the action
 */
async function send(page : Page, action : string, button : Locator) : Promise<number> {
    const [ answer ] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith(`/api/mcp/${action}`) && response.request().method() === "POST"),
        button.click(),
    ]);
    return answer.status();
}

test.describe("owner MCP key management", () => {
    test.afterEach(async ({ page }) => {
        // Ensure even an assertion failure cannot leave a credential in an error-context snapshot.
        await page.evaluate(() => {
            document.querySelectorAll(".mcp-secret").forEach(element => {
                element.textContent = "";
            });
        }).catch(() => {});
    });

    test("enable, issue a scoped viewer key, see refusals in the log, reserve a name and revoke", async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.locale = "en";
        });
        await page.goto("/settings/mcp");
        const settings = page.locator(".mcp");
        const access = settings.locator("section[aria-labelledby=\"mcp-heading\"]");
        await expect(access.getByRole("heading", { name: "AI access / MCP",
            exact: true })).toBeVisible();
        await expect(access.locator(".state-chip")).toHaveText("Disabled");
        const connect = settings.locator("section[aria-labelledby=\"mcp-connect-heading\"]");
        await expect(connect).toContainText("MCP is disabled");

        // The address comes from the page, so the owner does not have to guess it
        const url = access.getByLabel("Connection URL", { exact: true });
        await expect(url).toHaveValue(ENDPOINT);
        await url.fill("http://203.0.113.10:5001/mcp");
        await expect(access.getByLabel("Allow plain HTTP on this address", { exact: true })).toBeVisible();
        await expect(access).toContainText("This host differs from the one this page is open on");
        await url.fill(ENDPOINT);
        await expect(access.getByLabel("Allow plain HTTP on this address", { exact: true })).toHaveCount(0);

        const password = access.getByLabel("Password", { exact: true });
        const save = access.getByRole("button", { name: "Save",
            exact: true });
        await access.getByLabel("Enable MCP", { exact: true }).check();
        await password.fill("not-the-password");
        expect(await send(page, "config", save)).toBe(403);
        await expect(access.getByRole("alert")).toHaveText("Wrong password.");
        await expect(access.locator(".state-chip")).toHaveText("Disabled");

        await password.fill(E2E_ADMIN_PASSWORD);
        expect(await send(page, "config", save)).toBe(200);
        await expect(access.getByRole("status").filter({ hasText: "Saved." })).toHaveText(`Saved. MCP is enabled at ${ENDPOINT}.`);
        await expect(access.locator(".state-chip")).toHaveText("Enabled");
        await expect(access).toContainText("HTTP, reachable from this machine only");

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
            issueStatus = await send(page, "issue", form.getByRole("button", { name: "Create key",
                exact: true }));
            await settings.locator(".mcp-secret").waitFor({ state: "visible" });
            // Return a boolean only. The key never enters a Node variable or assertion message.
            validReveal = await page.evaluate(() => /^dg2_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(document.querySelector(".mcp-secret")?.textContent ?? ""));
            await expect(settings.locator(".mcp-secret-box")).toContainText("DOCKGE_MCP_KEY");
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

        // Client configurations read the key from the environment and never contain it
        const client = connect.getByLabel("Client", { exact: true });
        await client.selectOption({ label: "Codex CLI" });
        await expect(connect.locator("pre")).toHaveText(`[mcp_servers.dockge2]\nurl = "${ENDPOINT}"\nbearer_token_env_var = "DOCKGE_MCP_KEY"`);
        await client.selectOption({ label: "Connection check with curl" });
        await expect(connect.locator("pre")).toContainText("\"method\":\"server/discover\"");
        await expect(connect.locator("pre")).toContainText("MCP-Protocol-Version: 2026-07-28");

        // A request without a key is refused and recorded with its reason, never with a secret
        const refused = await fetch(ENDPOINT, { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}" });
        expect(refused.status).toBe(401);
        const audit = settings.locator("section[aria-labelledby=\"mcp-audit-heading\"]");
        await audit.getByRole("button", { name: "Refresh",
            exact: true }).click();
        const refusal = audit.locator(".audit-row").filter({ hasText: "No key: the request had no Authorization: Bearer header." });
        await expect(refusal.first()).toContainText("Refused");
        await expect(audit.locator(".audit-row").filter({ hasText: "Key issued" })).toHaveCount(1);
        await expect(access).toContainText("No key: the request had no Authorization: Bearer header.");

        // A reserved name is explained, listed and removable before any clone uses it
        const reservations = settings.locator("section[aria-labelledby=\"mcp-reservations-heading\"]");
        await reservations.getByLabel("Future stack name", { exact: true }).fill("e2e-future");
        expect(await send(page, "reserve", reservations.getByRole("button", { name: "Reserve name",
            exact: true }))).toBe(200);
        const reserved = reservations.locator(".panel-row").filter({ hasText: "e2e-future" });
        await expect(reserved).toContainText("Not granted to any key yet");
        await reservations.getByLabel("Future stack name", { exact: true }).fill("e2e-future");
        expect(await send(page, "reserve", reservations.getByRole("button", { name: "Reserve name",
            exact: true }))).toBe(400);
        await expect(reservations.getByRole("alert")).toHaveText("This name is already reserved.");
        expect(await send(page, "unreserve", reserved.getByRole("button", { name: "Remove",
            exact: true }))).toBe(200);
        await expect(reservations.locator(".panel-row").filter({ hasText: "e2e-future" })).toHaveCount(0);
        await expect(reservations).toContainText("No names are reserved.");

        await page.reload();
        await expect(settings.locator(".mcp-secret")).toHaveCount(0);
        const key = settings.locator(".panel-row").filter({ has: page.locator(".row-name", { hasText: keyName }) });
        await expect(key).toBeVisible();
        await expect(key).toContainText(E2E_STACK_NAME);
        await password.fill(E2E_ADMIN_PASSWORD);
        expect(await send(page, "revoke", key.getByRole("button", { name: "Revoke",
            exact: true }))).toBe(200);
        await expect(key.getByText("Revoked", { exact: true })).toBeVisible();
        await expect(key.getByRole("button", { name: "Revoke",
            exact: true })).toHaveCount(0);
        await expect(settings.locator(".mcp-secret")).toHaveCount(0);

        // Restore the disabled transport for subsequent scenarios in the isolated suite.
        await access.getByLabel("Enable MCP", { exact: true }).uncheck();
        expect(await send(page, "config", save)).toBe(200);
        await expect(access.getByRole("status").filter({ hasText: "Saved." })).toHaveText("Saved. MCP is disabled.");
        await expect(access.locator(".state-chip")).toHaveText("Disabled");
    });
});
