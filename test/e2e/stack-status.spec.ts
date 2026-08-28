import { expect, test } from "@playwright/test";
import { E2E_ATTENTION_STACK, E2E_STACK_NAME } from "./constants";

test.describe("stack status in the UI", () => {
    test("a healthy stack is active and a partly stopped one asks for attention", async ({ page }) => {
        await page.goto("/");

        // The stack whose only service runs is active
        const healthyRow = page.locator(".item", { hasText: E2E_STACK_NAME });
        await expect(healthyRow.locator(".badge")).toHaveText(/active/i);

        // The stack with an unmarked container that exited is not called inactive
        const attentionRow = page.locator(".item", { hasText: E2E_ATTENTION_STACK });
        await expect(attentionRow.locator(".badge")).toHaveText(/attention/i);
        await expect(attentionRow.locator(".badge")).not.toHaveText(/inactive/i);
    });

    test("инспектор называет причину и не выдаёт работающий сервис за мёртвый", async ({ page }) => {
        await page.goto(`/stack/${E2E_ATTENTION_STACK}`);

        // Причина названа одной строкой: сервис и что с ним не так
        const attention = page.locator(".attention").first();
        await expect(attention).toBeVisible();
        await expect(attention).toContainText("init");
        await expect(attention).toContainText("service stopped");

        // Таблица сервисов: работающий помечен running, остановленный - нет
        const services = page.locator("table.services");
        await expect(services).toBeVisible();
        await expect(services.locator("tbody tr", { hasText: "app" }).locator(".badge")).toHaveText(/running/i);
        await expect(services.locator("tbody tr", { hasText: "init" }).locator(".badge")).not.toHaveText(/running/i);
    });
});
