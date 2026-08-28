<template>
    <div class="shadow-box list-box" :style="boxStyle">
        <div class="list-header">
            <div class="header-top">
                <div class="search-wrapper">
                    <a v-if="searchText === ''" class="search-icon">
                        <font-awesome-icon icon="search" />
                    </a>
                    <a v-else class="search-icon" style="cursor: pointer" @click="clearSearchText">
                        <font-awesome-icon icon="times" />
                    </a>
                    <form @submit.prevent>
                        <input v-model="searchText" class="form-control search-input" autocomplete="off" :placeholder="$t('searchStacksPlaceholder')" />
                    </form>
                </div>

                <!-- Фильтры - кнопки с aria-pressed, а не вкладки и не метки -->
                <div class="filters">
                    <button
                        v-for="filter in filters" :key="filter.key"
                        class="filter" type="button"
                        :aria-pressed="String(activeFilter === filter.key)"
                        :class="{ on: activeFilter === filter.key }"
                        @click="toggleFilter(filter.key)"
                    >
                        {{ filter.label }} <span class="count">{{ filter.count }}</span>
                    </button>
                </div>
            </div>

            <!-- Заголовок колонок: что означает каждая часть строки -->
            <div class="columns" aria-hidden="true">
                <span>{{ $t("columnStack") }}</span>
                <span>{{ $t("columnServices") }}</span>
                <span class="right">{{ $t("columnAvailability") }}</span>
                <span class="right">{{ $t("columnUpdates") }}</span>
            </div>
        </div>

        <div ref="stackList" class="stack-list" :class="{ scrollbar: scrollbar }" :style="stackListStyle">
            <div v-if="visibleCount === 0" class="empty-list">
                <p v-if="searchText !== '' || activeFilter">{{ $t("nothingMatchesFilter") }}</p>
                <button v-else class="btn btn-primary" type="button" @click="$root.openCreateStack && $root.openCreateStack()">
                    {{ $t("addFirstStackMsg") }}
                </button>
            </div>

            <div v-for="(agent, agentIndex) in agentStackList" :key="agentIndex" class="stack-list-inner">
                <button
                    v-if="$root.agentCount > 1"
                    class="agent-select" type="button"
                    :aria-expanded="String(!closedAgents.get(agent.endpoint))"
                    @click="closedAgents.set(agent.endpoint, !closedAgents.get(agent.endpoint))"
                >
                    <font-awesome-icon :icon="closedAgents.get(agent.endpoint) ? 'chevron-circle-right' : 'chevron-circle-down'" class="me-1" />
                    <span v-if="agent.endpoint === 'current'">{{ $t("currentEndpoint") }}</span>
                    <span v-else>{{ agent.endpoint }}</span>
                    <span class="count">{{ agent.stacks.length }}</span>
                </button>

                <StackListItem
                    v-for="(item, index) in agent.stacks"
                    v-show="$root.agentCount === 1 || !closedAgents.get(agent.endpoint)" :key="index" :stack="item" :isSelectMode="selectMode"
                    :isSelected="isSelected" :select="select" :deselect="deselect"
                />
            </div>
        </div>
    </div>

    <Confirm ref="confirmPause" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="pauseSelected">
        {{ $t("pauseStackMsg") }}
    </Confirm>
</template>

<script>
import Confirm from "../components/Confirm.vue";
import StackListItem from "../components/StackListItem.vue";
import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING } from "../../../common/util-common";

export default {
    components: {
        Confirm,
        StackListItem,
    },
    props: {
        /** Should the scrollbar be shown */
        scrollbar: {
            type: Boolean,
        },
    },
    data() {
        return {
            searchText: "",
            selectMode: false,
            selectAll: false,
            disableSelectAllWatcher: false,
            selectedStacks: {},
            windowTop: 0,
            /** Нажатый фильтр: attention, stopped, updates или пусто. Живёт в адресе,
             *  поэтому счётчик в шапке может привести сразу к нужному срезу */
            activeFilter: this.$route.query.filter ?? "",
            closedAgents: new Map(),
        };
    },
    computed: {
        /**
         * Improve the sticky appearance of the list by increasing its
         * height as user scrolls down.
         * Not used on mobile.
         * @returns {object} Style for stack list
         */
        boxStyle() {
            if (window.innerWidth > 550) {
                return {
                    height: `calc(100vh - 160px + ${this.windowTop}px)`,
                };
            } else {
                return {
                    height: "calc(100vh - 160px)",
                };
            }

        },

        /**
         * Returns a sorted list of stacks based on the applied filters and search text.
         * @returns {Array} The sorted list of stacks.
         */
        agentStackList() {
            let result = Object.values(this.$root.completeStackList);

            result = result.filter(stack => this.matchesSearch(stack) && this.matchesFilter(stack));

            result.sort((m1, m2) => {

                // sort by managed by dockge
                if (m1.isManagedByDockge && !m2.isManagedByDockge) {
                    return -1;
                } else if (!m1.isManagedByDockge && m2.isManagedByDockge) {
                    return 1;
                }

                // Sort by status, alert first: a stack that needs attention is the one
                // the user came to look at, so it goes above the healthy ones
                if (m1.status !== m2.status) {
                    const rank = (status) => {
                        switch (status) {
                            case ATTENTION:
                                return 0;
                            case RUNNING:
                                return 1;
                            case EXITED:
                                return 2;
                            case CREATED_STACK:
                                return 3;
                            case CREATED_FILE:
                                return 4;
                            default:
                                // UNKNOWN and anything unexpected go last
                                return 5;
                        }
                    };

                    return rank(m1.status) - rank(m2.status);
                }
                return m1.name.localeCompare(m2.name);
            });

            // Group stacks by endpoint, sorting them so the local endpoint is first
            // and the rest are sorted alphabetically
            result = [
                ...result.reduce((acc, stack) => {
                    const endpoint = stack.endpoint || "current";
                    if (!acc.has(endpoint)) {
                        acc.set(endpoint, []);
                    }
                    acc.get(endpoint).push(stack);
                    return acc;
                }, new Map()).entries()
            ].map(([ endpoint, stacks ]) => ({
                endpoint,
                stacks
            })).sort((a, b) => {
                if (a.endpoint === "current" && b.endpoint !== "current") {
                    return -1;
                } else if (a.endpoint !== "current" && b.endpoint === "current") {
                    return 1;
                }
                return a.endpoint.localeCompare(b.endpoint);
            });

            return result;
        },

        isDarkTheme() {
            return document.body.classList.contains("dark");
        },

        stackListStyle() {
            // Шапка списка: поиск с фильтрами плюс строка заголовков колонок
            return {
                "height": "calc(100% - 96px)"
            };
        },

        /** Сколько строк осталось после поиска и фильтра */
        visibleCount() {
            return this.agentStackList.reduce((sum, agent) => sum + agent.stacks.length, 0);
        },

        /**
         * Фильтры со своими счётчиками. Счётчик считается по всему списку, а не по
         * отфильтрованному, иначе кнопка меняла бы своё число от собственного нажатия.
         * @returns {Array<object>} Ключ, подпись и счётчик
         */
        filters() {
            const all = Object.values(this.$root.completeStackList);

            return [
                { key: "attention",
                    label: this.$t("filterAttention"),
                    count: all.filter((stack) => stack.status === ATTENTION).length },
                { key: "stopped",
                    label: this.$t("filterStopped"),
                    count: all.filter((stack) => stack.status === EXITED || stack.status === CREATED_FILE || stack.status === CREATED_STACK).length },
                { key: "updates",
                    label: this.$t("filterUpdates"),
                    count: all.filter((stack) => (stack.source?.behind ?? 0) > 0).length },
            ];
        },
    },
    watch: {
        "$route.query.filter"(value) {
            this.activeFilter = value ?? "";
        },
    },
    mounted() {
        window.addEventListener("scroll", this.onScroll);
    },
    beforeUnmount() {
        window.removeEventListener("scroll", this.onScroll);
    },
    methods: {
        /**
         * Handle user scroll
         * @returns {void}
         */
        onScroll() {
            if (window.top.scrollY <= 133) {
                this.windowTop = window.top.scrollY;
            } else {
                this.windowTop = 133;
            }
        },

        /**
         * Clear the search bar
         * @returns {void}
         */
        clearSearchText() {
            this.searchText = "";
        },

        /**
         * Совпадает ли стек с поиском. Ищем по имени и по именам сервисов: владелец
         * помнит «gotenberg», а не то, в каком стеке он лежит.
         * @param {object} stack Стек из списка
         * @returns {boolean} Показывать ли строку
         */
        matchesSearch(stack) {
            if (this.searchText === "") {
                return true;
            }

            const needle = this.searchText.toLowerCase();

            if (stack.name.toLowerCase().includes(needle)) {
                return true;
            }

            return (stack.services ?? []).some((service) => service.name.toLowerCase().includes(needle));
        },

        /**
         * Совпадает ли стек с нажатым фильтром
         * @param {object} stack Стек из списка
         * @returns {boolean} Показывать ли строку
         */
        matchesFilter(stack) {
            switch (this.activeFilter) {
                case "attention":
                    return stack.status === ATTENTION;
                case "stopped":
                    return stack.status === EXITED || stack.status === CREATED_FILE || stack.status === CREATED_STACK;
                case "updates":
                    return (stack.source?.behind ?? 0) > 0;
                default:
                    return true;
            }
        },

        /**
         * Нажатие на фильтр включает его или снимает: фильтр - переключатель, а не вкладка.
         * Значение уходит в адрес, чтобы срез можно было открыть ссылкой.
         * @param {string} key Ключ фильтра
         * @returns {void}
         */
        toggleFilter(key) {
            const next = this.activeFilter === key ? "" : key;
            this.activeFilter = next;

            const query = { ...this.$route.query };

            if (next) {
                query.filter = next;
            } else {
                delete query.filter;
            }

            this.$router.replace({ path: this.$route.path,
                query });
        },
        /**
         * Deselect a stack
         * @param {number} id ID of stack
         * @returns {void}
         */
        deselect(id) {
            delete this.selectedStacks[id];
        },
        /**
         * Select a stack
         * @param {number} id ID of stack
         * @returns {void}
         */
        select(id) {
            this.selectedStacks[id] = true;
        },
        /**
         * Determine if stack is selected
         * @param {number} id ID of stack
         * @returns {bool} Is the stack selected?
         */
        isSelected(id) {
            return id in this.selectedStacks;
        },
        /**
         * Disable select mode and reset selection
         * @returns {void}
         */
        cancelSelectMode() {
            this.selectMode = false;
            this.selectedStacks = {};
        },
        /**
         * Show dialog to confirm pause
         * @returns {void}
         */
        pauseDialog() {
            this.$refs.confirmPause.show();
        },
        /**
         * Pause each selected stack
         * @returns {void}
         */
        pauseSelected() {
            Object.keys(this.selectedStacks)
                .filter(id => this.$root.stackList[id].active)
                .forEach(id => this.$root.getSocket().emit("pauseStack", id, () => { }));

            this.cancelSelectMode();
        },
        /**
         * Resume each selected stack
         * @returns {void}
         */
        resumeSelected() {
            Object.keys(this.selectedStacks)
                .filter(id => !this.$root.stackList[id].active)
                .forEach(id => this.$root.getSocket().emit("resumeStack", id, () => { }));

            this.cancelSelectMode();
        },
    },
};
</script>

<style lang="scss" scoped>
.list-box {
    position: sticky;
    top: 10px;
    padding: 10px;
}

// Цвет берётся токеном, а не правилом внутри темы: иначе одна из тем получит
// чужой фон под своим текстом.
.list-header {
    background-color: var(--surface-panel);
    border-bottom: 1px solid var(--line-hair);
    border-radius: var(--radius-panel) var(--radius-panel) 0 0;
    margin: -10px -10px 8px;
    padding: 8px 10px;
}

.header-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--gap-md);
    flex-wrap: wrap;
}

.search-wrapper {
    display: flex;
    align-items: center;
    flex: 1 1 220px;
    min-width: 0;

    form {
        flex: 1;
        min-width: 0;
    }
}

.search-icon {
    padding: 0 var(--gap-sm) 0 0;
    color: var(--text-faint);

    svg[data-icon="times"] {
        cursor: pointer;

        &:hover {
            color: var(--state-failed);
        }
    }
}

.search-input {
    width: 100%;
}

// Фильтр - переключатель: нажатое состояние видно рамкой и фоном, а не только цветом
.filters {
    display: flex;
    gap: var(--gap-xs);
    flex-wrap: wrap;
}

.filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: var(--control-height);
    padding: 0 var(--gap-sm);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-control);
    background: none;
    color: var(--text-muted);
    font-size: var(--text-sm);

    &:hover {
        background-color: var(--surface-raised);
        color: var(--text-strong);
    }

    &.on {
        border-color: var(--accent);
        background-color: var(--accent-soft);
        color: var(--text-strong);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }

    .count {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        border-radius: var(--radius-pill);
        padding: 0 5px;
        background-color: var(--surface-sunken);
    }
}

// Заголовок колонок повторяет сетку строки, поэтому подписи стоят над своими данными
.columns {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(120px, max-content) minmax(90px, max-content);
    gap: var(--gap-md);
    padding: 6px var(--gap-md) 0;
    font-size: var(--text-xs);
    color: var(--text-faint);

    .right {
        justify-self: end;
    }
}

.stack-list {
    &.scrollbar {
        overflow-y: auto;
    }
}

.empty-list {
    padding: var(--gap-lg);
    text-align: center;
    color: var(--text-faint);
}

// Группа агента: кнопка, потому что она сворачивает список
.agent-select {
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    width: 100%;
    min-height: var(--control-height);
    padding: 0 var(--gap-md);
    background: none;
    border: 0;
    color: var(--text-faint);
    font-size: var(--text-sm);
    font-weight: 500;

    &:hover {
        color: var(--text-strong);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }

    .count {
        margin-left: auto;
        font-family: var(--font-mono);
    }
}

@media (max-width: 1100px) {
    .list-box {
        position: static;
        height: auto;
    }

    .columns {
        grid-template-columns: minmax(0, 1fr) minmax(90px, max-content);

        span:nth-child(2), span:nth-child(3) {
            display: none;
        }
    }
}
</style>
