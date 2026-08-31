<template>
    <!-- Один и тот же бриф в двух местах: слоем поверх списка и встроенным в
         рабочую область главной. Логика одна, разная только оболочка -->
    <div v-if="inline || visible" class="sheet-layer" :class="{ inline }">
        <div v-if="!inline" class="scrim" @click="requestClose"></div>

        <section
            ref="sheet"
            class="sheet"
            :role="inline ? undefined : 'dialog'"
            :aria-modal="inline ? undefined : 'true'"
            :aria-labelledby="titleId"
            @keydown.esc.stop="requestClose"
            @keydown.tab="keepFocusInside"
        >
            <header>
                <h2 :id="titleId">{{ deploying ? $t("deployingStack", [ name ]) : $t("newStack") }}</h2>
                <span v-if="!deploying && converted" class="head-note">{{ targetSummary }}</span>
                <span v-if="deploying" class="head-note"><i class="dot attention"></i> {{ $t("deployRunning", [ elapsed ]) }}</span>
                <button
                    v-if="!deploying && !inline"
                    class="sheet-close"
                    type="button"
                    :aria-label="$t('Close')"
                    @click="requestClose"
                >
                    ✕
                </button>
            </header>

            <!-- Ошибка проверки: слой остаётся открытым, текст приходит от Docker Compose -->
            <div v-if="failure" class="line failure">
                <i class="dot failed"></i>
                <span><b>{{ $t("notDeployed") }}</b> {{ failure }}</span>
            </div>

            <!-- Пока идёт развёртывание, единственное доступное действие - прервать его -->
            <div v-if="deploying" class="line running">
                <span>{{ $t("deployStepsRunning") }}</span>
                <button class="btn btn-sm btn-normal" type="button" @click="abort">{{ $t("abortRunning") }}</button>
            </div>

            <div v-if="!deploying" class="brief">
                <div class="part">
                    <label class="part-title" :for="pasteId">{{ $t("whatToDeploy") }}</label>
                    <span class="sub">{{ $t("pasteHint") }}</span>

                    <div v-if="converted" class="line recognized">
                        <i class="dot running"></i>
                        <span>{{ $t("convertedFromDockerRun") }}</span>
                        <button class="btn btn-quiet btn-sm" type="button" @click="returnCommand">{{ $t("returnCommand") }}</button>
                    </div>

                    <textarea
                        :id="pasteId"
                        ref="paste"
                        v-model="source"
                        :class="{ joined: converted }"
                        :placeholder="$t('pastePlaceholder')"
                        spellcheck="false"
                        rows="10"
                    ></textarea>

                    <!-- Из отчёта на экране остаётся то, из-за чего сервис не заработает -->
                    <div v-if="report" class="line report">
                        <template v-if="firstProblem">
                            <i class="dot failed"></i>
                            <span><code>{{ firstProblem.flag }}</code> {{ $t(firstProblem.reason || "flagNoComposeKey") }}</span>
                        </template>
                        <template v-else>
                            <i class="dot running"></i>
                            <span>{{ $t("flagsAllCarried", report.carried.length) }}</span>
                        </template>
                        <button
                            v-if="restFlagCount > 0"
                            class="btn btn-quiet btn-sm"
                            type="button"
                            :aria-expanded="String(showAllFlags)"
                            @click="showAllFlags = !showAllFlags"
                        >
                            {{ showAllFlags ? $t("hideFlags") : $t("moreFlags", [ restFlagCount ]) }}
                        </button>
                    </div>

                    <ul v-if="report && showAllFlags" class="flag-list">
                        <li v-for="item in allFlags" :key="item.flag + (item.value || '')">
                            <span class="kind" :class="item.outcome">{{ $t("flagOutcome_" + item.outcome) }}</span>
                            <span><code>{{ item.flag }}</code><span v-if="item.value" class="value"> {{ item.value }}</span><span v-if="item.reason"> — {{ $t(item.reason) }}</span></span>
                        </li>
                    </ul>
                </div>

                <div class="part">
                    <span class="part-title">{{ $t("whereToDeploy") }}</span>
                    <div class="where">
                        <label class="field">
                            <span>{{ $t("stackName") }}</span>
                            <input v-model="name" type="text" :placeholder="$t('stackNamePlaceholder')" @input="nameTouched = true">
                        </label>
                        <label class="field">
                            <span>{{ $t("dockgeAgent", 1) }}</span>
                            <select v-model="endpoint">
                                <option
                                    v-for="(agent, agentEndpoint) in $root.agentList"
                                    :key="agentEndpoint"
                                    :value="agentEndpoint"
                                    :disabled="$root.agentStatusList[agentEndpoint] !== 'online'"
                                >
                                    {{ agent.name || agent.url || $t("Current") }}<template v-if="$root.agentStatusList[agentEndpoint] !== 'online'"> — {{ $root.agentStatusList[agentEndpoint] }}</template>
                                </option>
                            </select>
                        </label>
                        <span class="sub path">{{ $t("dirFromName") }}</span>
                    </div>
                </div>
            </div>

            <!-- Развёртывание: тот же слой, список контейнеров и время -->
            <div v-else class="progress">
                <div v-for="service in progressServices" :key="service" class="prow">
                    <span class="name">{{ service }}</span>
                    <span class="sub">{{ $t("deployWaiting") }}</span>
                </div>
                <p class="sub">{{ $t("deployOutputInTerminal") }}</p>
            </div>

            <footer v-if="!deploying">
                <button class="btn btn-primary" type="button" :disabled="!canDeploy" @click="deploy">
                    {{ $t("deployStack") }}
                </button>
                <button class="btn btn-quiet" type="button" :disabled="!canDeploy" @click="saveOnly">
                    {{ $t("saveWithoutStarting") }}
                </button>
                <span class="spacer"></span>
                <span class="sub">{{ canDeploy ? $t("validatedBeforeStart") : $t("deployNeedsContentAndName") }}</span>
            </footer>
        </section>
    </div>
</template>

<script>
import { parse } from "yaml";
import { analyseConversion } from "../../../common/docker-run-flags";

/** Пауза после ввода, после которой имеет смысл распознавать формат */
const RECOGNISE_DELAY_MS = 400;

/** Как долго строка нового стека остаётся подсвеченной в списке */
const FRESH_MS = 60_000;

/** Содержимое .env для нового стека: то же, что предлагает страница стека */
const ENV_DEFAULT = "# VARIABLE=value #comment";

let recogniseTimer = null;
let elapsedTimer = null;

export default {
    props: {
        /** Встроенный режим: бриф стоит прямо в рабочей области, а не поверх списка */
        inline: {
            type: Boolean,
            default: false,
        },
    },
    data() {
        return {
            visible: false,
            /** Элемент, которому вернётся фокус после закрытия */
            opener: null,
            source: "",
            /** Исходная команда, чтобы её можно было вернуть: правка поля ломает отмену браузера */
            originalCommand: "",
            converted: false,
            report: null,
            showAllFlags: false,
            name: "",
            nameTouched: false,
            endpoint: "",
            deploying: false,
            failure: "",
            elapsed: 0,
            titleId: "create-stack-title",
            pasteId: "create-stack-paste",
        };
    },

    computed: {
        /** Можно ли уже что-то разворачивать */
        canDeploy() {
            return this.source.trim().length > 0 && this.name.trim().length > 0;
        },

        /** Первый флаг, из-за которого сервис может не заработать */
        firstProblem() {
            return this.report?.dropped[0] ?? null;
        },

        /** Сколько флагов остаётся под кнопкой «ещё» */
        restFlagCount() {
            if (!this.report) {
                return 0;
            }

            const total = this.report.carried.length + this.report.review.length + this.report.dropped.length;
            return Math.max(0, total - (this.firstProblem ? 1 : 0));
        },

        /** Все флаги в одном списке: сначала потери, потом внимание, потом перенесённые */
        allFlags() {
            if (!this.report) {
                return [];
            }

            return [ ...this.report.dropped, ...this.report.review, ...this.report.carried ];
        },

        /** Куда попадёт стек, одной строкой */
        targetSummary() {
            const agent = this.$root.agentList?.[this.endpoint];
            // Локальный агент приходит с пустым именем, поэтому подпись берётся из перевода
            const agentName = agent?.name || agent?.url || this.$t("Current");

            return this.name ? `${this.name} · ${agentName}` : agentName;
        },

        /** Сервисы, которые сейчас поднимаются */
        progressServices() {
            return this.serviceNames(this.source);
        },
    },

    watch: {
        source() {
            this.scheduleRecognition();
        },
    },

    unmounted() {
        clearTimeout(recogniseTimer);
        clearInterval(elapsedTimer);
    },

    methods: {
        /**
         * Открыть слой, при необходимости с уже вставленным текстом
         * @param {string} prefill Текст, который пользователь вставил или перетащил
         * @returns {void}
         */
        open(prefill = "") {
            // Кнопка, с которой пришли: на неё возвращается фокус при закрытии
            this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            this.visible = true;
            this.failure = "";
            this.deploying = false;
            this.showAllFlags = false;

            if (prefill) {
                this.source = prefill;
                this.converted = false;
                this.report = null;
                this.originalCommand = "";
                this.nameTouched = false;
            }

            if (!this.endpoint) {
                this.endpoint = "";
            }

            this.$nextTick(() => {
                this.$refs.paste?.focus();
            });
        },

        /**
         * Закрыть слой. Во время развёртывания закрывать нечего: задача идёт.
         * @returns {void}
         */
        requestClose() {
            if (this.deploying || this.inline) {
                return;
            }

            this.close();
        },

        /**
         * Закрыть слой и вернуть фокус туда, откуда его открыли
         * @returns {void}
         */
        close() {
            this.visible = false;
            this.opener?.focus();
            this.opener = null;
        },

        /**
         * Не выпускать фокус из слоя: Tab с последнего элемента идёт на первый,
         * Shift+Tab с первого - на последний. Иначе клавиатура уходит в список
         * за притемнением, где ничего нажимать нельзя.
         * @param {KeyboardEvent} event Нажатие Tab
         * @returns {void}
         */
        keepFocusInside(event) {
            const sheet = this.$refs.sheet;

            if (!sheet) {
                return;
            }

            const reachable = [ ...sheet.querySelectorAll("a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex=\"-1\"])") ]
                .filter((node) => node.offsetParent !== null);
            const first = reachable[0];
            const last = reachable[reachable.length - 1];

            if (!first || !last) {
                return;
            }

            if (event.shiftKey && document.activeElement === first) {
                last.focus();
                event.preventDefault();
            } else if (!event.shiftKey && document.activeElement === last) {
                first.focus();
                event.preventDefault();
            }
        },

        /**
         * Отложенное распознавание формата: команда превращается в compose,
         * готовый compose не трогается вообще
         * @returns {void}
         */
        scheduleRecognition() {
            clearTimeout(recogniseTimer);

            if (this.converted || !this.looksLikeDockerRun(this.source)) {
                return;
            }

            recogniseTimer = setTimeout(() => this.convert(), RECOGNISE_DELAY_MS);
        },

        /**
         * Похоже ли содержимое на команду docker run
         * @param {string} text Содержимое поля
         * @returns {boolean} Признак команды
         */
        looksLikeDockerRun(text) {
            return /^\s*(sudo\s+)?docker\s+run\b/.test(text);
        },

        /**
         * Преобразовать команду в compose и составить отчёт по флагам
         * @returns {void}
         */
        convert() {
            const command = this.source;

            this.$root.getSocket().emit("composerize", command, (res) => {
                if (!res?.ok) {
                    this.failure = res?.msg ?? this.$t("conversionFailed");
                    return;
                }

                this.originalCommand = command;
                this.source = res.composeTemplate;
                this.converted = true;
                this.failure = "";
                this.report = analyseConversion(command, res.composeTemplate);

                if (!this.nameTouched) {
                    this.name = this.suggestName(res.composeTemplate);
                }
            });
        },

        /**
         * Вернуть исходную команду в поле
         * @returns {void}
         */
        returnCommand() {
            if (!this.originalCommand) {
                return;
            }

            const command = this.originalCommand;
            this.converted = false;
            this.report = null;
            this.showAllFlags = false;
            this.originalCommand = "";
            this.source = command;
        },

        /**
         * Имена сервисов compose-файла.
         * Читаем YAML, а не угадываем отступ: конвертер пишет с четырьмя пробелами,
         * человек - с двумя, и оба варианта одинаково правильные.
         * @param {string} composeYAML Содержимое compose-файла
         * @returns {Array<string>} Имена сервисов
         */
        serviceNames(composeYAML) {
            try {
                const parsed = parse(composeYAML);
                const services = parsed?.services;

                if (!services || typeof services !== "object") {
                    return [];
                }

                return Object.keys(services);
            } catch {
                // Незаконченный YAML - обычное состояние поля во время правки
                return [];
            }
        },

        /**
         * Имя стека по compose-файлу.
         * Сначала берётся имя контейнера: если человек написал `--name`, он уже
         * назвал эту вещь, и угадывать по образу поверх его выбора незачем.
         * @param {string} composeYAML Содержимое compose-файла
         * @returns {string} Предлагаемое имя
         */
        suggestName(composeYAML) {
            let candidate = this.serviceNames(composeYAML)[0] ?? "";

            try {
                const services = parse(composeYAML)?.services ?? {};
                const first = Object.values(services)[0];

                if (first?.container_name) {
                    candidate = String(first.container_name);
                }
            } catch {
                // Незаконченный YAML: остаётся имя сервиса
            }

            // Имя стека - это каталог, поэтому только то, что проходит барьер путей
            return candidate.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
        },

        /**
         * Записать файлы и поднять стек
         * @returns {void}
         */
        deploy() {
            this.send("deployStack", true);
        },

        /**
         * Только записать файлы, ничего не запуская
         * @returns {void}
         */
        saveOnly() {
            this.send("saveStack", false);
        },

        /**
         * Отправить стек агенту
         * @param {string} event Событие сокета
         * @param {boolean} withDeploy Нужно ли показывать прогресс развёртывания
         * @returns {void}
         */
        send(event, withDeploy) {
            this.failure = "";
            const name = this.name.trim();

            if (withDeploy) {
                this.deploying = true;
                this.elapsed = 0;
                clearInterval(elapsedTimer);
                elapsedTimer = setInterval(() => {
                    this.elapsed += 1;
                }, 1000);
            }

            // Пустой .env создаётся сразу: его почти всегда правят следующим шагом,
            // и пусть он лежит с подсказкой, а не появляется из ниоткуда потом
            const composeENV = this.$root.envTemplate || ENV_DEFAULT;

            this.$root.emitAgent(this.endpoint, event, name, this.source, composeENV, true, (res) => {
                clearInterval(elapsedTimer);
                this.deploying = false;

                if (!res?.ok) {
                    this.failure = res?.msg ? this.$t(res.msg) : this.$t("deployFailed");
                    return;
                }

                this.$root.markStackFresh(name, FRESH_MS);

                // Встроенный бриф не закрывается: он просто снова становится пустым
                if (this.inline) {
                    this.reset();
                } else {
                    this.close();
                }
                this.reset();
                this.$root.toastRes(res);
                this.$router.push(this.endpoint ? `/stack/${name}/${this.endpoint}` : `/stack/${name}`);
            });
        },

        /**
         * Прервать запущенное развёртывание: команда останавливается, файлы остаются
         * на диске черновиком
         * @returns {void}
         */
        abort() {
            this.$root.emitAgent(this.endpoint, "abortCompose", this.name.trim(), (res) => {
                if (!res?.ok) {
                    this.$root.toastRes(res);
                }
            });
        },

        /**
         * Забыть содержимое, чтобы следующий стек начинался с чистого поля
         * @returns {void}
         */
        reset() {
            this.source = "";
            this.originalCommand = "";
            this.converted = false;
            this.report = null;
            this.name = "";
            this.nameTouched = false;
            this.showAllFlags = false;
        },
    },
};
</script>

<style lang="scss" scoped>
.sheet-layer {
    position: fixed;
    inset: 0;
    z-index: 1055;
}

// Встроенный бриф: без притемнения, без фиксации на весь экран
.sheet-layer.inline {
    position: static;
    padding: 0;
    display: block;

    .sheet {
        position: static;
        transform: none;
        width: 100%;
        max-width: 100%;
        max-height: none;
        border: 0;
        border-radius: 0;
        box-shadow: none;
        background: none;
    }

    header {
        padding-left: 0;
        padding-right: 0;
    }

    footer {
        padding-left: 0;
        padding-right: 0;
        border-bottom: 0;
    }
}

// Притемнение приходит токеном --scrim: у фильтра backdrop-filter в светлой
// теме почти не видно эффекта, а список под слоем обязан уйти на второй план
.scrim {
    position: absolute;
    inset: 0;
    background-color: var(--scrim);
}

.sheet {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: min(980px, calc(100% - 24px));
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    background: var(--surface-panel);
    border: 1px solid var(--line-hair);
    border-top: 0;
    border-radius: 0 0 var(--radius-panel) var(--radius-panel);
    box-shadow: var(--shadow-panel);
}

header {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    padding: var(--gap-md) var(--gap-lg);
    border-bottom: 1px solid var(--line-hair);
    position: sticky;
    top: 0;
    background: var(--surface-panel);
    z-index: 1;
}

h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -.01em;
}

.head-note {
    color: var(--text-muted);
    font-size: var(--text-xs);
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
}

.sheet-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    flex: none;
    min-height: var(--control-height);
    min-width: var(--control-height);
    border: 1px solid var(--line-control);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-strong);
    cursor: pointer;

    &:hover {
        background: var(--surface-raised);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.brief {
    padding: var(--gap-md) var(--gap-lg) var(--gap-xs);
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}

// Мера строки: compose - узкий текст, около 104 знаков моноширинного,
// и растягивать поле на весь монитор незачем
.part {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    max-width: 840px;
}

.part-title {
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--text-strong);
}

.sub {
    color: var(--text-muted);
    font-size: var(--text-xs);
}

.path {
    color: var(--text-faint);
}

textarea {
    width: 100%;
    min-height: 190px;
    background: var(--surface-base);
    border: 1px solid var(--line-control);
    border-radius: var(--radius-control);
    color: var(--text-strong);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    line-height: 1.6;
    padding: var(--gap-sm) var(--gap-md);
    resize: vertical;

    &.joined {
        border-radius: 0 0 var(--radius-control) var(--radius-control);
    }

    &::placeholder {
        color: var(--text-faint);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

// Полоса над полем и отчёт под ним: сообщают, а не окрашивают экран
// Полоса выполнения: секунды идут в шапке, здесь - что происходит и как прервать
.running {
    justify-content: space-between;
    color: var(--text-muted);
}

.line {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    font-size: var(--text-sm);
    color: var(--text-strong);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-control);
    padding: var(--gap-xs) var(--gap-md);
    min-height: var(--row-height);
    flex-wrap: wrap;

    code {
        font-family: var(--font-mono);
        color: var(--text-strong);
    }

    .btn {
        margin-left: auto;
    }

    &.recognized {
        border-radius: var(--radius-control) var(--radius-control) 0 0;
        border-bottom: 0;
        background: var(--surface-raised);
        color: var(--text-muted);
    }

    &.report {
        color: var(--text-muted);
    }

    &.failure {
        border: 0;
        border-bottom: 1px solid var(--line-hair);
        border-radius: 0;
        background: color-mix(in srgb, var(--state-failed) 10%, transparent);
        padding: var(--gap-sm) var(--gap-lg);
    }
}

.dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-pill);
    flex: none;
    display: inline-block;

    &.running { background: var(--state-running); }
    &.attention { background: var(--state-attention); }
    &.failed { background: var(--state-failed); }
}

.flag-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-control);

    li {
        display: flex;
        gap: var(--gap-sm);
        align-items: baseline;
        padding: var(--gap-xs) var(--gap-md);
        border-bottom: 1px solid var(--line-hair);
        font-size: var(--text-sm);

        &:last-child { border-bottom: 0; }
    }

    // Исход назван словом, поэтому цветом отмечается только потеря
    .kind {
        flex: none;
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-muted);
        border: 1px solid var(--line-hair);
        border-radius: var(--radius-chip);
        padding: 1px 6px;

        &.dropped {
            color: var(--state-failed);
            border-color: color-mix(in srgb, var(--state-failed) 45%, transparent);
        }
    }

    code {
        font-family: var(--font-mono);
    }

    .value {
        font-family: var(--font-mono);
        color: var(--text-muted);
    }
}

.where {
    display: flex;
    gap: var(--gap-md);
    flex-wrap: wrap;
    align-items: flex-end;
}

.field {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
    min-width: 190px;

    > span {
        color: var(--text-muted);
        font-size: var(--text-xs);
    }

    input,
    select {
        min-height: var(--control-height);
        padding: 0 var(--gap-sm);
        background: var(--surface-base);
        border: 1px solid var(--line-control);
        border-radius: var(--radius-control);
        color: var(--text-strong);
        font-family: inherit;
        font-size: var(--text-sm);

        &:focus-visible {
            outline: var(--focus-ring);
            outline-offset: var(--focus-offset);
        }
    }
}

.progress {
    padding: var(--gap-md) var(--gap-lg);
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);

    .prow {
        display: flex;
        gap: var(--gap-md);
        align-items: baseline;
        min-height: var(--row-height-dense);
        padding-bottom: var(--gap-sm);
        border-bottom: 1px solid var(--line-hair);
        font-size: var(--text-sm);
    }

    .name {
        min-width: 200px;
        font-family: var(--font-mono);
        color: var(--text-strong);
    }
}

footer {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-sm);
    padding: var(--gap-md) var(--gap-lg);
    border-top: 1px solid var(--line-hair);
    background: var(--surface-raised);
    flex-wrap: wrap;
    position: sticky;
    bottom: 0;
}

.spacer {
    flex: 1;
}

// Вид кнопки живёт в main.scss. Здесь остаётся только тихий вид: в слое
// главная кнопка одна, остальные не должны с ней спорить.
.btn-quiet {
    --bs-btn-color: var(--text-strong);
    --bs-btn-bg: transparent;
    --bs-btn-border-color: var(--line-control);
}

@media (max-width: 900px) {
    .sheet {
        width: 100%;
        max-height: 100vh;
        border-radius: 0;
        border: 0;
    }

    footer .btn {
        flex: 1 1 100%;
        justify-content: center;
    }
}
</style>
