import { expect, test } from "@playwright/test";
import { E2E_ATTENTION_STACK, E2E_STACK_NAME } from "./constants";

test.describe("нижний док вывода", () => {
    test("логи открываются доком и переживают переход к другому стеку", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        // Дока нет, пока его не позвали
        await expect(page.locator(".dock")).toHaveCount(0);

        await page.getByRole("button", { name: /^(more|ещё)$/i }).click();
        await page.getByRole("menuitem", { name: /^(logs|логи)$/i }).click();

        const dock = page.locator(".dock");
        await expect(dock).toBeVisible();
        await expect(dock.locator(".tab.active")).toContainText(E2E_STACK_NAME);
        await expect(dock.locator(".xterm-screen")).toBeVisible();

        // Переход к другому стеку вывод не роняет: он на общем уровне
        await page.locator(".item", { hasText: E2E_ATTENTION_STACK }).click();
        await expect(page.locator(".inspector h1")).toHaveText(E2E_ATTENTION_STACK);
        await expect(dock).toBeVisible();
        await expect(dock.locator(".tab.active")).toContainText(E2E_STACK_NAME);

        // И переживает открытие редактора файла внутри приложения
        await page.getByRole("button", { name: /^(more|ещё)$/i }).click();
        await page.getByRole("menuitem", { name: /compose/i }).click();
        await expect(page).toHaveURL(new RegExp(`/compose/${E2E_ATTENTION_STACK}$`));
        await expect(dock.locator(".tab")).toHaveCount(1);
        await expect(dock.locator(".tab.active")).toContainText(E2E_STACK_NAME);
    });

    test("shell сервиса открывается второй сессией, высота дока запоминается", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        await page.getByRole("button", { name: /^(more|ещё)$/i }).click();
        await page.getByRole("menuitem", { name: /^(logs|логи)$/i }).click();

        const dock = page.locator(".dock");
        await dock.locator(".grip").focus();
        await page.keyboard.press("ArrowUp");
        const taller = await dock.evaluate((node) => node.getBoundingClientRect().height);

        // Shell того же стека - отдельная сессия, а не замена логам
        await page.getByRole("button", { name: /^shell\b/i }).first().click();
        await expect(dock.locator(".tab")).toHaveCount(2);
        await expect(dock.locator(".tab.active")).toContainText(/bash/);

        // Высота дошла до localStorage, поэтому возвращается после перезагрузки
        await page.reload();
        await page.getByRole("button", { name: /^(more|ещё)$/i }).click();
        await page.getByRole("menuitem", { name: /^(logs|логи)$/i }).click();
        const restored = await dock.evaluate((node) => node.getBoundingClientRect().height);
        expect(Math.round(restored)).toBe(Math.round(taller));

        // Закрытие сессии убирает вкладку, а последнее закрытие - весь док
        await dock.locator(".tab.active .close").click();
        await expect(dock.locator(".tab")).toHaveCount(0);
        await expect(page.locator(".dock")).toHaveCount(0);
    });
});
