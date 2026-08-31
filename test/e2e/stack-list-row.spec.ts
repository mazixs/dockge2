import { expect, test } from "@playwright/test";
import { E2E_ATTENTION_STACK, E2E_FILES_STACK, E2E_STACK_NAME } from "./constants";

test.describe("строка списка стеков", () => {
    test("строка называет агента, источник и сервисы стека", async ({ page }) => {
        await page.goto("/");

        const row = page.locator(".item", { hasText: E2E_ATTENTION_STACK });
        await expect(row).toBeVisible();

        // Навигатор держит одну мета-строку: сколько сервисов и что с доступностью.
        // Подробности - образы, порты, расход - живут в рабочей области справа
        const meta = row.locator(".meta");
        await expect(meta).toContainText(/2 service|2 сервиса/i);
        await expect(meta.locator(".availability")).toBeVisible();
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

        // Подпись раздела честно говорит, насколько свежие числа
        await expect(page.locator(".inspector .services caption")).toHaveText(/state as of|состояние на/i);
    });
});

test.describe("доступность", () => {
    test("окно без сбоев не превращается в «100%», а сбой называет и долю, и случай", async ({ page }) => {
        await page.goto("/");

        // Стек работает третьи сутки: окно закрыто целиком и без сбоев
        const healthy = page.locator(".item", { hasText: E2E_STACK_NAME });
        await expect(healthy.locator(".meta .availability")).toHaveText(/no incidents|без сбоев/i);

        // Стек со сбоем: доля и число случаев, а не «почти работает».
        // Случаев может быть больше одного: сервер записывает и свои наблюдения,
        // поэтому проверяется правило, а не конкретное число.
        const degraded = page.locator(".item", { hasText: E2E_ATTENTION_STACK });
        await expect(degraded.locator(".meta .availability")).toHaveText(/9\d[.,]\d%/);
        await expect(degraded.locator(".meta .availability")).toHaveText(/\d+ incident|\d+ сбо/i);
    });

    test("остановленный стек показывает срок, а не долю", async ({ page }) => {
        await page.goto("/");

        // У стека нет запущенных контейнеров: процент был бы бессмыслицей
        const stopped = page.locator(".item", { hasText: E2E_FILES_STACK });
        await expect(stopped.locator(".meta .availability")).toHaveText(/stopped .* ago|остановлен .* назад/i);
        await expect(stopped.locator(".meta .availability")).not.toHaveText(/%/);
    });

    test("инспектор считает доступность по выбранному окну", async ({ page }) => {
        await page.goto(`/stack/${E2E_ATTENTION_STACK}`);

        const section = page.locator(".inspector .availability");
        await expect(section).toBeVisible();
        await expect(section.locator(".verdict")).toHaveText(/9\d[.,]\d%/);

        // Месяц наблюдался не целиком, и это сказано прямо, а не спрятано
        await page.getByRole("button", { name: /^30 (d|д)$/ }).click();
        await expect(section.locator(".note")).toHaveText(/observed|наблюдалось/i);
        await expect(page.getByRole("button", { name: /^30 (d|д)$/ })).toHaveAttribute("aria-pressed", "true");
    });
});
