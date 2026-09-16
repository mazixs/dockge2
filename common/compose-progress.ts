/**
 * Разбор вывода `docker compose` в шаги, которые можно показать словами.
 *
 * Терминал честен, но черное окно с бегущими строками отталкивает: человек хочет
 * знать, поднялись ли контейнеры, а не читать вывод. Поэтому тот же поток
 * разбирается на ресурсы и их состояния, а сам вывод остается под рукой.
 *
 * Разбор идет по уже отрисованному тексту: compose в TTY перерисовывает свой блок
 * на месте, поэтому один и тот же ресурс встречается много раз. Строки сводятся
 * по ресурсу, и последнее слово о нем побеждает.
 */

export type ComposeTaskState = "working" | "done" | "failed";

export type ComposeTaskKind = "container" | "network" | "volume" | "image";

export interface ComposeTask {
    /** Ресурс: по нему строка обновляется, а не повторяется */
    key : string;
    kind : ComposeTaskKind;
    name : string;
    /** Что с ним происходит; слово для этого подбирает интерфейс */
    verb : string;
    state : ComposeTaskState;
    /** Сколько заняло, в секундах; null пока неизвестно */
    seconds : number | null;
}

export interface ComposeProgress {
    /** Общий этап: running, pulling, building, stopping. Пусто, если не объявлен */
    phase : string;
    /** Сколько шагов готово и сколько всего, по счетчику самого compose */
    done : number;
    total : number;
    tasks : ComposeTask[];
    /** Хотя бы один шаг провалился */
    failed : boolean;
}

/** Глаголы compose и то, что они означают. Незнакомый глагол - не шаг, а обычный вывод */
const VERBS : Record<string, { id : string; state : ComposeTaskState }> = {
    "creating": { id: "creating",
        state: "working" },
    "created": { id: "created",
        state: "done" },
    "recreating": { id: "creating",
        state: "working" },
    "recreated": { id: "created",
        state: "done" },
    "starting": { id: "starting",
        state: "working" },
    "started": { id: "started",
        state: "done" },
    "restarting": { id: "starting",
        state: "working" },
    "stopping": { id: "stopping",
        state: "working" },
    "stopped": { id: "stopped",
        state: "done" },
    "removing": { id: "removing",
        state: "working" },
    "removed": { id: "removed",
        state: "done" },
    "pulling": { id: "pulling",
        state: "working" },
    "pulled": { id: "pulled",
        state: "done" },
    "building": { id: "building",
        state: "working" },
    "built": { id: "built",
        state: "done" },
    "waiting": { id: "waiting",
        state: "working" },
    "healthy": { id: "healthy",
        state: "done" },
    "running": { id: "running",
        state: "done" },
    "exists": { id: "exists",
        state: "done" },
    "skipped": { id: "skipped",
        state: "done" },
    "error": { id: "error",
        state: "failed" },
    "failed": { id: "error",
        state: "failed" },
};

const KINDS : Record<string, ComposeTaskKind> = {
    "container": "container",
    "network": "network",
    "volume": "volume",
    "image": "image",
};

/** Символ в начале строки: галочка и крест говорят об итоге, вертушка - о работе */
const DONE_MARKS = "✔✓";
const FAILED_MARKS = "✘✗";
const WORKING_MARKS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠿⣾⣽⣻⢿⡿⣟⣯⣷-";

// Управляющие последовательности: их печатает любой TTY, а разбору они мешают
const ANSI = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)/g;

const HEADLINE = /^\[\+]\s+([A-Za-z]+)\s+(\d+)\/(\d+)/;

/** Слои образа печатаются своим идентификатором: человеку они ничего не говорят */
const LAYER_ID = /^[0-9a-f]{10,64}$/;

const SECONDS = /^(\d+(?:\.\d+)?)s$/;

/** Одинокий знак перед словами: чужая вертушка, слова начинаются после нее */
const UNKNOWN_MARK = /^[^\p{L}\p{N}\s]\s/u;

/**
 * Разобрать вывод compose в шаги
 * @param output Текст вывода, как его видно на экране
 * @returns Этап, счетчик и шаги в порядке появления
 */
export function parseComposeProgress(output : string) : ComposeProgress {
    const tasks = new Map<string, ComposeTask>();
    let phase = "";
    let done = 0;
    let total = 0;

    for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
        const line = raw.trim();

        if (line === "") {
            continue;
        }

        const headline = HEADLINE.exec(line);

        if (headline) {
            phase = (headline[1] ?? "").toLowerCase();
            done = Number(headline[2]);
            total = Number(headline[3]);
            continue;
        }

        const task = parseTask(line);

        if (task) {
            tasks.set(task.key, task);
        }
    }

    const list = [ ...tasks.values() ];

    return { phase,
        done,
        total,
        tasks: list,
        failed: list.some((item) => item.state === "failed") };
}

/**
 * Разобрать одну строку в шаг
 * @param line Строка без управляющих последовательностей
 * @returns Шаг или null, если строка - обычный вывод
 */
function parseTask(line : string) : ComposeTask | null {
    let rest = line;
    let marked : ComposeTaskState | null = null;
    const mark = rest[0] ?? "";

    if (DONE_MARKS.includes(mark)) {
        marked = "done";
        rest = rest.slice(1).trim();
    } else if (FAILED_MARKS.includes(mark)) {
        marked = "failed";
        rest = rest.slice(1).trim();
    } else if (WORKING_MARKS.includes(mark) || UNKNOWN_MARK.test(rest)) {
        // Вертушку рисуют разными наборами символов, и знать их все нельзя:
        // одинокий знак перед словами читается как вертушка, а состояние шага
        // все равно скажет глагол
        rest = rest.slice(1).trim();
    }

    const tokens = rest.split(/\s+/);
    const kindWord = KINDS[(tokens[0] ?? "").toLowerCase()];

    if (kindWord) {
        tokens.shift();
    }

    const name = tokens.shift() ?? "";

    if (name === "" || LAYER_ID.test(name)) {
        return null;
    }

    let seconds : number | null = null;
    const last = SECONDS.exec(tokens.at(-1) ?? "");

    if (last) {
        seconds = Number(last[1]);
        tokens.pop();
    }

    const verb = VERBS[tokens.join(" ").toLowerCase()];

    if (!verb) {
        return null;
    }

    // Без слова о виде ресурса строку печатает только загрузка образов
    const kind = kindWord ?? (verb.id === "pulling" || verb.id === "pulled" ? "image" : null);

    if (!kind) {
        return null;
    }

    return { key: `${kind}:${name}`,
        kind,
        name,
        verb: verb.id,
        state: marked ?? verb.state,
        seconds };
}
