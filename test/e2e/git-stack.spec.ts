import type { Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_GIT_BRANCH, E2E_GIT_ORIGIN_PORT, E2E_GIT_ORIGIN_URL, E2E_GIT_STACK } from "./constants";
import { commitGitFixture, prepareGitFixture, serveGitFixture, stopGitFixture } from "./git-fixture";

const stacksDir = process.env.DOCKGE_E2E_STACKS_DIR ?? "/tmp/dockge-e2e/stacks";
const stackDir = path.join(stacksDir, E2E_GIT_STACK);

/** Первый коммит: то, что панель обязана положить на сервер байт в байт. */
const FIRST_COMPOSE = `# comes from the repository
services:
  app:
    image: bash:5.2
    command: [ "bash", "-c", "sleep 900" ]
`;

/** Второй коммит: та же служба, другой образ и дописанный комментарий. */
const UPDATED_COMPOSE = `# comes from the repository, second commit
services:
  app:
    image: bash:5.3
    command: [ "bash", "-c", "sleep 900" ]
`;

const FIRST_ENV = "STAGE=base\n";
const UPDATED_ENV = "STAGE=from-git\n";

let origin : Server;

/** Стек из Git, от клонирования до выбора версии каждого файла. Контейнеры не запускаются:
 *  проверяется работа с файлами и то, что интерфейс называет состояние своим именем. */
test.describe.serial("стек из Git", () => {
    test.beforeAll(async () => {
        await prepareGitFixture(E2E_GIT_BRANCH, { "compose.yaml": FIRST_COMPOSE,
            ".env": FIRST_ENV });
        origin = await serveGitFixture(E2E_GIT_ORIGIN_PORT);
    });

    test.afterAll(async () => {
        await stopGitFixture(origin);
    });

    test("репозиторий клонируется, а источник не выдает клон за проверку", async ({ page }) => {
        await page.goto("/new");
        const form = page.getByRole("tabpanel", { name: /из git|from git/i });
        await expect(form).toBeVisible();

        await form.locator("#git-repository").fill(E2E_GIT_ORIGIN_URL);

        // Ветку выбираем из списка, который отдал сам репозиторий, а не из памяти
        await form.getByRole("button", { name: /показать ветки|list branches/i }).click();
        await expect(form.locator("#git-branch")).toHaveValue(E2E_GIT_BRANCH, { timeout: 30_000 });
        await expect(form.locator("select#git-branch")).toBeVisible();

        await form.getByRole("button", { name: /продолжить|continue/i }).click();
        await form.locator("#git-stack-name").fill(E2E_GIT_STACK);
        await form.locator("#git-compose-file").fill("compose.yaml");
        await form.getByRole("button", { name: /сохранить без запуска|save without starting/i }).click();

        const result = page.locator(".result-card");
        await expect(result).toContainText(E2E_GIT_STACK, { timeout: 60_000 });

        // Клон кладет файлы как есть: ни комментарии, ни перевод строки не переписаны
        expect(await readFile(path.join(stackDir, "compose.yaml"), "utf8")).toBe(FIRST_COMPOSE);
        expect(await readFile(path.join(stackDir, ".env"), "utf8")).toBe(FIRST_ENV);

        await result.getByRole("link", { name: /открыть стек|open stack/i }).click();
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_GIT_STACK}$`));

        // Клонирование - не проверка: origin с этой машины еще никто не спрашивал
        const source = page.locator(".source-panel").first();
        await expect(source).toContainText(E2E_GIT_BRANCH);
        await expect(source.locator(".source-status")).toHaveText(/еще не проверен|not been checked yet/i);
    });

    test("проверка без новых коммитов не выдумывает изменений и остается свежей", async ({ page }) => {
        await openComparison(page);

        await expect(page.locator(".empty-result")).toContainText(/файлы совпадают|files match/i, { timeout: 60_000 });
        await expect(page.locator(".diff-workspace")).toHaveCount(0);

        await page.getByRole("link", { name: new RegExp(`к стеку|back to ${E2E_GIT_STACK}`, "i") }).click();
        await expect(page).toHaveURL(new RegExp(`/stack/${E2E_GIT_STACK}$`));

        // Теперь у панели есть чем подтвердить "изменений нет": она сама и говорит, когда проверяла
        const source = page.locator(".source-panel").first();
        await expect(source.locator(".source-status")).toHaveText(/изменений нет|no changes since/i, { timeout: 30_000 });
        await expect(source).toContainText(/проверено|checked/i);
    });

    test("новый коммит сравнивается по файлам, и выбранная локальная версия остается", async ({ page }) => {
        await commitGitFixture(E2E_GIT_BRANCH, { "compose.yaml": UPDATED_COMPOSE,
            ".env": UPDATED_ENV }, "second");

        await openComparison(page);
        const files = page.locator(".diff-files .diff-file");
        await expect(files).toHaveCount(2, { timeout: 60_000 });

        // Compose виден целиком: обе стороны названы и показаны
        await files.filter({ hasText: "compose.yaml" }).click();
        await expect(page.locator(".server-side")).toContainText("image: bash:5.2");
        await expect(page.locator(".git-side")).toContainText("image: bash:5.3");
        await page.locator(".git-side").getByRole("button", { name: /взять из git|take from git/i }).click();

        // Env-файл может содержать секреты, поэтому выбор делается вслепую
        await files.filter({ hasText: ".env" }).click();
        await expect(page.locator(".hidden-file")).toBeVisible();
        await expect(page.locator(".diff-detail")).not.toContainText("STAGE=");
        await page.locator(".server-side").getByRole("button", { name: /оставить на сервере|keep on server/i }).click();

        await expect(page.locator(".decision-footer")).toContainText(/2.*2/);
        await page.getByRole("button", { name: /проверить результат|review result/i }).click();

        // Последний экран честно предупреждает, что отличие от Git никуда не денется
        const review = page.locator(".review-card");
        await expect(review).toContainText(/по-прежнему отличаться|still differ from the versions in git/i);
        await review.getByRole("button", { name: /сохранить без запуска|save without starting/i }).click();
        await expect(page.locator(".result-card")).toContainText(/изменения сохранены|changes saved/i, { timeout: 60_000 });

        // Выбор применен по каждому файлу отдельно
        expect(await readFile(path.join(stackDir, "compose.yaml"), "utf8")).toBe(UPDATED_COMPOSE);
        expect(await readFile(path.join(stackDir, ".env"), "utf8")).toBe(FIRST_ENV);

        await page.goto(`/stack/${E2E_GIT_STACK}`);
        const source = page.locator(".source-panel").first();
        await expect(source.locator(".source-status")).toHaveText(/изменен на сервере|edited on the server/i, { timeout: 30_000 });
    });
});

/**
 * Открыть сравнение так, как его открывает человек - кнопкой со страницы стека.
 * Пока изменений нет, звать сравнить умеет только панель источника; как только они
 * появились, тот же призыв встает полосой над вкладками, а панель его не повторяет.
 * @param page Страница теста
 * @returns void
 */
async function openComparison(page : Page) : Promise<void> {
    await page.goto(`/stack/${E2E_GIT_STACK}`);
    await page.getByRole("link", { name: /проверить обновления|сравнить изменения|check for updates|compare changes/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/stack/${E2E_GIT_STACK}/git$`));
}
