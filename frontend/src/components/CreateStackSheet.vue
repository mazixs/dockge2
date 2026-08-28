<template>
    <div v-if="visible" class="sheet-layer">
        <div class="scrim" @click="requestClose"></div>

        <section
            ref="sheet"
            class="sheet"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            @keydown.esc.stop="requestClose"
        >
            <header>
                <h2 :id="titleId">{{ deploying ? $t("deployingStack", [ name ]) : $t("newStack") }}</h2>
                <span v-if="!deploying && converted" class="head-note">{{ targetSummary }}</span>
                <span v-if="deploying" class="head-note"><i class="dot attention"></i> {{ $t("deployRunning", [ elapsed ]) }}</span>
                <button
                    v-if="!deploying"
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

            <div v-if="!deploying" class="brief">
                <div class="part">
                    <label class="part-title" :for="pasteId">{{ $t("whatToDeploy") }}</label>
                    <span class="sub">{{ $t("pasteHint") }}</span>

                    <div v-if="converted" class="line recognized">
                        <i class="dot running"></i>
                        <span>{{ $t("convertedFromDockerRun") }}</span>
                        <button class="btn btn-quiet sm" type="button" @click="returnCommand">{{ $t("returnCommand") }}</button>
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
                            <span>{{ $t("flagsAllCarried", [ report.carried.length ]) }}</span>
                        </template>
                        <button
                            v-if="restFlagCount > 0"
                            class="btn btn-quiet sm"
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
    data() {
        return {
            visible: false,
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
            if (this.deploying) {
                return;
            }

            this.visible = false;
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
                this.visible = false;
                this.reset();
                this.$root.toastRes(res);
                this.$router.push(this.endpoint ? `/stack/${name}/${this.endpoint}` : `/stack/${name}`);
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

.scrim {
    position: absolute;
    inset: 0;
    background: rgba(4, 7, 11, .62);
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
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--line-hair);
    position: sticky;
    top: 0;
    background: var(--surface-panel);
}

h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
}

.head-note {
    color: var(--text-muted);
    font-size: var(--text-xs);
    display: flex;
    align-items: center;
    gap: 6px;
}

.sheet-close {
    margin-left: auto;
    min-height: var(--control-height);
    min-width: var(--control-height);
    border: 1px solid var(--line-control);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-strong);
    cursor: pointer;
}

.brief {
    padding: 14px 16px 4px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.part {
    display: flex;
    flex-direction: column;
    gap: 7px;
}

.part-title {
    font-size: var(--text-base);
    font-weight: 500;
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
    padding: 10px 12px;
    resize: vertical;

    &.joined {
        border-radius: 0 0 var(--radius-control) var(--radius-control);
    }

    &::placeholder {
        color: var(--text-faint);
    }
}

.line {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: var(--text-sm);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-control);
    padding: 7px 11px;
    flex-wrap: wrap;

    .btn {
        margin-left: auto;
    }

    &.recognized {
        border-radius: var(--radius-control) var(--radius-control) 0 0;
        border-bottom: 0;
        background: var(--surface-raised);
    }

    &.failure {
        border: 0;
        border-bottom: 1px solid var(--line-hair);
        border-radius: 0;
        background: color-mix(in srgb, var(--state-failed) 12%, transparent);
        padding: 9px 16px;
    }
}

.dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
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
        gap: 9px;
        align-items: baseline;
        padding: 6px 11px;
        border-bottom: 1px solid var(--line-hair);
        font-size: var(--text-sm);

        &:last-child { border-bottom: 0; }
    }

    .kind {
        flex: none;
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        border: 1px solid var(--line-hair);
        border-radius: var(--radius-chip);
        padding: 1px 6px;

        &.carried { color: var(--state-running); }
        &.review { color: var(--state-attention); }
        &.dropped { color: var(--state-failed); }
    }

    .value {
        font-family: var(--font-mono);
        color: var(--text-muted);
    }
}

.where {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    align-items: flex-end;
}

.field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 190px;

    > span {
        color: var(--text-muted);
        font-size: var(--text-xs);
    }

    input,
    select {
        min-height: var(--control-height);
        padding: 4px 9px;
        background: var(--surface-base);
        border: 1px solid var(--line-control);
        border-radius: var(--radius-control);
        color: var(--text-strong);
        font-family: inherit;
        font-size: var(--text-sm);
    }
}

.progress {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;

    .prow {
        display: flex;
        gap: 12px;
        align-items: baseline;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--line-hair);
        font-size: var(--text-sm);
    }

    .name {
        min-width: 200px;
        font-family: var(--font-mono);
    }
}

footer {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 12px 16px;
    border-top: 1px solid var(--line-hair);
    background: var(--surface-raised);
    flex-wrap: wrap;
    position: sticky;
    bottom: 0;
}

.spacer {
    flex: 1;
}

.btn {
    min-height: var(--control-height);
    border-radius: var(--radius-control);
    border: 1px solid var(--line-control);
    background: transparent;
    color: var(--text-strong);
    font-family: inherit;
    font-size: var(--text-sm);
    padding: 4px 12px;
    cursor: pointer;

    &.sm {
        font-size: var(--text-xs);
        padding: 2px 8px;
        min-height: 28px;
    }

    &.btn-primary {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--text-on-accent);
        font-weight: 500;
    }

    &[disabled] {
        opacity: .55;
        cursor: not-allowed;
    }
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
