<template>
    <!-- Ход команды. Что стало с каждым сервисом, говорит таблица сервисов -
         повторять ее отдельной панелью незачем. Здесь остается то, чего в
         таблице нет: какая команда идет, сколько она уже идет, чем кончилась,
         и работа, которую таблица не показывает - сети, тома, загрузка образов.
         Одна строка под кнопками, и она уходит сама после удачи. Полный вывод
         docker compose лежит в окне и открывается кнопкой: терминал нужен, но
         не должен встречать человека каждый раз -->
    <div class="run">
        <transition name="strip">
            <div v-if="open" class="run-strip" :class="{ failed, done: finished, unknown: resultUnknown }">
                <span class="run-mark" aria-hidden="true">
                    <InterfaceIcon v-if="finished" name="check" class="mark-icon" />
                    <InterfaceIcon v-else-if="failed" name="cross" class="mark-icon" />
                    <InterfaceIcon v-else-if="resultUnknown" name="question" class="mark-icon" />
                    <span v-else class="mark-pulse"></span>
                </span>

                <span class="run-title">{{ title }}</span>

                <!-- Строка меняется на каждом шаге: это самое живое место экрана,
                     поэтому в ней стоит то, что происходит прямо сейчас -->
                <span v-ellipsis-title class="run-line">{{ headline }}</span>

                <span v-if="running && total > 0" class="run-count" :title="stepsTitle">{{ done }}/{{ total }}</span>
                <span v-if="running" class="run-time">{{ $t("progressSeconds", [ elapsed ]) }}</span>

                <button v-if="running" class="btn btn-sm btn-normal" type="button" @click="$emit('abort')">
                    {{ $t("abortRunning") }}
                </button>
                <button class="btn btn-sm log-open" :class="failed ? 'btn-primary' : 'btn-normal'" type="button" @click="openLog">
                    {{ $t("progressShowLog") }}
                </button>
                <button class="icon-btn" type="button" :title="$t('progressHide')" :aria-label="$t('progressHide')" @click="open = false">
                    <font-awesome-icon icon="times" />
                </button>

                <!-- Нить показывает счет самого compose: пока счета нет, она
                     бежит сама - работа идет, но ее объем еще неизвестен -->
                <span class="thread" :class="{ sweeping: running && total === 0 }" aria-hidden="true">
                    <span class="thread-fill" :style="fillStyle"></span>
                </span>
            </div>
        </transition>

        <!-- Итог произносится один раз: шаги меняются слишком часто, чтобы
             читать их с экрана вслух -->
        <p class="visually-hidden" role="status">{{ outcome ? chipLabel : "" }}</p>

        <!-- Окно вывода. Разметка живет всегда, даже закрытой: терминал связан
             с сокетом по имени, и размонтирование оборвало бы прием вывода -->
        <div ref="dialog" class="modal fade log-dialog" tabindex="-1" :aria-label="$t('progressLogTitle')">
            <div class="modal-dialog modal-lg">
                <div class="modal-content">
                    <div class="modal-header">
                        <div class="log-heading">
                            <h2 class="modal-title">{{ $t("progressLogTitle") }}</h2>
                            <p class="log-subtitle">{{ title }} · {{ chipLabel }}</p>
                        </div>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')"></button>
                    </div>

                    <div class="modal-body">
                        <!-- Шаги идут над выводом: сети, тома и образы в таблице
                             сервисов не показать, а ждать приходится как раз их -->
                        <ul v-if="tasks.length > 0" class="steps">
                            <li v-for="task in tasks" :key="task.key" class="step" :class="task.state">
                                <span class="mark" aria-hidden="true">
                                    <InterfaceIcon v-if="task.state === 'done'" name="check" class="mark-icon" />
                                    <InterfaceIcon v-else-if="task.state === 'failed'" name="cross" class="mark-icon" />
                                    <span v-else class="mark-pulse"></span>
                                </span>

                                <!-- Вид ресурса назван словом, а не только значком:
                                     значок говорит быстрее, слово - точнее -->
                                <InterfaceIcon :name="kindIcon(task)" class="kind" />
                                <span class="visually-hidden">{{ kindLabel(task) }}</span>

                                <span v-ellipsis-title class="step-name">{{ task.name }}</span>
                                <span class="step-verb">{{ verbLabel(task) }}</span>
                                <span class="step-time">{{ task.seconds === null ? "" : $t("progressSeconds", [ task.seconds ]) }}</span>
                            </li>
                        </ul>

                        <div ref="body" class="progress-body">
                            <Terminal
                                ref="terminal"
                                class="progress-terminal"
                                :name="terminalName"
                                :endpoint="endpoint"
                                :stack-name="stackName"
                                mode="displayOnly"
                                :rows="rows"
                                @has-data="onData"
                            />
                        </div>
                    </div>

                    <!-- Подпись отделяет вывод команды от вывода контейнеров: это
                         разные вещи, и человек не должен угадывать, почему тут нет
                         строк приложения -->
                    <div class="modal-footer">
                        <p class="progress-foot">
                            <font-awesome-icon icon="info-circle" />{{ $t("progressNote") }}
                        </p>
                        <button type="button" class="btn btn-normal" data-bs-dismiss="modal">{{ $t("Close") }}</button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import Terminal from "./Terminal.vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import { getComposeTerminalName, PROGRESS_TERMINAL_ROWS } from "../../../common/util-common";
import { parseComposeProgress } from "../../../common/compose-progress";
import { COMMAND_KEYS, KIND_ICONS, KIND_KEYS, VERB_KEYS, VERB_KIND_KEYS } from "../progress-labels";

/** Вывод разбирается не чаще этого, иначе шаги дергались бы на каждый байт */
const SAMPLE_DELAY = 120;

/** Хвост вывода приходит вместе с ответом сервера, поэтому после конца читаем еще раз */
const SETTLE_DELAY = 400;

/**
 * Сколько шаги живут после конца команды. Docker опрашивается раз в две секунды,
 * и без этой паузы строка сервиса успела бы моргнуть старым состоянием между
 * словом "запущено" и первым замером
 */
const TAIL_DELAY = 4000;

export default {
    components: {
        Terminal,
        InterfaceIcon,
    },
    props: {
        stackName: {
            type: String,
            required: true,
        },

        endpoint: {
            type: String,
            default: "",
        },

        /** Имя выполняющейся команды, пусто когда ничего не идет */
        running: {
            type: String,
            default: "",
        },

        /** Сколько секунд идет или шла команда */
        elapsed: {
            type: Number,
            default: 0,
        },

        /** Чем кончилось: пусто, "ok" или "failed" */
        outcome: {
            type: String,
            default: "",
        },
    },
    emits: [ "abort", "progress" ],
    data() {
        return {
            open: false,
            /** Команда, чей ход сейчас показан: после конца ее имя еще нужно в строке */
            lastCommand: "",
            tasks: [],
            done: 0,
            total: 0,
            /** Провал виден в шагах раньше, чем сервер ответит отказом */
            stepFailed: false,
            hasOutput: false,
            /** Шаги описывают настоящее: после конца команды правду говорит docker */
            live: false,
            rows: PROGRESS_TERMINAL_ROWS,
        };
    },
    computed: {
        /** Имя терминала прогресса: сюда сервер пишет вывод docker compose */
        terminalName() {
            return getComposeTerminalName(this.endpoint, this.stackName);
        },

        /** Заголовок - сама команда: "Запуск", "Перезапуск", "Обновление" */
        title() {
            const key = COMMAND_KEYS[this.lastCommand];
            return key ? this.$t(key) : this.$t("progressTitle");
        },

        failed() {
            return this.outcome === "failed" || this.stepFailed;
        },

        /**
         * Подтверждения не было. Это не отказ: команда могла выполниться, поэтому
         * строка не обещает ни удачи, ни провала, а отправляет смотреть состояние
         * @returns {boolean} Итог команды остался неизвестным
         */
        resultUnknown() {
            return this.outcome === "unknown" && !this.stepFailed;
        },

        finished() {
            return !this.running && this.outcome === "ok" && !this.stepFailed;
        },

        /** Шаг, о котором строка говорит сейчас: сначала провал, потом работа */
        currentTask() {
            const failedTask = this.tasks.find((task) => task.state === "failed");

            if (failedTask) {
                return failedTask;
            }

            const working = [ ...this.tasks ].reverse().find((task) => task.state === "working");
            return working ?? this.tasks[this.tasks.length - 1] ?? null;
        },

        /** Что происходит прямо сейчас, одной строкой */
        headline() {
            if (this.failed) {
                const task = this.tasks.find((item) => item.state === "failed");
                return task ? this.$t("progressFailedAt", [ task.name ]) : this.$t("progressFailed");
            }

            if (this.resultUnknown) {
                return this.$t("progressResultUnknown");
            }

            if (!this.running) {
                return this.outcome === "ok" ? this.$t("progressFinished", [ this.elapsed ]) : "";
            }

            const task = this.currentTask;

            if (!task) {
                return this.$t("progressWaiting");
            }

            return this.$t("progressStepLine", [ this.kindLabel(task), task.name, this.verbLabel(task) ]);
        },

        /** Итог словами: он же стоит в подзаголовке окна вывода */
        chipLabel() {
            if (this.running) {
                return this.$t("deployRunningFor", [ this.elapsed ]);
            }

            if (this.resultUnknown) {
                return this.$t("progressResultUnknown");
            }

            return this.failed ? this.$t("progressFailed") : this.$t("progressFinished", [ this.elapsed ]);
        },

        stepsTitle() {
            return this.$t("progressSteps", [ this.done, this.total ]);
        },

        /** Нить без счета бежит сама, со счетом - показывает долю */
        fillStyle() {
            if (this.total === 0) {
                return {};
            }

            return { width: `${Math.min(100, Math.round((this.done / this.total) * 100))}%` };
        },
    },
    watch: {
        running(value) {
            if (value) {
                this.startRun(value);
            } else {
                this.finishRun();
            }
        },
    },
    mounted() {
        this.dialog = new Modal(this.$refs.dialog);

        // Закрытое окно не имеет размера, и xterm не может себя измерить:
        // сетка подгоняется в тот момент, когда окно уже на экране
        this.$refs.dialog.addEventListener("shown.bs.modal", this.refit);

        // Высота консоли считается от экрана: после изменения окна старая сетка
        // xterm налезала бы на край окна, поэтому область под наблюдением
        this.observer = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                this.refit();
            });
        });
        this.observer.observe(this.$refs.body);

        // Шаги берутся из того же текста, что видно в выводе: xterm уже свел
        // перерисованный блок compose к тому, что стоит на экране
        this.writeSub = this.$refs.terminal?.terminal?.onWriteParsed(() => {
            this.scheduleSample();
        });
    },
    beforeUnmount() {
        this.$refs.dialog?.removeEventListener("shown.bs.modal", this.refit);
        // Окно уносит с собой затемнение: без явного закрытия оно осталось бы
        // висеть над следующим стеком
        this.dialog?.hide();
        this.dialog?.dispose();
        this.observer?.disconnect();
        this.writeSub?.dispose();
        clearTimeout(this.sampleTimer);
        clearTimeout(this.settleTimer);
        clearTimeout(this.tailTimer);
    },
    methods: {
        /**
         * Команда началась: строка показывает ее с чистого листа, иначе шаги
         * прошлой команды выглядели бы как шаги этой
         * @param {string} event Имя события команды
         * @returns {void}
         */
        startRun(event) {
            this.lastCommand = event;
            this.open = true;
            this.tasks = [];
            this.done = 0;
            this.total = 0;
            this.stepFailed = false;
            this.hasOutput = false;
            this.live = true;
            clearTimeout(this.settleTimer);
            clearTimeout(this.tailTimer);
            this.$refs.terminal?.terminal?.clear();
            this.publish();
        },

        /**
         * Команда кончилась: дочитываем хвост вывода, а потом отпускаем таблицу
         * сервисов - дальше о состоянии говорит docker, а не шаги
         * @returns {void}
         */
        finishRun() {
            clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => {
                this.sample();
            }, SETTLE_DELAY);

            clearTimeout(this.tailTimer);
            this.tailTimer = setTimeout(() => {
                this.live = false;
                this.publish();

                // Удача не требует внимания: строка уходит сама. Неудача остается
                // на экране вместе с кнопкой, которая показывает, что сказал compose
                if (!this.failed) {
                    this.open = false;
                }
            }, TAIL_DELAY);
        },

        /** Вывод пошел: строка показывается и тогда, когда команду запустил не этот экран */
        onData() {
            this.open = true;
            this.scheduleSample();
        },

        scheduleSample() {
            if (this.sampleTimer) {
                return;
            }

            this.sampleTimer = setTimeout(() => {
                this.sampleTimer = null;
                this.sample();
            }, SAMPLE_DELAY);
        },

        /**
         * Прочитать вывод с экрана терминала и разобрать его в шаги.
         * Читается именно буфер xterm: в нем перерисовка compose уже свернута
         * к последнему состоянию блока
         * @returns {void}
         */
        sample() {
            const terminal = this.$refs.terminal?.terminal;

            if (!terminal) {
                return;
            }

            const buffer = terminal.buffer.active;
            const lines = [];

            for (let row = 0; row < buffer.length; row++) {
                const line = buffer.getLine(row);

                if (!line) {
                    continue;
                }

                const text = line.translateToString(true);

                // Длинную строку xterm переносит: склеиваем обратно, иначе
                // хвост со временем шага оторвался бы от его имени
                if (line.isWrapped && lines.length > 0) {
                    lines[lines.length - 1] += text;
                } else {
                    lines.push(text);
                }
            }

            const output = lines.join("\n");
            const progress = parseComposeProgress(output);

            this.hasOutput = output.trim() !== "";
            this.tasks = progress.tasks;
            this.done = progress.done;
            this.total = progress.total;
            this.stepFailed = progress.failed;
            this.publish();
        },

        /**
         * Рассказать странице о ходе: по этим шагам таблица сервисов называет
         * состояние словами compose, пока команда идет
         * @returns {void}
         */
        publish() {
            // Шаги приходят из терминала стека, поэтому в сообщении сказано,
            // чьи они: страница остается той же при смене стека
            this.$emit("progress", { endpoint: this.endpoint,
                stackName: this.stackName,
                tasks: this.live ? this.tasks : [],
                hasOutput: this.hasOutput });
        },

        /** Открыть окно с полным выводом команды */
        openLog() {
            this.dialog?.show();
        },

        /**
         * Что происходит с ресурсом, словами
         * @param {object} task Шаг разбора
         * @returns {string} Слово для строки
         */
        verbLabel(task) {
            const key = VERB_KEYS[task.verb];

            if (!key) {
                return task.verb;
            }

            // The line reads "Network app_default created", so the verb belongs to the
            // kind in front of it. A language that inflects has a different word there,
            // and the catalogue is where that difference is allowed to live
            const byKind = VERB_KIND_KEYS[task.kind]?.[task.verb];

            return byKind && this.$te(byKind) ? this.$t(byKind) : this.$t(key);
        },

        /**
         * Значок вида ресурса
         * @param {object} task Шаг разбора
         * @returns {string} Имя значка InterfaceIcon
         */
        kindIcon(task) {
            return KIND_ICONS[task.kind] ?? "box";
        },

        /**
         * Вид ресурса словом: значок показывает его быстрее, но не всем
         * @param {object} task Шаг разбора
         * @returns {string} Контейнер, сеть, том или образ
         */
        kindLabel(task) {
            const key = KIND_KEYS[task.kind];
            return key ? this.$t(key) : task.kind;
        },

        /** Подогнать вывод под область */
        refit() {
            this.$refs.terminal?.updateTerminalSize?.();
        },
    },
};
</script>

<style lang="scss" scoped>
// Обертка не участвует в раскладке: страница выстроена колонкой с отступом,
// и пустой блок оставлял бы дыру там, где строки хода нет
.run {
    display: contents;
}

// Строка хода: одна линия под кнопками стека. Это не панель - панель заняла бы
// место у того, ради чего команду и запускали, и повторяла бы состояние,
// которое уже стоит в таблице сервисов
.run-strip {
    position: relative;
    display: flex;
    align-items: center;
    // На узкой колонке кнопки переносятся под строку: прервать команду нужно и
    // с телефона, а обрезанная кнопка этого не дает
    flex-wrap: wrap;
    gap: var(--gap-sm);
    flex: none;
    min-height: var(--control-height);
    padding: var(--gap-xs) var(--gap-sm) var(--gap-xs) var(--gap-md);
    background-color: var(--surface-panel);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);
    overflow: hidden;

    // Неудача не прячется: рамка называет ее до того, как человек откроет вывод
    &.failed {
        border-color: var(--state-failed);
    }

    // Неизвестный итог - не неудача: цвет тот же, что у неизвестного состояния стека
    &.unknown {
        border-color: var(--state-unknown);
    }
}

.run-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex: none;
}

.run-title {
    flex: none;
    color: var(--text-strong);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
}

// Самое живое место строки: имя ресурса длинное, поэтому обрезается оно, а не
// кнопки, без которых команду не прервать
.run-line {
    flex: 1 1 14ch;
    min-width: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.run-strip.failed .run-line {
    color: var(--state-failed);
}

.run-strip.unknown .run-line {
    color: var(--state-unknown);
}

// Счет самого compose: при загрузке образов он считает слои, поэтому шагов
// в счете больше, чем строк в списке
.run-count,
.run-time {
    flex: none;
    color: var(--text-faint);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
}

.run-strip .btn {
    flex: none;
}

.icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control-height);
    height: var(--control-height);
    flex: none;
    // Строка перенеслась - крестик все равно держится правого края, там его и ищут
    margin-left: auto;
    background: none;
    border: 0;
    border-radius: var(--radius-control);
    color: var(--text-faint);

    &:hover {
        background-color: var(--surface-sunken);
        color: var(--text-strong);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

// Нить по нижнему краю строки: тонкая линия говорит о ходе, не занимая места
.thread {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background-color: var(--surface-sunken);
    overflow: hidden;
}

.thread-fill {
    display: block;
    width: 0;
    height: 100%;
    background-color: var(--state-attention);
    transition: width var(--motion-slow) var(--motion-ease);
}

// Счета еще нет: нить бежит сама, показывая, что команда жива
.thread.sweeping .thread-fill {
    width: 30%;
    animation: thread-sweep 1.5s var(--motion-ease) infinite;
}

.run-strip.done .thread-fill {
    background-color: var(--state-running);
}

.run-strip.failed .thread-fill {
    background-color: var(--state-failed);
}

// Окно вывода открывают, чтобы что-то прочитать, а не чтобы смотреть, как оно
// выезжает: 300 миллисекунд Bootstrap здесь заметно медленнее самой нужды
.log-dialog.fade,
.log-dialog .modal-dialog {
    transition-duration: var(--motion-fast);
}

@keyframes thread-sweep {
    from { transform: translateX(-100%); }
    to { transform: translateX(333%); }
}

// Строка приходит сверху, от кнопки, которую нажали, и так же уходит
.strip-enter-from,
.strip-leave-to {
    opacity: 0;
    transform: translateY(-8px);
}

.strip-enter-active {
    transition: opacity var(--motion-fast) var(--motion-ease), transform var(--motion-base) var(--motion-ease);
}

.strip-leave-active {
    transition: opacity var(--motion-fast) var(--motion-ease-in), transform var(--motion-fast) var(--motion-ease-in);
}

.mark-icon {
    // Значок меряется кеглем: InterfaceIcon рисует себя в 1em
    font-size: var(--text-sm);
    // Линия значка в 14 пикселях выходит тоньше волоса: итог обязан читаться
    // так же уверенно, как точка работающего
    stroke-width: 2.4;
    // Готовый шаг отмечается разом: движение показывает, что именно изменилось
    animation: mark-pop var(--motion-base) var(--motion-ease);
}

.run-strip.done .mark-icon,
.step.done .mark-icon {
    color: var(--state-running);
}

.run-strip.failed .mark-icon,
.step.failed .mark-icon {
    color: var(--state-failed);
}

.run-strip.unknown .mark-icon {
    color: var(--state-unknown);
}

@keyframes mark-pop {
    from { transform: scale(.4); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
}

// Работа дышит: неподвижная точка не отличалась бы от готовой
.mark-pulse {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-pill);
    background-color: var(--state-attention);
    animation: step-pulse 1.6s var(--motion-ease) infinite;
}

@keyframes step-pulse {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--state-attention) 45%, transparent); }
    70% { box-shadow: 0 0 0 7px color-mix(in srgb, var(--state-attention) 0%, transparent); }
    100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--state-attention) 0%, transparent); }
}

// Окно вывода: шаги сверху, вывод под ними. Заголовок называет команду и ее
// итог, потому что окно открывают и через минуту после конца
.log-heading {
    min-width: 0;
}

.log-subtitle {
    margin: 0;
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.modal-body {
    padding: 0;
}

// Шаги: список ресурсов, по строке на каждый
.steps {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: var(--gap-sm) var(--gap-md);
    list-style: none;
    // Стек из двадцати сервисов не должен выталкивать вывод за край окна
    max-height: clamp(120px, 22vh, 220px);
    overflow-y: auto;
    border-bottom: 1px solid var(--line-hair);
}

// Колонки одинаковы во всех строках, поэтому имена, слова и секунды стоят на
// одних вертикалях. Последняя колонка пустая: строка читается слева направо
// и не растягивается через всю ширину окна
.step {
    display: grid;
    grid-template-columns: 14px 16px minmax(0, 26ch) minmax(11ch, auto) 6ch 1fr;
    align-items: center;
    gap: var(--gap-sm);
    min-height: 26px;
    font-size: var(--text-sm);
}

.mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
}

.kind {
    font-size: var(--text-base);
    color: var(--text-faint);
}

.step-name {
    color: var(--text-strong);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.step-verb {
    color: var(--text-muted);
}

.step.failed .step-verb {
    color: var(--state-failed);
}

.step-time {
    color: var(--text-faint);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    text-align: right;
}

.progress-body {
    height: clamp(200px, 34vh, 360px);
    min-height: 0;
    // Отставшая сетка xterm не должна вылезать за край окна
    overflow: hidden;
    background-color: var(--surface-console);
}

.progress-terminal {
    height: 100%;
}

.modal-footer {
    justify-content: space-between;
    gap: var(--gap-md);
}

.progress-foot {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    margin: 0;
    min-width: 0;
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.progress-foot svg {
    color: var(--text-faint);
    flex: none;
}

// Бесконечное движение - украшение: при запрете анимации состояние обязано
// читаться формой значка и словом, а не пульсацией
@media (prefers-reduced-motion: reduce) {
    .mark-pulse,
    .thread.sweeping .thread-fill {
        animation: none;
    }

    .thread.sweeping .thread-fill {
        width: 100%;
        opacity: .5;
    }
}
</style>
