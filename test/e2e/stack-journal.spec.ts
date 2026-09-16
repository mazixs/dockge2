import { expect, test } from "@playwright/test";
import { E2E_ATTENTION_STACK, E2E_STACK_NAME } from "./constants";

test.describe("журнал стека", () => {
    test("журнал - вкладка страницы стека и только вывод", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        // Нижнего дока в интерфейсе больше нет: вывод живет в рабочей области
        await expect(page.locator(".dock")).toHaveCount(0);
        await expect(page.locator(".journal")).toHaveCount(0);

        await page.getByRole("link", { name: /^(logs|журнал)$/i }).click();
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_STACK_NAME}/logs$`));

        // Вывод стека открыт сразу, потому что вкладка называется журналом
        const journal = page.locator(".journal");
        await expect(journal).toBeVisible();
        await expect(journal).toContainText(E2E_STACK_NAME);
        await expect(journal.locator(".xterm-screen").first()).toBeVisible();

        // Оболочек здесь нет: ни вкладок сессий, ни выбора сервиса
        await expect(journal.locator(".terminal-tab")).toHaveCount(0);
        await expect(journal.locator(".terminal-start")).toHaveCount(0);

        // Шапка стека и список остаются на месте: страница одна
        await expect(page.locator(".inspector h1")).toHaveText(E2E_STACK_NAME);
        await expect(page.locator(".stack-list")).toBeVisible();
    });

    test("другой стек показывает свой журнал, а не чужой", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}/logs`);
        await expect(page.locator(".journal")).toContainText(E2E_STACK_NAME);

        await page.locator(".item", { hasText: E2E_ATTENTION_STACK }).click();
        await expect(page.locator(".inspector h1")).toHaveText(E2E_ATTENTION_STACK);
        await expect(page.locator(".journal")).toContainText(E2E_ATTENTION_STACK);
    });
});
