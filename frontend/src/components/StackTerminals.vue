<template>
    <!-- Терминал: оболочки контейнеров. Вывод стека сюда не попадает - он
         во вкладке журнала, где в него нельзя печатать -->
    <section class="panel terminals" :class="{ fill: sessions.length > 0 }">
        <div class="panel-bar terminal-bar">
            <div class="terminal-tabs" role="tablist">
                <!-- Закрытие - отдельная кнопка рядом с вкладкой: кнопку в кнопку
                     вложить нельзя, иначе крестик недоступен с клавиатуры -->
                <div
                    v-for="session in sessions" :key="session.key"
                    class="terminal-tab" :class="{ active: session.key === activeKey }"
                >
                    <button
                        class="label" type="button" role="tab"
                        :aria-selected="String(session.key === activeKey)"
                        @click="activate(session.key)"
                    >
                        <InterfaceIcon name="terminal" />{{ session.label }}
                    </button>
                    <button class="close" type="button" :title="$t('sessionClose')" :aria-label="`${$t('sessionClose')}: ${session.label}`" @click="close(session.key)">
                        <font-awesome-icon icon="times" />
                    </button>
                </div>

                <h2 v-if="sessions.length === 0" class="panel-title">
                    <InterfaceIcon name="terminal" />{{ $t("terminal") }}
                </h2>
            </div>

            <!-- Связь названа словом, а не только цветом: без нее оболочка молчит,
                 и человек должен знать, что молчит канал, а не контейнер. Пока
                 сессии нет, говорить не о чем - и чипа нет -->
            <StateChip
                v-if="sessions.length > 0"
                class="terminal-state" :state="connected ? 'running' : 'failed'"
                :label="$t(connected ? 'sessionLive' : 'agentOffline')"
            />

            <!-- Кнопка названа тем же словом, что пункт меню в таблице сервисов:
                 одно действие - одно имя, где бы оно ни встретилось. Пока сессий
                 нет, выбор сервиса уже стоит в теле панели: два одинаковых
                 предложения в одной рамке спорят за нажатие -->
            <BDropdown v-if="sessions.length > 0" right variant="normal" size="sm" class="new-session">
                <template #button-content>
                    <font-awesome-icon icon="plus" />{{ $t("openShell") }}
                </template>
                <BDropdownItem
                    v-for="service in shellTargets" :key="service"
                    @click="openShell({ serviceName: service, shell: 'sh' })"
                >
                    <font-awesome-icon icon="terminal" />{{ service }} · sh
                </BDropdownItem>
                <BDropdownItem v-if="shellTargets.length === 0" disabled>{{ $t("noRunningServices") }}</BDropdownItem>
            </BDropdown>
        </div>

        <!-- Пустая вкладка не показывает черный прямоугольник: сначала выбор сервиса,
             консоль появляется вместе с первой оболочкой -->
        <div v-if="sessions.length === 0" class="panel-body terminal-start">
            <p class="start-note">{{ shellTargets.length > 0 ? $t("terminalPickService") : $t("noRunningServices") }}</p>
            <div class="start-targets">
                <button
                    v-for="service in shellTargets" :key="service"
                    class="btn btn-sm btn-normal" type="button"
                    @click="openShell({ serviceName: service, shell: 'sh' })"
                >
                    <font-awesome-icon icon="terminal" />{{ service }} · sh
                </button>
            </div>
        </div>

        <div v-else ref="body" class="panel-console terminal-body">
            <!-- Сессии остаются живыми: v-show, потому что размонтирование убивает shell -->
            <div v-for="session in sessions" v-show="session.key === activeKey" :key="session.key" class="pane">
                <Terminal
                    :ref="`terminal-${session.key}`"
                    class="session-terminal"
                    :name="session.key"
                    :endpoint="session.endpoint"
                    :stack-name="session.stackName"
                    :service-name="session.serviceName"
                    :shell="session.shell"
                    mode="interactive"
                    :rows="20"
                />
            </div>
        </div>

        <p v-if="activeSession" class="panel-foot">
            <font-awesome-icon icon="info-circle" />{{ $t("sessionShellNote") }}
        </p>
    </section>
</template>

<script>
import Terminal from "./Terminal.vue";
import StateChip from "./StateChip.vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import { getContainerExecTerminalName } from "../../../common/util-common";

export default {
    components: {
        Terminal,
        StateChip,
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

        /** Сервисы стека: из них берутся цели для оболочки */
        services: {
            type: Array,
            default: () => [],
        },

        /** Просьба открыть оболочку, приходит из таблицы сервисов */
        request: {
            type: Object,
            default: null,
        },
    },
    data() {
        return {
            sessions: [],
            activeKey: "",
        };
    },
    computed: {
        /** Открытая сессия: от нее зависит подпись под консолью */
        activeSession() {
            return this.sessions.find(session => session.key === this.activeKey) ?? null;
        },

        /**
         * Есть ли канал до контейнера. Локальный стек слушает наш сокет,
         * стек агента - соединение с этим агентом
         */
        connected() {
            if (this.endpoint === "") {
                return this.$root.socketIO.connected;
            }

            return this.$root.agentStatusList[this.endpoint] === "online";
        },

        /** Кому можно открыть оболочку: остановленный контейнер ее не даст */
        shellTargets() {
            return this.services.filter(service => service.running).map(service => service.name);
        },
    },
    watch: {
        request: {
            immediate: true,
            handler(value) {
                if (value?.serviceName) {
                    this.openShell(value);
                }
            },
        },
    },
    beforeUnmount() {
        this.observer?.disconnect();
    },
    methods: {
        /**
         * Открыть shell контейнера. Имя сессии содержит оболочку, поэтому sh и bash
         * никогда не делят один PTY
         * @param {object} target Сервис и оболочка
         * @returns {void}
         */
        openShell({ serviceName, shell = "sh" }) {
            const key = getContainerExecTerminalName(this.endpoint, this.stackName, serviceName, shell, 0);

            if (!this.sessions.some(item => item.key === key)) {
                this.sessions.push({
                    key,
                    label: `${serviceName} · ${shell}`,
                    stackName: this.stackName,
                    endpoint: this.endpoint,
                    serviceName,
                    shell,
                });
            }

            this.activate(key);
        },

        activate(key) {
            this.activeKey = key;

            // Скрытый xterm не знает своего размера: после показа его надо подогнать
            this.$nextTick(() => {
                this.watchBody();
                this.fitActive();
            });
        },

        close(key) {
            this.sessions = this.sessions.filter(item => item.key !== key);

            if (this.activeKey === key) {
                this.activeKey = this.sessions[this.sessions.length - 1]?.key ?? "";
                this.$nextTick(() => {
                    this.fitActive();
                });
            }
        },

        /**
         * Следить за размером области консоли. Высота считается от экрана, и после
         * изменения окна старая сетка xterm налезала на подпись
         * @returns {void}
         */
        watchBody() {
            if (this.observer || !this.$refs.body) {
                return;
            }

            this.observer = new ResizeObserver(() => {
                requestAnimationFrame(() => {
                    this.refit();
                });
            });
            this.observer.observe(this.$refs.body);
        },

        /** Подогнать показанную сессию под область */
        refit() {
            this.$refs[`terminal-${this.activeKey}`]?.[0]?.updateTerminalSize?.();
        },

        /** Подогнать показанную сессию и отдать ей ввод */
        fitActive() {
            this.refit();

            // Открытая сессия ждет ввода: без этого первое слово уходит в кнопку,
            // с которой ее открыли, и человек думает, что оболочка не отвечает
            this.$refs[`terminal-${this.activeKey}`]?.[0]?.terminal?.focus?.();
        },
    },
};
</script>

<style lang="scss" scoped>
// Терминал собран из общей анатомии панели. Свои здесь только вкладки сессий
// и правило роста: с открытой оболочкой панель тянется до низа страницы
.terminals.fill {
    flex: 1;
}

// Вкладки стоят на нижней линии шапки, поэтому у шапки нет отступа по вертикали
.terminal-bar {
    flex-wrap: nowrap;
    padding-block: 0;
}

.terminal-tabs {
    display: flex;
    align-items: stretch;
    align-self: stretch;
    gap: var(--gap-xs);
    overflow-x: auto;
    flex: 1;
    min-width: 0;
}

.terminal-tabs .panel-title {
    min-height: var(--panel-bar-height);
}

.terminal-state {
    flex: none;
}

// Вкладка отмечается подчеркиванием: рамка читалась как кнопка,
// а нажатие вкладки не действие, а выбор
.terminal-tab {
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    border-radius: var(--radius-control) var(--radius-control) 0 0;
    padding-right: var(--gap-xs);

    &:hover {
        background-color: var(--surface-raised);
    }

    &.active {
        border-bottom-color: var(--accent);

        .label {
            color: var(--text-strong);
            font-weight: var(--weight-medium);
        }
    }

    .label, .close {
        background: none;
        border: 0;
        // Вместе с подчеркиванием вкладка ровно высоты шапки: линия ложится на ее край
        min-height: calc(var(--panel-bar-height) - 2px);
        color: var(--text-muted);
        font-size: var(--text-sm);

        &:focus-visible {
            outline: var(--focus-ring);
            outline-offset: var(--focus-offset);
        }
    }

    .label {
        display: flex;
        align-items: center;
        gap: var(--gap-sm);
        padding: 0 var(--gap-sm);
        border-radius: var(--radius-control) var(--radius-control) 0 0;

        &:hover {
            color: var(--text-strong);
        }
    }

    .close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        // Крестик - отдельная цель нажатия, поэтому он не мельче контрола
        width: var(--control-height);
        border-radius: var(--radius-control);
        color: var(--text-faint);

        &:hover {
            background-color: var(--surface-sunken);
            color: var(--state-failed);
        }
    }
}

.new-session {
    flex: none;
}

// Пока оболочки нет, вкладка предлагает выбор, а не пустую черноту
.terminal-start {
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    padding-block: var(--gap-lg);
}

.start-note {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
}

.start-targets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-sm);
}

.terminal-body {
    flex: 1;
    min-height: 280px;
}

.pane {
    height: 100%;
}

.session-terminal {
    height: 100%;
}
</style>
