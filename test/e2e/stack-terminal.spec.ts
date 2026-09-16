import { expect, test } from "@playwright/test";
import { E2E_STACK_NAME } from "./constants";

test.describe("терминал стека", () => {
    test("пустая вкладка предлагает сервисы, а не черный экран", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}/terminal`);

        const terminals = page.locator(".terminals");
        await expect(terminals.locator(".terminal-start")).toBeVisible();
        await expect(terminals.locator(".terminal-body")).toHaveCount(0);
        await expect(terminals.locator(".terminal-start button").first()).toBeVisible();
    });

    test("оболочка сервиса открывается во вкладке терминала и переживает возврат", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        const service = page.locator(".service-row").first();
        await service.locator(".service-menu > summary").click();
        await service.getByRole("button", { name: /open shell|открыть shell/i }).click();

        // Выбор оболочки сам переводит во вкладку терминала, а не в журнал
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_STACK_NAME}/terminal$`));
        const terminals = page.locator(".terminals");
        await expect(terminals.locator(".terminal-tab")).toHaveCount(1);
        await expect(terminals.locator(".terminal-tab.active")).toContainText(/sh/);

        // Уход в журнал сессию не убивает: она ждет на месте
        await page.getByRole("link", { name: /^(logs|журнал)$/i }).click();
        await expect(terminals).toBeHidden();
        await page.getByRole("link", { name: /^(terminal|терминал)$/i }).click();
        await expect(terminals.locator(".terminal-tab")).toHaveCount(1);

        // Закрытие вкладки сессии возвращает выбор сервиса
        await terminals.locator(".terminal-tab.active .close").click();
        await expect(terminals.locator(".terminal-tab")).toHaveCount(0);
        await expect(terminals.locator(".terminal-start")).toBeVisible();
    });
});
