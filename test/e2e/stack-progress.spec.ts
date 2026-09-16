import { expect, test } from "@playwright/test";
import { E2E_FILES_STACK } from "./constants";

/**
 * Ход команды: под кнопками стека идет одна строка, состояние сервисов
 * называет таблица, а полный вывод docker compose лежит в окне за кнопкой.
 * Стек этого спека сид не запускает, поэтому спек волен его запустить и
 * остановить.
 */
test.describe("ход команды стека", () => {
    test("строка хода ведет к окну с выводом", async ({ page }) => {
        await page.goto(`/stack/${E2E_FILES_STACK}`);

        // Пока команда не запускалась, строки нет: показывать нечего
        await expect(page.locator(".run-strip")).toBeHidden();

        await page.getByRole("button", { name: /^(start|запустить)$/i }).click();

        // Строка появляется сама и называет команду словом, а не выводом
        const strip = page.locator(".run-strip");
        await expect(strip).toBeVisible();
        await expect(strip).toContainText(/starting|запуск/i);

        // Состояние сервиса живет в таблице: отдельной панели для него нет
        await expect.poll(() => page.locator(".services tbody").innerText(), { timeout: 30_000 })
            .toMatch(/creating|starting|started|running|создается|запускается|запущено|работает/i);

        // Черное окно не навязывается: его не видно, пока его не попросят
        await expect(page.locator(".log-dialog")).toBeHidden();

        // Кнопка есть и в строке хода, но строка уходит сама после удачи, а
        // вывод остается доступным всегда - через меню стека
        await page.locator(".head .actions").getByRole("button", { name: /^(more|еще)$/i }).click();
        await page.getByRole("menuitem", { name: /(last command output|вывод последней команды)/i }).click();
        const dialog = page.locator(".log-dialog");
        await expect(dialog).toBeVisible();
        await expect.poll(() => dialog.locator(".xterm-rows").innerText(), { timeout: 30_000 })
            .toMatch(/Container|Network/);

        // Шаги в окне называют ресурсы стека, а не строки вывода
        await expect(dialog.locator(".step").first()).toBeVisible();
        await expect.poll(() => dialog.locator(".steps").innerText())
            .toMatch(new RegExp(E2E_FILES_STACK, "i"));

        await dialog.getByRole("button", { name: /^(close|закрыть)$/i }).first().click();
        await expect(dialog).toBeHidden();

        // Окно вывода не подменяет журнал: там свой поток - строки контейнеров
        await page.getByRole("link", { name: /^(logs|журнал)$/i }).click();
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_FILES_STACK}/logs$`));

        await expect(page.locator(".journal")).toBeVisible();

        // Стек возвращается в то состояние, в котором спек его застал
        await page.getByRole("link", { name: /^(overview|обзор)$/i }).click();
        await page.getByRole("button", { name: /^(stop|остановить)$/i }).click();
        await expect(page.locator(".run-strip")).toBeVisible();
    });
});
