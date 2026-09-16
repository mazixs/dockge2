import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "../backend/child-process";
import { Database } from "../backend/database";
import { Settings } from "../backend/settings";
import { countUsers, initAuth } from "../backend/auth";
import { ATTENTION, RUNNING } from "../common/util-common";

/**
 * Живой экземпляр для приемки интерфейса: настоящий бэкенд, настоящий Docker,
 * настоящие файлы стеков.
 *
 * Тестовая сцена (`test/visual/`) отвечает заготовками и врет в обе стороны: может
 * показать поломку там, где ее нет, и скрыть настоящую. Здесь все по-честному,
 * поэтому набор стеков подобран под крайние случаи разметки: длинное имя, много
 * env-файлов, упавший контейнер, остановленный стек.
 *
 * Каталоги лежат внутри проекта в `.tmp/review` (он в .gitignore) и очищаются при
 * каждом запуске. Боевые `./data` и `/opt/stacks` скрипт не трогает.
 *
 *   npx tsx extra/seed-review.ts
 *   DOCKGE_DATA_DIR=<repo>/.tmp/review/data DOCKGE_STACKS_DIR=<repo>/.tmp/review/stacks npm run dev
 */

const projectRoot = path.resolve(import.meta.dirname, "..");
const reviewRoot = path.join(projectRoot, ".tmp", "review");
const dataDir = process.env.DOCKGE_REVIEW_DATA_DIR ?? path.join(reviewRoot, "data");
const stacksDir = process.env.DOCKGE_REVIEW_STACKS_DIR ?? path.join(reviewRoot, "stacks");

/** Имена проектов Docker: ими же скрипт потом убирает за собой и чужого не трогает */
const RUNNING_STACK = "paperless";
const FILES_STACK = "docs-and-wiki";
const FAILING_STACK = "uptime-kuma";
const LONG_NAME_STACK = "home-automation-and-sensors-long-name";

/** Образы берутся только те, что уже есть локально: приемка не должна ждать загрузку */
const files : Record<string, Record<string, string>> = {
    // Обычный стек: три сервиса, значения подставляются из env-файла
    [RUNNING_STACK]: {
        "compose.yaml": `# Документы: веб, очередь и база
services:
  web:
    image: nginx:alpine
    ports:
      - "\${PAPERLESS_PORT}:80"
  broker:
    image: redis:8
    command: ["redis-server", "--save", ""]
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
`,
        ".env": `# Порты и пути тома задаются здесь, compose подставляет их в YAML
PAPERLESS_PORT=8730
POSTGRES_USER=paperless
POSTGRES_PASSWORD=review-only
`,
    },

    // Экран файлов на пределе: несколько compose, пять env-файлов и секрет
    [FILES_STACK]: {
        "compose.yaml": "services:\n  app:\n    image: nginx:alpine\n",
        "compose.prod.yaml": "services:\n  app:\n    image: nginx:alpine\n",
        "staging.yml": "services:\n  app:\n    image: nginx:alpine\n",
        ".env": "STAGE=base\n",
        ".env.dev": "STAGE=dev\n",
        ".env.prod": "STAGE=prod\n",
        // Длинное имя в разрешенных знаках: список имен файлов - только ASCII,
        // русское имя панель честно отбросила бы как небезопасное
        ".env-staging-eu-west-frankfurt-cluster-blue": "STAGE=long\n",
        "staging.env": "STAGE=staging\n",
        ".secret.db": "review-only-secret\n",
    },

    // Упавший стек: контейнер выходит с ошибкой сразу, экран должен это показать
    [FAILING_STACK]: {
        "compose.yaml": `services:
  kuma:
    image: alpine:3.20
    command: ["sh", "-c", "echo 'cannot bind to port 3001' >&2; exit 1"]
    restart: "no"
`,
    },

    // Длинное имя: список слева, шапка стека, таблица общего обзора и телефон
    [LONG_NAME_STACK]: {
        "compose.yaml": "services:\n  hub:\n    image: alpine:3.20\n    command: [\"sleep\", \"900\"]\n",
    },
};

/**
 * Разложить файлы стеков, завести владельца и поднять контейнеры
 * @returns {Promise<void>}
 */
async function seed() : Promise<void> {
    await rm(reviewRoot, { recursive: true,
        force: true });
    await mkdir(dataDir, { recursive: true });

    for (const [ stackName, stackFiles ] of Object.entries(files)) {
        await mkdir(path.join(stacksDir, stackName), { recursive: true });

        for (const [ fileName, content ] of Object.entries(stackFiles)) {
            await writeFile(path.join(stacksDir, stackName, fileName), content, { mode: fileName.startsWith(".secret") ? 0o600 : 0o644 });
        }
    }

    await Database.init({ config: { dataDir,
        stacksDir } } as never);

    // Владелец заводится тем же обработчиком, что и в интерфейсе, а потом вход
    // выключается настройкой: пароль нужен только чтобы учетная запись была
    const auth = await initAuth({ config: { dataDir,
        stacksDir,
        port: 5001 },
    isSSL: () => undefined,
    getBaseURL: () => "http://localhost:5001" } as never);

    if (await countUsers() === 0) {
        const response = await auth.handler(new Request("http://localhost:5001/api/auth/bootstrap", {
            method: "POST",
            headers: { "content-type": "application/json",
                origin: "http://localhost:5001" },
            body: JSON.stringify({
                token: (await readFile(path.join(dataDir, "bootstrap-token"), "utf8")).trim(),
                username: "review.owner",
                email: "review-owner@example.com",
                password: crypto.randomUUID(),
                name: "Владелец приемки",
            }),
        }));

        if (!response.ok) {
            throw new Error(`Не удалось завести учетную запись приемки: ${response.status}`);
        }
    }

    // Вход выключен: экземпляр локальный и одноразовый, а вводить пароль в браузере
    // ради снимка экрана незачем. Экран входа проверяется отдельно, включением обратно.
    // Тип "general" обязателен: раздел безопасности читает настройки именно этого
    // типа, и без него экран показывал бы "Отключить аутентификацию" при уже
    // выключенном входе - вместе с формой пароля, которая ничего не меняет
    await Settings.set("disableAuth", true, "general");

    // История состояний, иначе доступность честно молчит и полосу не на чем смотреть
    const now = Date.now();
    const hour = 3_600_000;

    await Database.getKnex()("stack_observation").insert([
        { stack_name: RUNNING_STACK,
            endpoint: "",
            status: RUNNING,
            observed_at: now - 72 * hour,
            observed_until: now },
        { stack_name: FAILING_STACK,
            endpoint: "",
            status: RUNNING,
            observed_at: now - 48 * hour,
            observed_until: now - 3 * hour },
        { stack_name: FAILING_STACK,
            endpoint: "",
            status: ATTENTION,
            observed_at: now - 3 * hour,
            observed_until: now },
    ]);

    Settings.stopCacheCleaner();
    await Database.close();

    // Поднимаются только те стеки, у которых на экране должно быть состояние.
    // Длинное имя остается остановленным: так в списке есть все три вида строк
    for (const stackName of [ RUNNING_STACK, FILES_STACK, FAILING_STACK ]) {
        await spawn("docker", [ "compose", "-p", stackName, "-f", path.join(stacksDir, stackName, "compose.yaml"), "up", "-d" ], {
            encoding: "utf-8",
            maxBuffer: 4 * 1024 * 1024,
            timeoutMs: 300_000,
        }).catch((e) => {
            // Упавший стек падает по замыслу: сообщение об этом не должно валить сид
            console.log(`Стек ${stackName} не поднялся: ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    console.log(`Каталог данных:  ${dataDir}`);
    console.log(`Каталог стеков:  ${stacksDir}`);
    console.log("Запуск:          DOCKGE_DATA_DIR=... DOCKGE_STACKS_DIR=... npm run dev");
}

await seed();
