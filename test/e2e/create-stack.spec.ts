import { expect, test, type Page } from "@playwright/test";
import { E2E_STACK_NAME } from "./constants";

/** Имя стека, который создает этот сценарий; каталог очищается перед следующим прогоном. */
const NEW_STACK = "e2e-created";

/** Открыть отдельную страницу создания и выбрать существующий сценарий Compose. */
async function openComposeCreation(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: /новый стек|new stack/i }).first().click();
    await expect(page).toHaveURL(/\/new$/);
    await expect(page.getByRole("tab", { name: /из git|from git/i })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /вставить compose|paste compose/i }).click();
    const form = page.getByRole("tabpanel", { name: /вставить compose|paste compose/i });
    await expect(form).toBeVisible();
    return form;
}

test.describe("создание стека на отдельной странице", () => {
    test("из создания можно вернуться к списку стеков", async ({ page }) => {
        await openComposeCreation(page);
        await page.getByRole("link", { name: /к стекам|back to stacks/i }).click();
        await expect(page).toHaveURL(/\/$/);
        await expect(page.locator(".create-page")).toHaveCount(0);
    });

    test("команда docker run превращается в compose и стек появляется в списке", async ({ page }) => {
        const form = await openComposeCreation(page);
        await form.locator("textarea").fill(`docker run -d --name ${NEW_STACK} -p 8099:80 --rm traefik/whoami`);

        // Через задержку распознавания команда становится Compose в том же поле.
        await expect(form.locator("textarea")).toHaveValue(/services:/, { timeout: 5000 });
        await expect(form.locator("textarea")).toHaveValue(new RegExp(`container_name: ${NEW_STACK}`));
        await expect(form.locator(".recognized")).toBeVisible();
        await expect(form.locator(".report")).toContainText("--rm");
        await expect(form.locator("input[type=text]")).toHaveValue(NEW_STACK);

        // Сохраняем файлы, контейнеры не запускаем.
        await form.getByRole("button", { name: /сохранить без запуска|save without starting/i }).click();
        await expect(page).toHaveURL(new RegExp(`/stack/${NEW_STACK}$`));
        await expect(page.locator(".create-page")).toHaveCount(0);
        const row = page.locator(".item", { hasText: NEW_STACK });
        await expect(row).toBeVisible();
        await expect(row).toHaveClass(/fresh/);
        await expect(row.locator(".fresh-badge")).toBeVisible();
    });

    test("исходную команду можно вернуть, и поле остается своим", async ({ page }) => {
        const form = await openComposeCreation(page);
        const command = "docker run -d --name returned -p 8098:80 traefik/whoami";
        await form.locator("textarea").fill(command);
        await expect(form.locator("textarea")).toHaveValue(/services:/, { timeout: 5000 });
        await form.getByRole("button", { name: /вернуть команду|bring the command back/i }).click();

        await expect(form.locator("textarea")).toHaveValue(command);
        await expect(form.locator(".recognized")).toHaveCount(0);
        // Возврат не запускает повторное преобразование после задержки распознавания.
        await page.waitForTimeout(650);
        await expect(form.locator("textarea")).toHaveValue(command);
        await expect(form.locator(".recognized")).toHaveCount(0);
    });

    test("готовый compose не изменяется, ошибка проверки сохраняет форму", async ({ page }) => {
        const form = await openComposeCreation(page);
        const broken = "services:\n  broken:\n    image: traefik/whoami\n    depends_on: redis\n";
        await form.locator("textarea").fill(broken);

        await expect(form.locator(".recognized")).toHaveCount(0);
        await expect(form.locator(".report")).toHaveCount(0);
        await expect(form.locator("textarea")).toHaveValue(broken);
        await form.locator("input[type=text]").fill("e2e-broken");
        await form.getByRole("button", { name: /^(развернуть|deploy)$/i }).click();

        await expect(form.locator(".failure")).toBeVisible({ timeout: 20000 });
        await expect(form.locator(".failure")).toContainText(/depends_on/);
        await expect(page).toHaveURL(/\/new$/);
        await expect(form.locator("textarea")).toHaveValue(broken);
    });

    test("вставка с экрана стека открывает заполненную вкладку Compose", async ({ page, context }) => {
        await context.grantPermissions([ "clipboard-read", "clipboard-write" ]);
        await page.goto(`/stack/${E2E_STACK_NAME}`);
        await page.waitForSelector(".inspector");

        const command = "docker run -d --name pasted -p 8097:80 traefik/whoami";
        await page.evaluate((text) => navigator.clipboard.writeText(text), command);
        // Вставка вне поля ввода открывает создание с содержимым из буфера.
        await page.locator(".inspector h1").click();
        await page.keyboard.press("Control+V");

        await expect(page).toHaveURL(/\/new$/);
        await expect(page.getByRole("tab", { name: /вставить compose|paste compose/i })).toHaveAttribute("aria-selected", "true");
        const form = page.getByRole("tabpanel", { name: /вставить compose|paste compose/i });
        await expect(form).toBeVisible();
        await expect(form.locator("textarea")).toBeFocused();
        await expect(form.locator("textarea")).toHaveValue(/services:/, { timeout: 5000 });
        await expect(form.locator("input[type=text]")).toHaveValue("pasted");
    });
});
