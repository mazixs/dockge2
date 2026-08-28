<template>
    <!-- Общий уровень для вывода: он живёт под любым экраном и не пропадает при переходах -->
    <div class="dock" :class="{ collapsed, empty: sessions.length === 0 }" :style="dockStyle">
        <div class="bar">
            <button
                v-if="sessions.length > 0"
                class="toggle" type="button" :aria-expanded="String(!collapsed)"
                :title="collapsed ? $t('dockExpand') : $t('dockCollapse')"
                @click="collapsed = !collapsed"
            >
                <font-awesome-icon :icon="collapsed ? 'chevron-up' : 'chevron-down'" />
            </button>

            <div class="tabs" role="tablist">
                <!-- Закрытие - отдельная кнопка рядом с вкладкой: кнопку в кнопку
                     вложить нельзя, иначе крестик недоступен с клавиатуры -->
                <div
                    v-for="session in sessions" :key="session.key"
                    class="tab" :class="{ active: session.key === activeKey }"
                    :title="session.stackName"
                >
                    <button
                        class="label" type="button" role="tab"
                        :aria-selected="String(session.key === activeKey)"
                        @click="activate(session.key)"
                    >
                        <font-awesome-icon :icon="session.kind === 'logs' ? 'stream' : 'terminal'" class="me-2" />
                        {{ session.label }}
                    </button>
                    <button class="close" type="button" :title="$t('dockCloseSession')" :aria-label="`${$t('dockCloseSession')}: ${session.label}`" @click="close(session.key)">
                        <font-awesome-icon icon="times" />
                    </button>
                </div>
            </div>

            <span v-if="sessions.length === 0" class="dock-empty">{{ $t("dockEmpty") }}</span>

            <!-- Кнопка сессии есть всегда: док - общий уровень, а не всплывающая панель -->
            <BDropdown right :text="$t('dockNewSession')" variant="normal" size="sm" class="new-session" dropup>
                <BDropdownItem v-for="stack in openableStacks" :key="stack.key" @click="openLogs(stack.name, stack.endpoint)">
                    <font-awesome-icon icon="stream" class="me-1" />{{ $t("logsOf", [ stack.name ]) }}
                </BDropdownItem>
                <BDropdownItem v-if="openableStacks.length === 0" disabled>{{ $t("noStacksYet") }}</BDropdownItem>
            </BDropdown>

            <button v-if="sessions.length > 0" class="close-all" type="button" :title="$t('dockCloseAll')" @click="closeAll">
                <font-awesome-icon icon="times" />
            </button>
        </div>

        <!-- Полоса перетаскивания: высота дока принадлежит человеку и запоминается -->
        <div
            v-show="!collapsed" class="grip" role="separator" aria-orientation="horizontal"
            :aria-label="$t('dockResize')" tabindex="0"
            @mousedown="startResize" @keydown="onGripKey"
        ></div>

        <div v-show="!collapsed" class="body">
            <!-- Сессии остаются живыми: v-show, потому что размонтирование убивает shell -->
            <div v-for="session in sessions" v-show="session.key === activeKey" :key="session.key" class="pane">
                <Terminal
                    :ref="`terminal-${session.key}`"
                    class="dock-terminal"
                    :name="session.key"
                    :endpoint="session.endpoint"
                    :stack-name="session.stackName"
                    :service-name="session.serviceName"
                    :shell="session.shell"
                    :mode="session.kind === 'logs' ? 'displayOnly' : 'interactive'"
                    :rows="20"
                />
            </div>
        </div>
    </div>
</template>

<script>
import Terminal from "./Terminal.vue";
import { getCombinedTerminalName, getContainerExecTerminalName } from "../../../common/util-common";

/** Пределы высоты дока: ниже вывод не читается, выше он съедает экран */
const MIN_HEIGHT = 160;
const HEIGHT_KEY = "dockHeight";
const STEP = 40;

export default {
    components: {
        Terminal,
    },
    data() {
        return {
            sessions: [],
            activeKey: "",
            collapsed: false,
            height: this.storedHeight(),
            resizing: false,
        };
    },
    computed: {
        dockStyle() {
            if (this.sessions.length === 0 || this.collapsed) {
                return { height: "auto" };
            }
            return { height: `${this.height}px` };
        },

        /** Стеки, чей вывод можно открыть: список тот же, что на экране */
        openableStacks() {
            return Object.values(this.$root.completeStackList)
                .filter((stack) => stack.isManagedByDockge)
                .sort((first, second) => first.name.localeCompare(second.name))
                .map((stack) => ({
                    key: `${stack.endpoint ?? ""}//${stack.name}`,
                    name: stack.name,
                    endpoint: stack.endpoint ?? "",
                }));
        },
    },
    watch: {
        // Свёрнутый док занимает только полосу: место под страницей меняется вместе с ним
        collapsed() {
            this.applyBodyPadding();
        },
        "sessions.length"() {
            this.applyBodyPadding();
        },
    },
    mounted() {
        window.addEventListener("mousemove", this.onResize);
        window.addEventListener("mouseup", this.stopResize);
        this.applyBodyPadding();
    },
    unmounted() {
        window.removeEventListener("mousemove", this.onResize);
        window.removeEventListener("mouseup", this.stopResize);
        document.body.style.paddingBottom = "";
    },
    methods: {
        /**
         * Открыть вывод стека: одна сессия на стек, повторный вызов только показывает её
         * @param {string} stackName Имя стека
         * @param {string} endpoint Агент
         * @returns {void}
         */
        openLogs(stackName, endpoint = "") {
            const key = getCombinedTerminalName(endpoint, stackName);

            this.$root.emitAgent(endpoint, "joinCombinedTerminal", stackName, (res) => {
                if (!res?.ok) {
                    this.$root.toastRes(res);
                }
            });

            this.add({
                key,
                kind: "logs",
                label: stackName,
                stackName,
                endpoint,
                serviceName: "",
                shell: "",
            });
        },

        /**
         * Открыть shell контейнера. Имя сессии содержит оболочку, поэтому sh и bash
         * никогда не делят один PTY
         * @param {object} target Стек, сервис, оболочка и агент
         * @returns {void}
         */
        openShell({ stackName, serviceName, shell = "bash", endpoint = "" }) {
            this.add({
                key: getContainerExecTerminalName(endpoint, stackName, serviceName, shell, 0),
                kind: "shell",
                label: `${serviceName} · ${shell}`,
                stackName,
                endpoint,
                serviceName,
                shell,
            });
        },

        /**
         * Держит ли док вывод этого стека: инспектор по этому решает, отключаться ли от него
         * @param {string} stackName Имя стека
         * @param {string} endpoint Агент
         * @returns {boolean} Есть ли такая сессия
         */
        hasLogs(stackName, endpoint = "") {
            const key = getCombinedTerminalName(endpoint, stackName);
            return this.sessions.some(session => session.key === key);
        },

        add(session) {
            if (!this.sessions.some(item => item.key === session.key)) {
                this.sessions.push(session);
            }

            this.collapsed = false;
            this.activate(session.key);
        },

        activate(key) {
            this.activeKey = key;

            // Скрытый xterm не знает своего размера: после показа его надо подогнать
            this.$nextTick(() => {
                this.fitActive();
            });
        },

        close(key) {
            const session = this.sessions.find(item => item.key === key);
            this.sessions = this.sessions.filter(item => item.key !== key);

            // Вывод стека следит за логами, поэтому уходить надо явно
            if (session?.kind === "logs") {
                this.$root.emitAgent(session.endpoint, "leaveCombinedTerminal", session.stackName, () => {});
            }

            if (this.activeKey === key) {
                this.activeKey = this.sessions[this.sessions.length - 1]?.key ?? "";
                this.$nextTick(() => {
                    this.fitActive();
                });
            }

            this.applyBodyPadding();
        },

        closeAll() {
            for (const session of [ ...this.sessions ]) {
                this.close(session.key);
            }
        },

        fitActive() {
            this.$refs[`terminal-${this.activeKey}`]?.[0]?.updateTerminalSize?.();
            this.applyBodyPadding();
        },

        storedHeight() {
            const stored = Number.parseInt(window.localStorage.getItem(HEIGHT_KEY) ?? "", 10);

            if (Number.isNaN(stored)) {
                return 280;
            }

            return Math.min(Math.max(stored, MIN_HEIGHT), this.maxHeight());
        },

        maxHeight() {
            return Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.7));
        },

        setHeight(value) {
            this.height = Math.min(Math.max(Math.round(value), MIN_HEIGHT), this.maxHeight());
            window.localStorage.setItem(HEIGHT_KEY, String(this.height));
            this.$nextTick(() => {
                this.fitActive();
            });
        },

        startResize(event) {
            this.resizing = true;
            event.preventDefault();
        },

        onResize(event) {
            if (!this.resizing) {
                return;
            }
            this.setHeight(window.innerHeight - event.clientY);
        },

        stopResize() {
            this.resizing = false;
        },

        /**
         * Высоту можно менять и с клавиатуры: полоса получает фокус
         * @param {KeyboardEvent} event Нажатие
         * @returns {void}
         */
        onGripKey(event) {
            if (event.key === "ArrowUp") {
                this.setHeight(this.height + STEP);
                event.preventDefault();
            } else if (event.key === "ArrowDown") {
                this.setHeight(this.height - STEP);
                event.preventDefault();
            }
        },

        /** Страница не должна прятать свои кнопки под доком */
        applyBodyPadding() {
            // Пустой док - только полоса: страница получает место под неё
            if (this.sessions.length === 0) {
                document.body.style.paddingBottom = "48px";
                return;
            }

            document.body.style.paddingBottom = this.collapsed ? "48px" : `${this.height + 8}px`;
        },
    },
};
</script>

<style lang="scss" scoped>
.dock {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1030;
    display: flex;
    flex-direction: column;
    background-color: var(--surface-panel);
    border-top: 1px solid var(--line-hair);
    box-shadow: var(--shadow-panel);
}

.bar {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: var(--gap-xs) var(--gap-sm);
    min-height: var(--row-height);
}

.toggle, .close-all {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    background: none;
    border: 0;
    border-radius: var(--radius-control);
    color: var(--text-faint);
    width: var(--control-height);
    height: var(--control-height);

    &:hover {
        background-color: var(--surface-raised);
        color: var(--text-strong);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.tabs {
    display: flex;
    align-items: stretch;
    gap: var(--gap-xs);
    overflow-x: auto;
    flex: 1;
    min-width: 0;
}

// Вкладка отмечается подчёркиванием: рамка читалась как кнопка,
// а нажатие вкладки не действие, а выбор
.tab {
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

    // Активная вкладка помечена подчёркиванием, а не рамкой
    &.active {
        border-bottom-color: var(--accent);

        .label {
            color: var(--text-strong);
            font-weight: 500;
        }
    }

    .label, .close {
        background: none;
        border: 0;
        min-height: var(--control-height);
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

// Полоса перетаскивания: под курсором она обязана быть видна, иначе высоту
// дока не найти мышью
.grip {
    height: 6px;
    flex: none;
    cursor: row-resize;
    background-color: var(--line-hair);

    &:hover {
        background-color: var(--accent);
    }

    &:focus-visible {
        background-color: var(--accent);
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.body {
    flex: 1;
    min-height: 0;
    padding: var(--gap-sm);
}

.dock-empty {
    color: var(--text-faint);
    font-size: var(--text-sm);
}

.new-session {
    margin-left: auto;
}

// Консоль в доке - оформленная панель, а не вырезанный прямоугольник
.pane {
    height: 100%;
    border-radius: var(--radius-panel);
    overflow: hidden;
    background-color: var(--surface-console);
}

.dock-terminal {
    height: 100%;
}
</style>
