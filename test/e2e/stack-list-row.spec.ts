import { expect, test } from "@playwright/test";
import { E2E_ATTENTION_STACK, E2E_FILES_STACK, E2E_STACK_NAME } from "./constants";

test.describe("строка списка стеков", () => {
    test("фильтр сужает список и остается в адресе", async ({ page }) => {
        await page.goto("/");

        await page.locator(".filter-disclosure > summary").click();
        const attention = page.getByRole("button", { name: /^(attention|внимание)(?:\s|$)/i });
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

    test("поиск живет в адресе и переживает переход к стеку и перезагрузку", async ({ page }) => {
        await page.goto("/");

        const search = page.locator(".search-input");
        await search.fill("shellbox");
        await expect(page).toHaveURL(/[?&]q=shellbox/);

        await page.locator(".item", { hasText: E2E_STACK_NAME }).click();
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_STACK_NAME}\\?.*q=shellbox`));
        await expect(search).toHaveValue("shellbox");
        await expect(page.locator(".item", { hasText: E2E_FILES_STACK })).toHaveCount(0);

        await page.reload();
        await expect(page.locator(".search-input")).toHaveValue("shellbox");
        await expect(page.locator(".item", { hasText: E2E_FILES_STACK })).toHaveCount(0);

        await page.getByRole("button", { name: /clear search|очистить поиск/i }).click();
        await expect(page).not.toHaveURL(/[?&]q=/);
        await expect(page.locator(".item", { hasText: E2E_FILES_STACK })).toBeVisible();
    });

    test("фильтр внимания и поиск вместе открываются ссылкой", async ({ page }) => {
        await page.goto(`/?filter=attention&q=${encodeURIComponent("e2e")}`);

        await expect(page.locator(".search-input")).toHaveValue("e2e");
        await expect(page.getByRole("button", { name: /^(attention|внимание)(?:\s|$)/i })).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator(".item", { hasText: E2E_ATTENTION_STACK })).toBeVisible();
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toHaveCount(0);
    });

    test("стек находится и открывается с клавиатуры", async ({ page }) => {
        await page.goto("/");

        const search = page.locator(".search-input");
        await search.focus();
        await page.keyboard.type(E2E_FILES_STACK);

        // Поле, раскрытие фильтров и первая найденная строка
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        const row = page.locator(".item", { hasText: E2E_FILES_STACK });
        await expect(row).toBeFocused();

        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_FILES_STACK}`));
        await expect(row).toHaveAttribute("aria-current", "page");
    });

    test("на телефоне поиск помещается в экран, и страница не едет вбок", async ({ page }) => {
        await page.setViewportSize({ width: 390,
            height: 844 });
        await page.goto("/?q=shellbox");

        // На телефоне список открывается кнопкой, а не стоит колонкой
        await page.getByRole("button", { name: /^(stacks|стеки)\b/i }).click();
        await expect(page.locator(".search-input")).toBeVisible();
        await expect(page.locator(".search-input")).toHaveValue("shellbox");
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
    });

    test("связи сервисов читаются из файлов стека и ведут на страницу контейнера", async ({ page }) => {
        await page.goto(`/stack/${E2E_ATTENTION_STACK}`);

        await page.locator(".links .summary").click();
        const relations = page.locator(".relations");
        await expect(relations).toContainText(/as Compose resolves them|как их разбирает Compose/);
        await expect(relations.locator(".relation-card")).toHaveCount(2);

        await relations.locator(".relation-card", { hasText: "app" }).getByRole("link").first().click();
        await expect(page).toHaveURL(/\/container\/[a-f0-9]{64}/);
        await expect(page.locator(".container-page")).toContainText(/Container of a stack of this panel|Контейнер стека этой панели/);
        await page.getByRole("link", { name: /open its stack|открыть его стек/i }).click();
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_ATTENTION_STACK}$`));
    });

    test("инспектор называет каталог, число сервисов и реестр образов", async ({ page }) => {
        await page.goto(`/stack/${E2E_ATTENTION_STACK}`);

        const services = page.locator(".inspector .services");
        await expect(page.locator(".source-panel")).toContainText(E2E_ATTENTION_STACK);
        await expect(services.locator(".service-count")).toHaveText("2");
        await page.locator(".links .summary").click();
        await expect(page.locator(".links .details")).toContainText(/Docker Hub/);

        // Причина названа и рядом стоит то, чем ее лечить
        const attention = page.locator(".inspector .attention").first();
        await expect(attention.locator(".attention-badge")).toBeVisible();
        await expect(attention.getByRole("button", { name: /logs of init|логи init/i })).toBeVisible();
        await expect(attention.getByRole("button", { name: /restart init|перезапустить init/i })).toBeVisible();

        // Подпись раздела честно говорит, насколько свежие числа
        await expect(services.locator(".services-checked")).toHaveText(/checked|проверено/i);
    });
});

test.describe("доступность", () => {
    test("окно без сбоев не превращается в 100 процентов, а сбой называет и долю, и случай", async ({ page }) => {
        await page.goto(`/stack/${E2E_STACK_NAME}`);

        // Стек работает третьи сутки: окно закрыто целиком и без сбоев
        const healthy = page.locator(".inspector .availability .verdict");
        await expect(healthy).toHaveText(/no incidents|без сбоев/i);

        // Стек со сбоем: доля и число случаев, а не "почти работает".
        // Случаев может быть больше одного: сервер записывает и свои наблюдения,
        // поэтому проверяется правило, а не конкретное число.
        await page.goto(`/stack/${E2E_ATTENTION_STACK}`);
        const degraded = page.locator(".inspector .availability .verdict");
        await expect(degraded).toHaveText(/9\d[.,]\d%/);
        await expect(degraded).toHaveText(/\d+ incident|\d+ сбо/i);
    });

    test("остановленный стек показывает срок, а не долю", async ({ page }) => {
        await page.goto(`/stack/${E2E_FILES_STACK}`);

        // У стека нет запущенных контейнеров: процент был бы бессмыслицей
        const stopped = page.locator(".inspector .availability .verdict");
        await expect(stopped).toHaveText(/stopped .* ago|остановлен .* назад/i);
        await expect(stopped).not.toHaveText(/%/);
    });

    test("инспектор считает доступность по выбранному окну", async ({ page }) => {
        await page.goto(`/stack/${E2E_ATTENTION_STACK}`);

        const section = page.locator(".inspector .availability");
        await expect(section).toBeVisible();
        await expect(section.locator(".verdict")).toHaveText(/9\d[.,]\d%/);

        // Месяц наблюдался не целиком, и это сказано прямо, а не спрятано
        await page.getByRole("button", { name: /^30 (d|д)$/ }).click();
        await expect(section.locator(".note")).toHaveText(/data collected|данные собраны/i);
        await expect(page.getByRole("button", { name: /^30 (d|д)$/ })).toHaveAttribute("aria-pressed", "true");
    });
});
