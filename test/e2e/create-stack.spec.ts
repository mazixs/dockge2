import { expect, test } from "@playwright/test";
import { E2E_STACK_NAME } from "./constants";

/** Имя стека, который создаёт этот спек; каталог стирается сидом следующего прогона */
const NEW_STACK = "e2e-created";

test.describe("создание стека слоем поверх списка", () => {
    test("команда docker run превращается в compose и стек появляется в списке", async ({ page }) => {
        await page.goto("/");

        // Слой закрыт, пока его не позвали
        await expect(page.locator(".sheet-layer:not(.inline) .sheet")).toHaveCount(0);

        await page.getByRole("button", { name: /развернуть стек|deploy stack/i }).first().click();
        const sheet = page.locator(".sheet-layer:not(.inline) .sheet");
        await expect(sheet).toBeVisible();

        // Поле получает фокус само: вставлять и печатать можно сразу
        await expect(sheet.locator("textarea")).toBeFocused();

        await sheet.locator("textarea").fill(`docker run -d --name ${NEW_STACK} -p 8099:80 --rm traefik/whoami`);

        // Через задержку распознавания команда становится compose в том же поле
        await expect(sheet.locator("textarea")).toHaveValue(/services:/, { timeout: 5000 });
        await expect(sheet.locator("textarea")).toHaveValue(new RegExp(`container_name: ${NEW_STACK}`));

        // Полоса говорит, что произошло, и предлагает вернуть команду
        await expect(sheet.locator(".recognized")).toBeVisible();

        // Из отчёта на экране назван флаг, из-за которого сервис ведёт себя иначе
        await expect(sheet.locator(".report")).toContainText("--rm");

        // Имя подставлено из сервиса, не из головы
        await expect(sheet.locator("input[type=text]")).toHaveValue(NEW_STACK);

        // Разворачивать не будем: файлы на диск, контейнеры не трогаем
        await sheet.getByRole("button", { name: /сохранить без запуска|save without starting/i }).click();

        // Слой закрылся сам, а стек виден в списке и помечен как новый
        await expect(page.locator(".sheet-layer:not(.inline) .sheet")).toHaveCount(0);
        const row = page.locator(".item", { hasText: NEW_STACK });
        await expect(row).toBeVisible();
        await expect(row).toHaveClass(/fresh/);
        await expect(row.locator(".fresh-badge")).toBeVisible();
    });

    test("исходную команду можно вернуть, и поле остаётся своим", async ({ page }) => {
        await page.goto("/");
        await page.getByRole("button", { name: /развернуть стек|deploy stack/i }).first().click();

        const sheet = page.locator(".sheet-layer:not(.inline) .sheet");
        const command = "docker run -d --name returned -p 8098:80 traefik/whoami";
        await sheet.locator("textarea").fill(command);
        await expect(sheet.locator("textarea")).toHaveValue(/services:/, { timeout: 5000 });

        await sheet.getByRole("button", { name: /вернуть команду|bring the command back/i }).click();

        // В поле снова команда, полосы преобразования нет
        await expect(sheet.locator("textarea")).toHaveValue(command);
        await expect(sheet.locator(".recognized")).toHaveCount(0);
    });

    test("готовый compose поле не трогает, а ошибка проверки не закрывает слой", async ({ page }) => {
        await page.goto("/");
        await page.getByRole("button", { name: /развернуть стек|deploy stack/i }).first().click();

        const sheet = page.locator(".sheet-layer:not(.inline) .sheet");
        const broken = "services:\n  broken:\n    image: traefik/whoami\n    depends_on: redis\n";
        await sheet.locator("textarea").fill(broken);

        // Это уже compose: никакого преобразования и никакого отчёта о флагах
        await expect(sheet.locator(".recognized")).toHaveCount(0);
        await expect(sheet.locator(".report")).toHaveCount(0);
        await expect(sheet.locator("textarea")).toHaveValue(broken);

        await sheet.locator("input[type=text]").fill("e2e-broken");
        await sheet.getByRole("button", { name: /^(развернуть|deploy)$/i }).click();

        // Проверка конфигурации не прошла: слой на месте, текст ошибки от Docker Compose
        await expect(sheet.locator(".failure")).toBeVisible({ timeout: 20000 });
        await expect(sheet.locator(".failure")).toContainText(/depends_on/);
        await expect(sheet).toBeVisible();
        await expect(sheet.locator("textarea")).toHaveValue(broken);
    });

    test("вставка с экрана стека открывает слой уже заполненным", async ({ page, context }) => {
        await context.grantPermissions([ "clipboard-read", "clipboard-write" ]);

        // На главной поле вставки стоит прямо в рабочей области, поэтому слой нужен
        // там, где его нет: на открытом стеке
        await page.goto(`/stack/${E2E_STACK_NAME}`);
        await page.waitForSelector(".inspector");

        const command = "docker run -d --name pasted -p 8097:80 traefik/whoami";
        await page.evaluate((text) => navigator.clipboard.writeText(text), command);

        // Фокус не в поле ввода, поэтому вставка принадлежит слою, а не странице
        await page.locator("body").click({ position: { x: 600,
            y: 700 } });
        await page.keyboard.press("Control+V");

        const sheet = page.locator(".sheet-layer:not(.inline) .sheet");
        await expect(sheet).toBeVisible();
        await expect(sheet.locator("textarea")).toHaveValue(/services:/, { timeout: 5000 });
        await expect(sheet.locator("input[type=text]")).toHaveValue("pasted");
    });
});
