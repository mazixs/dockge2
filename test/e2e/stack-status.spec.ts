import { expect, test } from "@playwright/test";
import { E2E_ATTENTION_STACK, E2E_STACK_NAME } from "./constants";

test.describe("stack status in the UI", () => {
    test("a healthy stack is active and a partly stopped one asks for attention", async ({ page }) => {
        await page.goto("/");

        // Состояние стоит в мета-строке словом; вторая отметка в конце строки - только точка
        const healthyRow = page.locator(".item", { hasText: E2E_STACK_NAME });
        await expect(healthyRow.locator(".meta .state-chip")).toHaveText(/running/i);

        // The stack with an unmarked container that exited is not called stopped
        const attentionRow = page.locator(".item", { hasText: E2E_ATTENTION_STACK });
        await expect(attentionRow.locator(".meta .state-chip")).toHaveText(/attention/i);
        await expect(attentionRow.locator(".meta .state-chip")).not.toHaveText(/stopped/i);
    });

    test("инспектор называет причину и не выдает работающий сервис за мертвый", async ({ page }) => {
        await page.goto(`/stack/${E2E_ATTENTION_STACK}`);

        // Причина названа одной строкой: сервис и что с ним не так
        const attention = page.locator(".attention").first();
        await expect(attention).toBeVisible();
        await expect(attention).toContainText("init");
        await expect(attention).toContainText("service stopped");

        // Сервисы: состояние каждого - свой чип в колонке состояния
        const services = page.locator(".inspector .services");
        await expect(services).toBeVisible();
        await expect(services.locator(".service-row", { hasText: "app" }).locator(".service-state .state-chip")).toHaveClass(/state-running/);
        await expect(services.locator(".service-row", { hasText: "init" }).locator(".service-state .state-chip")).not.toHaveClass(/state-running/);

        // Расход - колонка по выбору, и у остановленного сервиса она тоже что-то говорит
        await services.locator(".table-options > summary").click();
        await services.getByRole("checkbox").check();
        await expect(services.locator(".service-row", { hasText: "init" }).locator(".service-usage")).not.toHaveText("");
    });
});
