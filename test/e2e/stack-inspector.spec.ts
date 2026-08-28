import { expect, test } from "@playwright/test";
import { E2E_STACK_NAME } from "./constants";

test.describe("список и инспектор", () => {
    test("выбор стека в списке открывает инспектор рядом со списком", async ({ page }) => {
        await page.goto("/");

        // Список на месте, инспектора ещё нет
        await expect(page.locator(".stack-list")).toBeVisible();
        await expect(page.locator(".inspector")).toHaveCount(0);

        await page.locator(".item", { hasText: E2E_STACK_NAME }).click();

        // Инспектор открылся, а список остался: два объекта на экране одновременно
        const inspector = page.locator(".inspector");
        await expect(inspector).toBeVisible();
        await expect(page.locator(".stack-list")).toBeVisible();
        await expect(inspector.locator("h1")).toHaveText(E2E_STACK_NAME);

        // Группа управления доступна с самого экрана, а не со следующего
        const controls = inspector.locator(".head .actions");
        await expect(controls.getByRole("button", { name: /^(stop|остановить)$/i })).toBeVisible();
        await expect(controls.getByRole("button", { name: /^(restart|перезапустить)$/i })).toBeVisible();
        await expect(controls.getByRole("button", { name: /^(update|обновить)$/i })).toBeVisible();

        // Действия строки сервиса озвучиваются вместе с именем сервиса
        await expect(inspector.getByRole("button", { name: /restart .+/i }).first()).toBeVisible();
    });

    test("связи и сети свёрнуты в строку и разворачиваются на месте", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        const summary = page.locator(".links .summary");
        await expect(summary).toBeVisible();
        await expect(summary).toHaveAttribute("aria-expanded", "false");

        // В самой строке уже есть факт: сколько сервисов
        await expect(summary).toContainText(/service/i);
        await expect(page.locator(".links .details")).toHaveCount(0);

        await summary.click();
        await expect(summary).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator(".links .details")).toBeVisible();
    });

    test("compose-редактор открывается поверх на всю ширину, без списка рядом", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        await page.getByRole("button", { name: /^(more|ещё)$/i }).click();
        await page.getByRole("menuitem", { name: /compose/i }).click();

        // Это редактор, и список стеков ему места не занимает
        await expect(page).toHaveURL(new RegExp(`/compose/${E2E_STACK_NAME}$`));
        await expect(page.locator(".stack-list")).toHaveCount(0);
        await expect(page.locator(".editor-box").first()).toBeVisible();
    });
});
