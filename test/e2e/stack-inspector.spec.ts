import { expect, test } from "@playwright/test";
import { E2E_STACK_NAME } from "./constants";

test.describe("список и инспектор", () => {
    test("выбор стека в списке открывает инспектор рядом со списком", async ({ page }) => {
        await page.goto("/");

        // Список на месте, инспектора еще нет
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
        await controls.getByRole("button", { name: /more|ещ[ее]|действия/i }).click();
        await expect(controls.getByRole("menuitem", { name: /^(update images|обновить образы)$/i })).toBeVisible();
        await page.keyboard.press("Escape");

        // Действия строки сервиса озвучиваются вместе с именем сервиса. В строке
        // стоит терминал - то же, что рисует ее значок; журнал и остальное живут
        // под тремя точками
        const service = inspector.locator(".service-row").first();
        await expect(service.getByRole("button", { name: /^(open shell|открыть оболочку):\s.+/i })).toBeVisible();
        await service.locator(".service-menu > summary").click();
        await expect(service.getByRole("button", { name: /^(logs|логи|журнал):\s.+/i })).toBeVisible();
        await expect(service.getByRole("button", { name: /^(restart|перезапустить):\s.+/i })).toBeVisible();
    });

    test("связи и сети свернуты в строку и разворачиваются на месте", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        const summary = page.locator(".links .summary");
        await expect(summary).toBeVisible();
        await expect(summary).toHaveAttribute("aria-expanded", "false");

        // В самой строке уже есть факт: сколько сервисов
        await expect(summary).toContainText(/service|сервис/i);
        await expect(page.locator(".links .details")).toHaveCount(0);

        await summary.click();
        await expect(summary).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator(".links .details")).toBeVisible();
    });

    test("файлы открываются вкладкой той же страницы, а не отдельным экраном", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        await page.getByRole("link", { name: /^(files|файлы)$/i }).click();

        // Страница стека остается: шапка с именем и список стеков никуда не делись
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_STACK_NAME}/files$`));
        await expect(page.locator(".inspector h1")).toHaveText(E2E_STACK_NAME);
        await expect(page.locator(".stack-list")).toBeVisible();
        await expect(page.locator(".editor-box").first()).toBeVisible();

        // Обзор возвращается на месте, таблица сервисов снова видна
        await page.getByRole("link", { name: /^(overview|обзор)$/i }).click();
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_STACK_NAME}$`));
        await expect(page.locator(".inspector .services table")).toBeVisible();
        await expect(page.locator(".editor-box")).toHaveCount(0);
    });

    test("старый адрес редактора ведет во вкладку файлов", async ({ page }) => {
        await page.goto(`/compose/${E2E_STACK_NAME}`);

        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_STACK_NAME}/files$`));
        await expect(page.locator(".editor-box").first()).toBeVisible();
    });
});

test("полные образы и расход раскрываются без потери основных колонок", async ({ page }) => {
    await page.goto(`/stack/${E2E_STACK_NAME}`);

    // Настройка колонок стоит в шапке раздела, а не внутри таблицы
    const services = page.locator(".inspector .services");
    const table = services.locator("table");
    await expect(table.locator("thead th")).toHaveCount(5);
    const image = table.locator(".service-image details").first();
    await expect(image.locator(".full-image")).not.toBeVisible();
    await image.locator("summary").click();
    await expect(image.locator(".full-image")).toBeVisible();
    await expect(image.locator(".full-image")).toHaveText(await image.locator("summary").getAttribute("title") || "");
    await services.locator(".table-options > summary").click();
    await services.getByRole("checkbox").check();
    await expect(table.locator("thead th")).toHaveCount(6);
    await expect(table.locator(".service-usage").first()).toBeVisible();
    await services.getByRole("checkbox").uncheck();
    await expect(table.locator("thead th")).toHaveCount(5);
});

test("на телефоне создание видно сразу, выбор стека переносит фокус в рабочую область", async ({ page }) => {
    await page.setViewportSize({ width: 390,
        height: 844 });
    await page.goto("/new");
    await expect(page.locator(".create-page .page-head h1")).toBeInViewport({ ratio: 1 });
    await expect(page.locator("#git-repository")).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const toggle = page.locator(".mobile-stack-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#stack-navigation")).not.toBeVisible();
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const stack = page.locator(".item", { hasText: E2E_STACK_NAME });
    await stack.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".inspector h1")).toHaveText(E2E_STACK_NAME);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#stack-navigation")).not.toBeVisible();
    await expect(page.locator(".work-column")).toBeFocused();
    await expect(page.locator(".inspector h1")).toBeInViewport({ ratio: 1 });
});
