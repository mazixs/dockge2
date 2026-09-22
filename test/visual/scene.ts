import { createApp, h } from "vue";
import { createRouter, createWebHistory, RouterView } from "vue-router";
import "bootstrap/js/dist/dropdown";
import "@xterm/xterm/css/xterm.css";
import "../../frontend/src/styles/main.scss";
import { ellipsisTitle } from "../../frontend/src/directives/ellipsis-title";
import Layout from "../../frontend/src/layouts/Layout.vue";
import Dashboard from "../../frontend/src/pages/Dashboard.vue";
import StackInspector from "../../frontend/src/pages/StackInspector.vue";
import NewStack from "../../frontend/src/pages/NewStack.vue";
import StackGitChanges from "../../frontend/src/pages/StackGitChanges.vue";
import Settings from "../../frontend/src/pages/Settings.vue";
import Appearance from "../../frontend/src/components/settings/Appearance.vue";
import General from "../../frontend/src/components/settings/General.vue";
import Security from "../../frontend/src/components/settings/Security.vue";
import Users from "../../frontend/src/components/settings/Users.vue";
import Agents from "../../frontend/src/components/settings/Agents.vue";
import GlobalEnv from "../../frontend/src/components/settings/GlobalEnv.vue";
import About from "../../frontend/src/components/settings/About.vue";
import Mcp from "../../frontend/src/components/settings/Mcp.vue";
import StabilityDashboard from "../../frontend/src/components/StabilityDashboard.vue";
import Console from "../../frontend/src/pages/Console.vue";
import Login from "../../frontend/src/components/Login.vue";
import Setup from "../../frontend/src/pages/Setup.vue";
import { FontAwesomeIcon } from "../../frontend/src/icon";
import ru from "../../frontend/src/lang/ru.json";
import { i18n } from "../../frontend/src/i18n";
import responsive from "../../frontend/src/mixins/responsive";
import theme from "../../frontend/src/mixins/theme";
import { ATTENTION, CREATED_STACK, EXITED, RUNNING, getComposeTerminalName } from "../../common/util-common";

// Screenshot content must not change when the real release version is bumped.
const sceneVersion = "0.0.7";

// Deliberately disconnected fixture data. This module never imports the socket mixin,
// contacts a backend, writes files, or controls containers. Production components render it.
const compose = `services:
  web:
    image: ghcr.io/paperless-ngx/paperless-ngx:2.14
    ports:
      - "8010:8000"
  broker:
    image: redis:7-alpine
  db:
    image: postgres:16-alpine
`;
// Время последней проверки задано относительно замороженных часов спеки:
// иначе "проверено N назад" менялось бы на каждом прогоне
const CHECKED_AT = new Date("2026-09-15T09:00:00Z").getTime();
const source = { kind: "git",
    remote: "https://github.com/homelab/paperless.git",
    branch: "main",
    commit: "7a82b919f2c1ad00000000000000000000000000000",
    dirty: true,
    behind: 1,
    changedFiles: 3,
    checkedAt: CHECKED_AT };
const names = [ "paperless", "immich", "uptime-kuma", "vaultwarden", "jellyfin" ];
const stacks = Object.fromEntries(names.map((name, index) => [ `${name}_`, {
    name,
    endpoint: "",
    isManagedByDockge: true,
    // Настоящий сервер отдает имя файла вместе со стеком: без него шапка
    // карточки файла оказалась бы безымянной только в сцене
    composeFileName: "compose.yaml",
    // Пять состояний стека, по одному на каждое: эталон обязан показывать и то,
    // которое требует внимания, - иначе ни чип, ни полоса внимания над обзором
    // ни на одном снимке не видны
    status: index === 4 ? CREATED_STACK : index === 2 ? EXITED : index === 1 ? ATTENTION : RUNNING,
    issues: index === 1 ? [{ service: "web",
        reason: "unhealthy",
        detail: "" }] : [],
    dir: `/opt/stacks/${name}`,
    // Стек из Git, который ни разу не сверяли, - отдельное состояние: ноль
    // коммитов отставания здесь означает, что origin никто не спрашивал
    source: index === 0 ? source : index === 3 ? { ...source,
        remote: "https://github.com/homelab/vaultwarden.git",
        dirty: false,
        changedFiles: 0,
        behind: 0,
        checkedAt: null } : { kind: "local" },
    services: [ "web", "broker", "db" ].map((service, serviceIndex) => ({ name: service,
        state: index === 4 ? "stopped" : index === 2 ? "failed" : index === 1 && serviceIndex === 0 ? "attention" : "running" })),
}]));
const preview = { id: "visual-preview",
    branch: "main",
    currentCommit: source.commit,
    targetCommit: "8be342100000000000000000000000000000000000",
    files: [{ path: "compose.yaml",
        status: "modified",
        serverText: compose,
        gitText: compose.replace("2.14", "2.15").replace("8010:8000", "8000:8000"),
        redacted: false,
        binary: false }, { path: ".env",
        status: "modified",
        serverText: null,
        gitText: null,
        redacted: true,
        binary: false }, { path: "README.md",
        status: "modified",
        serverText: "Local deployment notes\n",
        gitText: "Updated deployment notes\n",
        redacted: false,
        binary: false }] };
// Which files the editor shows: the selection only, contents stay in the texts above
const inventory = { config: { composeFileName: "compose.yaml",
    envFileNames: [ ".env" ],
    activeEnvFileName: ".env",
    secretBindings: [{ name: "db_password",
        fileName: ".secret.db",
        services: [ "db" ] }] },
composeFileNames: [ "compose.yaml", "compose.prod.yaml" ],
envFileNames: [ ".env", ".env.dev" ],
secretFiles: [{ fileName: ".secret.db",
    secretName: "db_password",
    size: 41,
    modifiedAt: "2026-09-02T11:24:00.000Z",
    services: [ "db" ] }],
needsComposeSelection: false,
// Файл, чье имя список имен не принимает: на сцене он нужен, чтобы в эталоне
// был виден блок, объясняющий, почему файл с диска не попал ни в один выбор
unsupportedFileNames: [ "настройки.env" ] };

// Текст каждого env-файла: панель env читается и без режима правки, поэтому пустая
// строка скрывала бы половину экрана файлов. Текст держим по именам, иначе заведенный
// файл открывался бы с чужим содержимым и проверить выбор активного файла было бы нечем
const envTexts : Record<string, string> = {
    ".env": `# Порты и пути тома задаются здесь, compose подставляет их в YAML
PAPERLESS_PORT=8000
PAPERLESS_DATA=/srv/paperless/data
POSTGRES_USER=paperless
`,
    ".env.dev": `PAPERLESS_PORT=8010
PAPERLESS_DATA=./data
`,
};

// The journal tab is part of the design, so the fixture feeds it text instead of a PTY.
// Nothing here runs a command: written lines are canned and typed keys are echoed back.
interface SceneTerminal { write(data : string) : void }
const terminals = new Map<string, SceneTerminal>();
const shellBuffers = new Map<string, string>();
const DIM = "[2m";
const GREEN = "[32m";
const BLUE = "[34m";
const RED = "[31m";
const OFF = "[0m";
const logLines = [
    `${DIM}paperless-web  |${OFF} [init] paperless-ngx 2.14 starting`,
    `${DIM}paperless-db   |${OFF} database system is ready to accept connections`,
    `${DIM}paperless-brok |${OFF} Ready to accept connections tcp`,
    `${DIM}paperless-web  |${OFF} Waiting for PostgreSQL to start...`,
    `${DIM}paperless-web  |${OFF} Applying migrations: no migrations to apply`,
    `${DIM}paperless-web  |${OFF} Listening at: http://0.0.0.0:8000`,
    `${DIM}paperless-web  |${OFF} GET /api/documents/?page=1 200 12ms`,
    `${DIM}paperless-web  |${OFF} GET /api/statistics/ 200 4ms`,
    `${GREEN}Тестовая сцена: вывод записан заранее, контейнеры не запускались.${OFF}`,
];
const shellFiles = "compose.yaml  .env  README.md";

// Ход команды: сцена печатает то же, что печатает docker compose, и так же,
// как он, - перерисовывая свой блок на месте. Ни одна команда при этом не
// выполняется: панель хода разбирает этот текст в шаги.
const SPINNER = [ "\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834" ];

/**
 * Строка ресурса в блоке compose
 * @param {string} mark Знак в начале строки: вертушка, галочка или крест
 * @param {string} label Вид ресурса и его имя
 * @param {string} verb Что с ним происходит
 * @param {string} seconds Сколько заняло
 * @returns {string} Строка, как ее печатает compose
 */
function composeRow(mark : string, label : string, verb : string, seconds : string) : string {
    return ` ${mark} ${label.padEnd(32)} ${verb.padEnd(10)} ${DIM}${seconds}${OFF}`;
}

const spin = (index : number) => `${BLUE}${SPINNER[index % SPINNER.length]}${OFF}`;
const okMark = `${GREEN}\u2714${OFF}`;
const failMark = `${RED}\u2718${OFF}`;

/**
 * Кадры удачного запуска стека
 * @param {string} stack Имя стека
 * @returns {string[][]} Блок за блоком, как его перерисовывает compose
 */
function startFrames(stack : string) : string[][] {
    const net = `Network ${stack}_default`;
    return [
        [ "[+] Running 0/4", composeRow(spin(0), net, "Creating", "0.1s") ],
        [ "[+] Running 1/4",
            composeRow(okMark, net, "Created", "0.2s"),
            composeRow(spin(1), `Container ${stack}-db`, "Creating", "0.1s"),
            composeRow(spin(1), `Container ${stack}-broker`, "Creating", "0.1s") ],
        [ "[+] Running 1/4",
            composeRow(okMark, net, "Created", "0.2s"),
            composeRow(spin(2), `Container ${stack}-db`, "Starting", "0.6s"),
            composeRow(spin(2), `Container ${stack}-broker`, "Starting", "0.5s") ],
        [ "[+] Running 3/4",
            composeRow(okMark, net, "Created", "0.2s"),
            composeRow(okMark, `Container ${stack}-db`, "Started", "0.9s"),
            composeRow(okMark, `Container ${stack}-broker`, "Started", "1.0s"),
            composeRow(spin(3), `Container ${stack}-web`, "Starting", "0.4s") ],
        [ "[+] Running 4/4",
            composeRow(okMark, net, "Created", "0.2s"),
            composeRow(okMark, `Container ${stack}-db`, "Started", "0.9s"),
            composeRow(okMark, `Container ${stack}-broker`, "Started", "1.0s"),
            composeRow(okMark, `Container ${stack}-web`, "Started", "1.2s") ],
    ];
}

/**
 * Кадры остановки стека
 * @param {string} stack Имя стека
 * @returns {string[][]} Блок за блоком
 */
function stopFrames(stack : string) : string[][] {
    const net = `Network ${stack}_default`;
    return [
        [ "[+] Running 0/4",
            composeRow(spin(0), `Container ${stack}-web`, "Stopping", "0.2s"),
            composeRow(spin(0), `Container ${stack}-broker`, "Stopping", "0.2s"),
            composeRow(spin(0), `Container ${stack}-db`, "Stopping", "0.2s") ],
        [ "[+] Running 3/4",
            composeRow(okMark, `Container ${stack}-web`, "Removed", "0.6s"),
            composeRow(okMark, `Container ${stack}-broker`, "Removed", "0.4s"),
            composeRow(okMark, `Container ${stack}-db`, "Removed", "0.5s"),
            composeRow(spin(2), net, "Removing", "0.1s") ],
        [ "[+] Running 4/4",
            composeRow(okMark, `Container ${stack}-web`, "Removed", "0.6s"),
            composeRow(okMark, `Container ${stack}-broker`, "Removed", "0.4s"),
            composeRow(okMark, `Container ${stack}-db`, "Removed", "0.5s"),
            composeRow(okMark, net, "Removed", "0.1s") ],
    ];
}

/**
 * Кадры неудачи: порт занят, контейнер не поднялся. Нужны, чтобы видеть
 * красную строку хода и строку сервиса, которая называет ошибку словом
 * @param {string} stack Имя стека
 * @returns {string[][]} Блок за блоком
 */
function failFrames(stack : string) : string[][] {
    const net = `Network ${stack}_default`;
    return [
        [ "[+] Running 0/2", composeRow(spin(0), net, "Creating", "0.1s") ],
        [ "[+] Running 1/2",
            composeRow(okMark, net, "Created", "0.2s"),
            composeRow(spin(1), `Container ${stack}-web`, "Creating", "0.3s") ],
        [ "[+] Running 1/2",
            composeRow(okMark, net, "Created", "0.2s"),
            composeRow(failMark, `Container ${stack}-web`, "Error", "0.8s") ],
    ];
}

const failTail = [
    "Error response from daemon: driver failed programming external connectivity",
    "on endpoint uptime-kuma: Bind for 0.0.0.0:3001 failed: port is already allocated",
];

/**
 * Play the canned compose block frame by frame
 * @param {string} name Progress terminal name
 * @param {string[][]} frames Frames of the compose block
 * @param {string[]} tail Plain lines printed after the block
 * @param {Function} done Called when the last frame is written
 * @returns {void}
 */
function playProgress(name : string, frames : string[][], tail : string[], done : () => void) {
    const terminal = terminals.get(name);
    if (!terminal) {
        done();
        return;
    }
    let printed = 0;
    frames.forEach((frame, index) => {
        setTimeout(() => {
            // Курсор поднимается на высоту прошлого кадра и стирает его:
            // так compose и перерисовывает свой блок, не повторяя строк
            const rewind = printed > 0 ? `\u001B[${printed}A\u001B[0J` : "";
            terminal.write(`${rewind}${frame.join("\r\n")}\r\n`);
            printed = frame.length;
            if (index === frames.length - 1) {
                if (tail.length > 0) {
                    terminal.write(`${tail.join("\r\n")}\r\n`);
                }
                done();
            }
        }, 550 * (index + 1));
    });
}

/**
 * Prompt of the fake container shell
 * @param {string} name Terminal name the session panel generated
 * @returns {string} Prompt line
 */
function shellPrompt(name : string) : string {
    const service = name.split("-")[4] ?? "web";
    return `${BLUE}root@${service}${OFF}:${BLUE}/usr/src/paperless${OFF}# `;
}

/**
 * Answer of the fake shell: a few real-looking commands, everything else refused
 * @param {string} command What the person typed
 * @returns {string} Lines to write back
 */
function shellAnswer(command : string) : string {
    const trimmed = command.trim();
    if (trimmed === "") {
        return "";
    }
    if (trimmed === "ls") {
        return `${shellFiles}\r\n`;
    }
    if (trimmed === "pwd") {
        return "/usr/src/paperless\r\n";
    }
    if (trimmed === "whoami") {
        return "root\r\n";
    }
    if (trimmed === "env") {
        return "PAPERLESS_PORT=8000\r\nPAPERLESS_TIME_ZONE=Europe/Amsterdam\r\n";
    }
    if (trimmed === "help") {
        return `${DIM}Сцена отвечает на ls, pwd, whoami, env. Остальное не выполняется.${OFF}\r\n`;
    }
    return `${DIM}${trimmed}: сцена без Docker, команда не выполнялась${OFF}\r\n`;
}

const router = createRouter({ history: createWebHistory(),
    routes: [{ path: "/",
        component: Layout,
        children: [{ path: "",
            component: Dashboard,
            children: [{ path: "",
                name: "DashboardHome",
                component: StabilityDashboard }, { path: "/stack/:stackName/git",
                component: StackGitChanges }, { path: "/stack/:stackName/files",
                component: StackInspector,
                name: "stackFiles" }, { path: "/stack/:stackName/logs",
                component: StackInspector,
                name: "stackLogs" }, { path: "/stack/:stackName/terminal",
                component: StackInspector,
                name: "stackTerminal" }, { path: "/stack/:stackName",
                component: StackInspector,
                name: "stackInspector" }, { path: "/new",
                component: NewStack }, { path: "/console",
                component: Console }, {
                path: "/settings",
                component: Settings,
                children: [{ path: "appearance",
                    component: Appearance }, { path: "mcp",
                    component: Mcp }, { path: "general",
                    component: General }, { path: "security",
                    component: Security }, { path: "users",
                    component: Users }, { path: "agents",
                    component: Agents }, { path: "globalEnv",
                    component: GlobalEnv }, { path: "about",
                    component: About }],
            }] },
        // Вход и первый запуск стоят рядом с рабочей областью, а не внутри нее:
        // в приложении на этих экранах нет ни рейки со стеками, ни их списка -
        // человек еще не назвал себя, и показывать ему чужое хозяйство нечего
        { path: "/login",
            component: Login },
        { path: "/setup",
            component: Setup }] }] });
/**
 * Ответы поддельного сокета. Сцена не ходит на сервер, поэтому каждое событие
 * отвечает заранее заготовленным результатом того же вида, что и настоящий
 * @param {string} event Имя события
 * @returns {object} Ответ с ack-колбэком
 */
// Экран MCP берет данные не через сокет, а обычным fetch. Сцена подменяет
// только этот адрес: остальные запросы уходят как есть
const mcpOverview = { peers: [],
    pending: [{ operation_id: "op-1",
        action: "stack_restart",
        server_id: "local",
        stack_id: "paperless" }],
    config: { enabled: true,
        url: "https://dockge.local/mcp" },
    keys: [{ id: "k-1",
        name: "Ассистент дежурного",
        role: "operator",
        expires_at: Date.parse("2026-12-01T10:00:00Z"),
        last_used_at: Date.parse("2026-09-14T08:12:00Z"),
        revoked_at: null,
        stacks: JSON.stringify([ "local|paperless", "local|immich" ]) }, { id: "k-2",
        name: "Только чтение",
        role: "viewer",
        expires_at: Date.parse("2026-10-01T10:00:00Z"),
        last_used_at: null,
        revoked_at: null,
        stacks: JSON.stringify([ "local|jellyfin" ]) }],
    stacks: [{ id: "paperless",
        name: "paperless",
        reserved: false }, { id: "immich",
        name: "immich",
        reserved: false }, { id: "jellyfin",
        name: "jellyfin",
        reserved: true }],
    users: [{ id: "1",
        name: "Владелец" }],
    audit: [{ id: 2,
        at: Date.parse("2026-09-14T08:12:00Z"),
        tool: "stack.status",
        outcome: "ok" }, { id: 1,
        at: Date.parse("2026-09-13T21:40:00Z"),
        tool: "stack.restart",
        outcome: "pending" }] };

// Общий обзор: те же поля, что отдает сервер после наблюдений. Сцена держит
// по контейнеру на каждое состояние, чтобы на экране были видны и зеленая
// строка, и деградация, и остановленный, и пропуск в наблюдениях
const HOUR_MS = 3_600_000;

/**
 * Полоса наблюдений: сутки по часу. Плохие часы задаются списком
 * @param {number[]} bad Номера часов, где состояние было не рабочим
 * @param {string} state Состояние в эти часы
 * @param {number} gaps Сколько последних часов остались без наблюдений
 * @returns {object[]} Ведра для полосы
 */
function historyBuckets(bad : number[], state : string, gaps = 0) : object[] {
    const now = Date.now();
    return Array.from({ length: 24 }, (_, index) => {
        const from = now - (24 - index) * HOUR_MS;
        const missing = index >= 24 - gaps;
        return { from,
            to: from + HOUR_MS,
            state: missing ? "unknown" : bad.includes(index) ? state : "running",
            coverage: missing ? 0 : 1 };
    });
}

/**
 * Контейнер в общем обзоре
 * @param {object} shape Имя, сервис, состояние и числа строки
 * @returns {object} Контейнер того же вида, что отдает сервер
 */
function stabilityContainer(shape : Record<string, unknown>) : object {
    return { id: String(shape.name).padEnd(64, "0").replace(/[^a-f0-9]/g, "0"),
        name: shape.name,
        service: shape.service,
        state: shape.state,
        health: shape.health ?? "",
        startedAt: shape.startedAt ?? null,
        restartCount: shape.restartCount ?? 0,
        uptimeMs: shape.uptimeMs ?? null,
        availability: shape.availability,
        history: shape.history };
}

const availabilityClean = { verdict: "clean",
    ratio: 1,
    incidents: 0,
    coveredMs: 24 * HOUR_MS,
    windowMs: 24 * HOUR_MS,
    currentForMs: 3 * 24 * HOUR_MS,
    currentStatus: RUNNING };

const stabilityOverview = { observedAt: Date.now() - 20_000,
    windowHours: 24,
    stale: false,
    error: null,
    stacks: [{ name: "paperless",
        managed: true,
        standalone: false,
        containers: [
            stabilityContainer({ name: "paperless-web",
                service: "web",
                state: "running",
                health: "healthy",
                uptimeMs: 62 * HOUR_MS,
                availability: availabilityClean,
                history: historyBuckets([], "attention") }),
            stabilityContainer({ name: "paperless-db",
                service: "db",
                state: "running",
                health: "healthy",
                uptimeMs: 62 * HOUR_MS,
                availability: availabilityClean,
                history: historyBuckets([], "attention") }),
            stabilityContainer({ name: "paperless-broker",
                service: "broker",
                state: "running",
                health: "",
                uptimeMs: 62 * HOUR_MS,
                availability: { ...availabilityClean,
                    coveredMs: 18 * HOUR_MS },
                history: historyBuckets([], "attention", 6) }),
        ] }, { name: "uptime-kuma",
        managed: true,
        standalone: false,
        containers: [
            stabilityContainer({ name: "uptime-kuma-web",
                service: "web",
                state: "restarting",
                health: "unhealthy",
                restartCount: 7,
                uptimeMs: 4 * 60_000,
                availability: { verdict: "degraded",
                    ratio: 0.938,
                    incidents: 2,
                    coveredMs: 24 * HOUR_MS,
                    windowMs: 24 * HOUR_MS,
                    currentForMs: 4 * 60_000,
                    currentStatus: EXITED },
                history: historyBuckets([ 9, 10, 18 ], "attention") }),
        ] }, { name: "jellyfin",
        managed: true,
        standalone: false,
        containers: [
            stabilityContainer({ name: "jellyfin-web",
                service: "web",
                state: "exited",
                health: "",
                availability: { verdict: "stopped",
                    ratio: null,
                    incidents: 0,
                    coveredMs: 24 * HOUR_MS,
                    windowMs: 24 * HOUR_MS,
                    currentForMs: 5 * 24 * HOUR_MS,
                    currentStatus: EXITED },
                history: historyBuckets([ ...Array(24).keys() ], "stopped") }),
        ] }] };

const originalFetch = window.fetch.bind(window);

window.fetch = ((input : RequestInfo | URL, init? : RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);

    if (url.includes("/api/mcp")) {
        return Promise.resolve(new Response(JSON.stringify(mcpOverview), { status: 200,
            headers: { "content-type": "application/json" } }));
    }

    return originalFetch(input as RequestInfo, init);
}) as typeof window.fetch;

/** Whether this shot wants the panel to have found a newer release */
const updateScene = new URLSearchParams(window.location.search).get("update") === "available";

function socketAnswer(event : string) : object {
    if (event === "getSettings") {
        return { ok: true,
            data: { checkUpdate: true,
                checkBeta: false,
                primaryHostname: "dockge.local",
                globalENV: "TZ=Europe/Amsterdam\nPUID=1000\nPGID=1000\n" } };
    }
    if (event === "needsSetup") {
        return { ok: true,
            needsSetup: true };
    }
    if (event === "usersList") {
        return { ok: true,
            users: [{ id: "1",
                name: "Владелец",
                username: "owner",
                email: "owner@example.com",
                role: "admin",
                suspended: false }, { id: "2",
                name: "Дежурный",
                username: "duty",
                email: "duty@example.com",
                role: "operator",
                suspended: false }, { id: "3",
                name: "Аудит",
                username: "audit",
                email: "audit@example.com",
                role: "viewer",
                suspended: true }] };
    }
    return { ok: true,
        msg: "Сцена без сервера: сохранения не произошло" };
}

/**
 * Поддельный сокет сцены: те же вызовы, что у socket.io, но без соединения
 * @param {boolean} withError Колбэк ждет ошибку первым аргументом, как после .timeout()
 * @returns {object} Объект с emit и timeout
 */
function fakeSocket(withError = false) : object {
    return {
        timeout() {
            return fakeSocket(true);
        },
        emitWithAck(event : string) {
            return new Promise(resolve => setTimeout(() => resolve(socketAnswer(event)), 80));
        },
        emit(event : string, ...args : unknown[]) {
            const callback = args.at(-1);
            if (typeof callback !== "function") {
                return;
            }
            const answer = socketAnswer(event);
            setTimeout(() => (withError ? callback(null, answer) : callback(answer)), 80);
        },
    };
}

const scene = createApp({
    mixins: [ responsive, theme ],
    data() {
        return { appReady: true,
            // Fixed fixture versions keep screenshots independent of release bumps.
            info: { primaryHostname: "localhost",
                version: sceneVersion,
                // The panel's own update is news on one screen only, and the address
                // says which shot wants it: handing it to every screen would put the
                // badge in the header of every reference shot there is
                latestVersion: updateScene ? "9.9.9" : sceneVersion,
                updateAvailable: updateScene },
            frontendVersion: sceneVersion,
            isFrontendBackendVersionMatched: true,
            loggedIn: true,
            canManageStacks: true,
            isAdmin: true,
            authDisabled: true,
            userID: "1",
            language: "ru",
            username: "Visual fixture",
            usernameFirstChar: "D",
            completeStackList: stacks,
            agentList: { "": { name: "Домашний сервер",
                endpoint: "" } },
            agentStatusList: { "": "online" },
            agentCount: 1,
            selectedEndpoint: "",
            socketIO: { connected: true,
                firstConnect: false },
            createStackSeed: "",
            composeTemplate: "",
            envTemplate: "" };
    },
    methods: {
        getSocket() {
            return fakeSocket();
        },
        endpointDisplayFunction() {
            return "Домашний сервер";
        },
        toastRes() { /* Deliberately no production side effects. */ },
        toastError() { /* Deliberately no production side effects. */ },
        toastSuccess() { /* Deliberately no production side effects. */ },

        /**
         * The session panel hands its xterm instance over; the fixture writes canned text into it
         * @param {string} _endpoint Ignored: the scene has one server
         * @param {string} name Terminal name generated by the session panel
         * @param {object} terminal xterm instance
         * @returns {void}
         */
        bindTerminal(_endpoint : string, name : string, terminal : SceneTerminal) {
            terminals.set(name, terminal);
            if (name.startsWith("combined-")) {
                terminal.write(`${logLines.join("\r\n")}\r\n`);
                return;
            }
            if (name.startsWith("container-exec-")) {
                shellBuffers.set(name, "");
                terminal.write(`${DIM}Тестовая сцена: оболочка не подключена к контейнеру.${OFF}\r\n${shellPrompt(name)}`);
            }
        },

        /**
         * @param {string} name Terminal name
         * @returns {void}
         */
        unbindTerminal(name : string) {
            terminals.delete(name);
            shellBuffers.delete(name);
        },

        /**
         * Echo what was typed into the fake shell and answer the few commands it knows.
         * @param {string} terminalName Terminal the keys were typed into
         * @param {string} data Keys that were typed
         * @returns {void}
         */
        typeIntoShell(terminalName : string, data : string) {
            const terminal = terminals.get(terminalName);

            if (!terminal) {
                return;
            }

            let buffer = shellBuffers.get(terminalName) ?? "";
            for (const character of data) {
                if (character === "\r") {
                    terminal.write(`\r\n${shellAnswer(buffer)}${shellPrompt(terminalName)}`);
                    buffer = "";
                } else if (character === "") {
                    if (buffer.length > 0) {
                        buffer = buffer.slice(0, -1);
                        terminal.write("\b \b");
                    }
                } else {
                    buffer += character;
                    terminal.write(character);
                }
            }
            shellBuffers.set(terminalName, buffer);
        },

        /**
         * Play the canned output of a stack or service command.
         *
         * Only the text is played; no container is touched.
         * @param {string} event Command of the agent protocol
         * @param {string} name Stack the command was sent to
         * @param {Function} callback Acknowledgement of that command
         * @returns {void}
         */
        playCommand(event : string, name : string, callback : (result : unknown) => void) {
            // Only the canned text is written; no container is touched.
            // uptime-kuma всегда падает: на нем видно красную панель и вывод,
            // который раскрывается сам
            const stopping = [ "stopStack", "downStack", "stopService" ].includes(event);
            const failing = name === "uptime-kuma";
            const frames = failing ? failFrames(name) : stopping ? stopFrames(name) : startFrames(name);
            playProgress(getComposeTerminalName("", name), frames, failing ? failTail : [], () => callback(failing
                ? { ok: false,
                    msg: "Тестовая сцена: команда не выполнялась, ответ подделан" }
                : { ok: true,
                    msg: "Тестовая сцена: команда не выполнялась" }));
        },

        /**
         * Answer one read of the fixture.
         * @param {string} event Event of the agent protocol
         * @param {string} name Stack the event was sent to
         * @param {Array} args Arguments of that event
         * @returns {unknown} What the fixture answers
         */
        agentAnswer(event : string, name : string, args : unknown[]) : unknown {
            const stack = stacks[`${name}_`] ?? stacks.paperless_;

            if (event === "getStack") {
                return { ok: true,
                    stack: { ...stack,
                        composeYAML: compose,
                        composeENV: envTexts[inventory.config.activeEnvFileName] ?? "" } };
            } else if (event === "serviceStatusList") {
                return { ok: true,
                    // Имя контейнера настоящее: по нему строка сервиса находит
                    // свой шаг в выводе compose
                    serviceStatusList: Object.fromEntries([ "web", "broker", "db" ].map(service => [ service, [{ name: `${name}-${service}`,
                        state: stack?.status === RUNNING ? "running" : "exited" }]])) };
            } else if (event === "stabilityOverview") {
                return { ok: true,
                    overview: { ...stabilityOverview,
                        windowHours: Number(args[0]) } };
            } else if (event === "stackAvailability") {
                return { ok: true,
                    availability: { verdict: "clean",
                        ratio: 1,
                        coveredMs: 86_400_000,
                        windowMs: 86_400_000,
                        incidents: 0 } };
            } else if (event === "gitPreviewUpdate") {
                return { ok: true,
                    preview };
            } else if (event === "dockerStats") {
                return { ok: true,
                    dockerStats: {} };
            } else if (event === "getStackFiles") {
                // Копия, а не тот же объект: по настоящему сокету инвентарь приходит
                // разобранным из JSON, и страница видит новую ссылку. Отдавая одну и ту
                // же, заготовка молча гасила бы перерисовку после заведения файла
                return { ok: true,
                    inventory: structuredClone(inventory) };
            } else if (event === "setStackFiles") {
                // Выбор запоминается: иначе кнопка сохранения оставалась бы нажатой
                // навсегда, а форма заведения файла - закрытой своей же защитой
                inventory.config = structuredClone(args[1] as typeof inventory.config);
                return { ok: true,
                    msg: "Тестовая сцена: на диск ничего не писалось" };
            } else if (event === "saveEnvFile") {
                // Файл заводится только в заготовке: на диск сцена не пишет, но список
                // обновляется, иначе новую строку в выборе файлов было бы не увидеть
                const fileName = String(args[1]);
                envTexts[fileName] = String(args[2]);
                if (!inventory.envFileNames.includes(fileName)) {
                    inventory.envFileNames.push(fileName);
                }
                return { ok: true,
                    msg: "Тестовая сцена: файл не создавался" };
            } else if ([ "interactiveTerminal", "terminalLeave", "terminalInput", "mainTerminal", "joinCombinedTerminal", "leaveCombinedTerminal" ].includes(event)) {
                // Accepted so the journal tab opens; nothing is executed
                return { ok: true };
            } else {
                return { ok: false,
                    msg: "Visual fixture: operations are disabled" };
            }
        },

        emitAgent(_endpoint : string, event : string, ...args : unknown[]) {
            // Typing into the fake shell: the fixture echoes the keys and answers a few commands
            if (event === "terminalInput") {
                this.typeIntoShell(String(args[0]), String(args[1]));
            }

            const callback = args.at(-1) as (result : unknown) => void;
            if (typeof callback !== "function") {
                return;
            }

            const name = String(args[0]);

            // Keep creation pending so its layout can be inspected without Docker.
            if (event === "deployStack") {
                return;
            }

            // A command answers when its output has finished playing, a read answers at once
            if ([ "startStack", "stopStack", "restartStack", "updateStack", "downStack", "startService", "stopService", "restartService" ].includes(event)) {
                this.playCommand(event, name, callback);
                return;
            }

            callback(this.agentAnswer(event, name, args));
        },

        /**
         * The same request as above, answered the way the application waits for it.
         *
         * Screens ask an agent through `emitAgentRequest`, which returns a promise and
         * sets a deadline. A fixture that only offers the callback form leaves those
         * screens without an answer, and they render as if the server never replied.
         * @param {string} endpoint Agent the request goes to
         * @param {string} event Event of the agent protocol
         * @param {Array} args Arguments of that event, without the acknowledgement
         * @returns {Promise} The answer of the fixture
         */
        emitAgentRequest(endpoint : string, event : string, args : unknown[] = []) {
            // No deadline here on purpose: the fixture always answers, and a timer would
            // make the same revision produce different frames
            return new Promise((resolve) => {
                this.emitAgent(endpoint, event, ...args, resolve);
            });
        },
    },
    render: () => h("div", [ h("div", { class: "scene-mark",
        style: "position:fixed;bottom:0;right:0;z-index:10000;padding:3px 8px;background:var(--surface-panel);color:var(--text-muted);font-size:11px;pointer-events:none" }, "Тестовая сцена · Docker не подключен"), h(RouterView) ]),
});
// A named fixture label is always visible; the samples cannot masquerade as a live server.
i18n.global.locale.value = "ru";
i18n.global.mergeLocaleMessage("ru", { ...ru,
    thisServer: "Домашний сервер" });
scene.use(router).use(i18n).component("FontAwesomeIcon", FontAwesomeIcon).directive("ellipsis-title", ellipsisTitle).mount("#app");
