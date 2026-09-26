import { expect, test } from "@playwright/test";
import { spawn } from "../../backend/child-process";
import { E2E_ADMIN_PASSWORD, E2E_STANDALONE_CONTAINER } from "./constants";

/**
 * Run docker for the fixture of this spec
 * @param args Docker arguments
 * @returns What Docker printed
 */
async function docker(args : string[]) : Promise<string> {
    const res = await spawn("docker", args, { encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeoutMs: 300_000 });
    return res.stdout?.toString().trim() ?? "";
}

test.describe("контейнер вне стеков", () => {
    test.beforeAll(async () => {
        // Exact name, so nothing else on the machine is touched
        await docker([ "rm", "-f", E2E_STANDALONE_CONTAINER ]).catch(() => "");
        await docker([ "run", "-d", "--init", "--name", E2E_STANDALONE_CONTAINER, "bash:5.2", "sleep", "900" ]);
    });

    test.afterAll(async () => {
        await docker([ "rm", "-f", E2E_STANDALONE_CONTAINER ]).catch(() => "");
    });

    test("виден в списке, а управлять им можно только после разрешения владельца", async ({ page }) => {
        await page.goto(`/?q=${E2E_STANDALONE_CONTAINER}`);

        const row = page.locator(".item", { hasText: E2E_STANDALONE_CONTAINER });
        await expect(row).toBeVisible();
        await expect(row).toContainText("bash:5.2");
        await row.click();

        const view = page.locator(".container-page");
        await expect(page).toHaveURL(/\/container\/[a-f0-9]{64}/);
        await expect(view).toContainText(/Container outside any compose project|Контейнер вне проектов Compose/);
        await expect(view.getByRole("button", { name: /^(stop|остановить)$/i })).toHaveCount(0);
        await view.getByRole("link", { name: /security|безопасность/i }).click();

        await expect(page).toHaveURL(/\/settings\/security/);
        await page.locator("#container-control-on-btn").click();
        await page.locator("#container-control-password").fill(E2E_ADMIN_PASSWORD);
        await page.getByRole("button", { name: /let operators control them|разрешить операторам управлять ими/i }).last().click();
        await expect(page.locator("#container-control-off-btn")).toBeVisible();

        await page.goBack();
        await expect(view).toContainText(/Container outside any compose project|Контейнер вне проектов Compose/);
        await view.getByRole("button", { name: /^(stop|остановить)$/i }).click();
        await page.locator(".modal").getByRole("button", { name: /^(stop|остановить)$/i }).click();
        await expect(view.locator(".state-chip")).toContainText(/stopped|error|остановлен|ошибка/i, { timeout: 30_000 });
        expect(await docker([ "inspect", "--format", "{{.State.Status}}", E2E_STANDALONE_CONTAINER ])).toBe("exited");

        await view.getByRole("button", { name: /^(start|запустить)$/i }).click();
        await page.locator(".modal").getByRole("button", { name: /^(start|запустить)$/i }).click();
        await expect(view.locator(".state-chip")).toContainText(/running|работает/i, { timeout: 30_000 });

        // The setting lives in the run's own database, but the next spec starts from the default
        await page.goto("/settings/security");
        await page.locator("#container-control-off-btn").click();
        await expect(page.locator("#container-control-on-btn")).toBeVisible();
    });
});
