import { expect, test } from "@playwright/test";
import { E2E_ATTENTION_STACK, E2E_FILES_STACK, E2E_STACK_NAME } from "./constants";

test.describe("строка списка стеков", () => {
    test("строка называет агента, источник и сервисы стека", async ({ page }) => {
        await page.goto("/");

        const row = page.locator(".item", { hasText: E2E_ATTENTION_STACK });
        await expect(row).toBeVisible();

        // Где живёт стек и откуда взялся его каталог
        await expect(row.locator(".agent")).toHaveText(/this server|этот сервер/i);
        await expect(row.locator(".source")).toBeVisible();

        // Сервисы названы поимённо, а не числом
        const services = row.locator(".service");
        await expect(services.filter({ hasText: "app" })).toBeVisible();
        await expect(services.filter({ hasText: "init" })).toBeVisible();

        // Колонка обновлений присутствует и ничего не выдумывает
        await expect(row.locator(".updates")).toBeVisible();
    });

    test("фильтр сужает список и остаётся в адресе", async ({ page }) => {
        await page.goto("/");

        const attention = page.getByRole("button", { name: /^(attention|внимание)\b/i });
        await expect(attention).toHaveAttribute("aria-pressed", "false");

        await attention.click();

        // Срез виден в адресе, значит на него можно дать ссылку
        await expect(page).toHaveURL(/[?&]filter=attention/);
        await expect(attention).toHaveAttribute("aria-pressed", "true");

        // Остались только стеки, требующие внимания
        await expect(page.locator(".item", { hasText: E2E_ATTENTION_STACK })).toBeVisible();
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toHaveCount(0);

        // Повторное нажатие снимает фильтр: это переключатель, а не вкладка
        await attention.click();
        await expect(page).not.toHaveURL(/[?&]filter=attention/);
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toBeVisible();
    });

    test("поиск находит стек по имени сервиса, а не только по своему", async ({ page }) => {
        await page.goto("/");

        // shellbox - сервис внутри стека e2e-terminal, имени стека в запросе нет
        await page.locator(".search-input").fill("shellbox");

        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toBeVisible();
        await expect(page.locator(".item", { hasText: E2E_FILES_STACK })).toHaveCount(0);
    });

    test("инспектор называет каталог, число сервисов и реестр образов", async ({ page }) => {
        await page.goto(`/stack/${E2E_ATTENTION_STACK}`);

        const facts = page.locator(".inspector .facts");
        await expect(facts).toContainText(E2E_ATTENTION_STACK);
        await expect(facts).toContainText(/2 service|2 сервиса/i);
        await expect(facts).toContainText(/Docker Hub/);

        // Причина названа и рядом стоит то, чем её лечить
        const attention = page.locator(".inspector .attention").first();
        await expect(attention.locator(".reason-badge")).toBeVisible();
        await expect(attention.getByRole("button", { name: /logs of init|логи init/i })).toBeVisible();
        await expect(attention.getByRole("button", { name: /restart init|перезапустить init/i })).toBeVisible();

        // Подпись таблицы честно говорит, насколько свежие числа
        await expect(page.locator(".inspector .services caption")).toHaveText(/state as of|состояние на/i);
    });
});
