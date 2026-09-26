import { defineConfig, devices } from "@playwright/test";

/**
 * Эталонные снимки интерфейса.
 *
 * Снимки делаются не с живого сервера, а с воспроизводимой сцены (`test/visual/scene.ts`):
 * у нее нет ни Docker, ни сети, ни часов сервера, поэтому одна и та же ревизия дает
 * один и тот же кадр. Настоящие E2E живут отдельно в `playwright.config.ts` - там нужен
 * Docker, и держать их в одном запуске с приемкой вида значило бы ронять приемку
 * по причинам, к виду отношения не имеющим.
 *
 * Эталон - решение, а не побочный результат запуска: при расхождении тест падает и
 * показывает разницу, а переутверждение делается отдельной командой и осознанно.
 *
 *   npm run test:visual             # сверить с эталоном
 *   npm run test:visual:approve     # переутвердить эталон (только когда вид изменен намеренно)
 */
export default defineConfig({
    testDir: "./test/visual",
    testMatch: /.*\.spec\.ts$/,
    timeout: 60_000,
    expect: {
        timeout: 15_000,
    },
    fullyParallel: true,
    // В CI - один рабочий процесс, иначе параллельные снимки делят одну машину и
    // отличаются от эталона по времени отрисовки. Локально число выбирает Playwright,
    // поэтому ключ не задается вовсе, а не задается в undefined
    ...(process.env.CI ? { workers: 1 } : {}),
    retries: 0,
    reporter: process.env.CI ? [[ "list" ], [ "github" ]] : [[ "list" ]],

    // Эталоны лежат рядом со сценой и коммитятся: снимок без истории нечем сравнивать
    snapshotPathTemplate: "{testDir}/baseline/{projectName}/{arg}{ext}",

    use: {
        baseURL: "http://localhost:5090",
        // Время проверки на сцене выводится в поясе браузера: без явного пояса снимок
        // зависел бы от машины, на которой его сняли
        timezoneId: "UTC",
        trace: "retain-on-failure",
    },

    // Тема и ширина - не настройка теста, а отдельный прогон: у каждого свой эталон.
    // Светлая и темная расходятся не только цветом, узкая ширина - другая раскладка
    projects: [
        {
            name: "desktop-light",
            use: { ...devices["Desktop Chrome"],
                channel: "chromium",
                viewport: { width: 1280,
                    height: 900 },
                colorScheme: "light" },
        },
        {
            name: "desktop-dark",
            use: { ...devices["Desktop Chrome"],
                channel: "chromium",
                viewport: { width: 1280,
                    height: 900 },
                colorScheme: "dark" },
        },
        {
            name: "phone-light",
            use: { ...devices["Desktop Chrome"],
                channel: "chromium",
                // Масштаб 1, а не 3: эталон проверяет раскладку, а тройная плотность
                // дала бы в девять раз больший файл ради тех же расхождений
                viewport: { width: 390,
                    height: 844 },
                isMobile: true,
                hasTouch: true,
                colorScheme: "light" },
        },
        {
            name: "phone-dark",
            use: { ...devices["Desktop Chrome"],
                channel: "chromium",
                viewport: { width: 390,
                    height: 844 },
                isMobile: true,
                hasTouch: true,
                colorScheme: "dark" },
        },
    ],

    webServer: {
        command: "vite --config ./test/visual/vite.config.ts",
        url: "http://localhost:5090",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
