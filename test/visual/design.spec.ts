import { expect, test } from "@playwright/test";

/**
 * Эталонные снимки экранов.
 *
 * Тест отвечает на один вопрос: изменился ли вид без умысла. Сцена детерминирована,
 * поэтому расхождение снимка - это всегда правка разметки, токенов или шрифта, а не
 * шум окружения. Время сцены останавливается, иначе возраст статуса и полоса
 * доступности меняли бы кадр каждую секунду.
 *
 * Эталон переутверждается отдельной командой и осознанно: снимок, обновленный
 * заодно с правкой, перестает быть эталоном и ничего не ловит.
 */

/** Час, от которого сцена считает возраст статуса и окна доступности */
const FROZEN_TIME = new Date("2026-09-15T12:00:00Z");

type Screen = {
    /** Имя снимка: оно же имя файла эталона */
    name : string;
    /** Адрес внутри сцены */
    path : string;
    /** Селектор, по которому видно, что экран отрисован, а не только смонтирован */
    ready : string;
    /** Снимать ли на узкой ширине: на телефоне проверяются экраны с другой раскладкой */
    phone : boolean;
};

const screens : Screen[] = [
    { name: "dashboard",
        path: "/",
        ready: ".stability-dashboard",
        phone: true },
    { name: "stack-overview",
        path: "/stack/paperless",
        ready: ".inspector .services tbody tr",
        phone: true },
    { name: "stack-files",
        path: "/stack/paperless/files",
        ready: ".inspector .panel.file-card",
        phone: true },
    { name: "stack-journal",
        path: "/stack/paperless/logs",
        ready: ".inspector .panel-console",
        phone: true },
    { name: "stack-terminal",
        path: "/stack/paperless/terminal",
        ready: ".inspector .panel.terminals",
        phone: false },
    { name: "stack-git-changes",
        path: "/stack/paperless/git",
        ready: ".changes-page",
        phone: false },
    { name: "new-stack",
        path: "/new",
        ready: ".create-page",
        phone: true },
    { name: "settings-appearance",
        path: "/settings/appearance",
        ready: ".settings-page .panel",
        phone: false },
    { name: "login",
        path: "/login",
        ready: ".auth-screen",
        phone: false },
];

test.beforeEach(async ({ page }, testInfo) => {
    // Часы стоят, но таймеры идут: сцена отвечает на события через setTimeout, и
    // остановленный планировщик оставил бы экраны пустыми
    await page.clock.setFixedTime(FROZEN_TIME);

    // Тема ставится явно, а не только эмуляцией системной: предпочтение хранится
    // в браузере, и эталон не должен зависеть от того, что там осталось от прошлого раза
    await page.addInitScript((theme : string) => {
        window.localStorage.setItem("theme", theme);
    }, testInfo.project.name.endsWith("dark") ? "dark" : "light");
});

for (const screen of screens) {
    test(screen.name, async ({ page }, testInfo) => {
        test.skip(!screen.phone && testInfo.project.name.startsWith("phone"), "Экран проверяется только на широкой ширине");

        await page.goto(screen.path);
        await expect(page.locator(screen.ready).first()).toBeVisible();

        // Подпись сцены закреплена у нижнего края окна, а снимок берется во всю
        // высоту страницы: на нем она садится посреди содержимого и закрывает как
        // раз то, что снимок проверяет - нижнюю панель действий, например
        await page.addStyleTag({ content: ".scene-mark { display: none }" });

        await expect(page).toHaveScreenshot(`${screen.name}.png`, {
            fullPage: true,
            animations: "disabled",
            caret: "hide",
            scale: "css",
        });
    });
}
