<template>
    <div class="list-box">
        <div class="list-header">
            <div class="header-top">
                <div class="search-wrapper">
                    <span v-if="searchText === ''" class="search-icon" aria-hidden="true">
                        <font-awesome-icon icon="search" />
                    </span>
                    <button v-else class="search-icon" type="button" :aria-label="$t('clearSearch')" @click="clearSearchText">
                        <font-awesome-icon icon="times" />
                    </button>
                    <form @submit.prevent>
                        <input v-model="searchText" class="form-control search-input" autocomplete="off" :placeholder="$t('searchStacksPlaceholder')" :aria-label="$t('searchStacksPlaceholder')" />
                    </form>
                </div>

                <!-- Фильтры - кнопки с aria-pressed, а не вкладки и не метки -->
                <details class="filter-disclosure" :open="Boolean(activeFilter)">
                    <summary>{{ $t("filterStacks") }}<span v-if="activeFilter"> · {{ filters.find(filter => filter.key === activeFilter)?.label }}</span></summary>
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
                </details>
            </div>
        </div>

        <div ref="stackList" class="stack-list" :class="{ scrollbar: scrollbar }" :style="stackListStyle">
            <!-- Пока список ни разу не приходил, пусто и "пусто" - разные вещи.
                 Здесь стоял призыв создать первый стек, который видел и тот, у
                 кого их четырнадцать: он просто ждал ответа сервера -->
            <div v-if="awaitingFirstList" class="skeleton-list" role="status" :aria-label="$t('stacksLoading')">
                <div v-for="row in 5" :key="row" class="skeleton-row">
                    <span class="skeleton-mark"></span>
                    <span class="skeleton-lines">
                        <span class="skeleton-line"></span>
                        <span class="skeleton-line short"></span>
                    </span>
                </div>
            </div>

            <div v-else-if="visibleCount === 0" class="empty-list">
                <!-- Пусто по двум разным причинам, и лечатся они разным действием -->
                <EmptyState
                    v-if="isNarrowed"
                    :title="$t('emptyFilteredTitle')"
                    :hint="$t('emptyFilteredHint')"
                >
                    <button type="button" @click="resetSearchAndFilter">
                        {{ $t("emptyFilteredAction") }}
                    </button>
                </EmptyState>

                <EmptyState
                    v-else
                    :title="$t('emptyStacksTitle')"
                    :hint="$t('emptyStacksHint')"
                >
                    <button v-if="$root.canManageStacks" class="primary" type="button" @click="$root.openCreateStack && $root.openCreateStack()">
                        {{ $t("emptyStacksAction") }}
                    </button>
                </EmptyState>
            </div>

            <div v-for="agent in agentStackList" :key="agent.endpoint" class="stack-list-inner">
                <button
                    v-if="$root.agentCount > 1"
                    class="agent-select" type="button"
                    :aria-expanded="String(!closedAgents.get(agent.endpoint))"
                    @click="closedAgents.set(agent.endpoint, !closedAgents.get(agent.endpoint))"
                >
                    <font-awesome-icon :icon="closedAgents.get(agent.endpoint) ? 'chevron-circle-right' : 'chevron-circle-down'" />
                    <span v-if="agent.endpoint === 'current'">{{ $t("currentEndpoint") }}</span>
                    <span v-else>{{ agent.endpoint }}</span>
                    <span class="count">{{ agent.stacks.length }}</span>
                </button>

                <template v-if="$root.agentCount === 1 || !closedAgents.get(agent.endpoint)">
                    <StackListItem
                        v-for="item in agent.managed" :key="item.name" :stack="item" :isSelectMode="selectMode"
                        :isSelected="isSelected" :select="select" :deselect="deselect"
                    />

                    <!-- Compose projects started past the panel: listed, since they run on
                         the machine, but folded away so they do not bury the owner's stacks -->
                    <template v-if="agent.foreign.length > 0">
                        <button
                            class="foreign-toggle" type="button"
                            :aria-expanded="String(isForeignOpen(agent))"
                            :title="$t('otherProjectsHint')"
                            @click="toggleForeign(agent.endpoint)"
                        >
                            <font-awesome-icon icon="chevron-down" class="chevron" />
                            <span>{{ $t("otherProjects") }}</span>
                            <span class="count">{{ agent.foreign.length }}</span>
                        </button>
                        <template v-if="isForeignOpen(agent)">
                            <StackListItem
                                v-for="item in agent.foreign" :key="item.name" :stack="item" :isSelectMode="selectMode"
                                :isSelected="isSelected" :select="select" :deselect="deselect"
                            />
                        </template>
                    </template>
                </template>
            </div>
        </div>
    </div>

    <Confirm ref="confirmPause" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="pauseSelected">
        {{ $t("pauseStackMsg") }}
    </Confirm>
</template>

<script>
import Confirm from "../components/Confirm.vue";
import EmptyState from "../components/EmptyState.vue";
import StackListItem from "../components/StackListItem.vue";
import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN, isStackFailed, stackNeedsAttention } from "../../../common/util-common";

export default {
    components: {
        Confirm,
        EmptyState,
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
            /** Нажатый фильтр: attention, stopped, updates или пусто. Живет в адресе,
             *  поэтому счетчик в шапке может привести сразу к нужному срезу */
            activeFilter: this.$route.query.filter ?? "",
            closedAgents: new Map(),
            /** Servers whose foreign projects the user unfolded; folded by default */
            openForeign: new Set(),
        };
    },
    computed: {
        /**
         * Returns a sorted list of stacks based on the applied filters and search text.
         * @returns {Array} The sorted list of stacks.
         */
        agentStackList() {
            let result = Object.values(this.$root.completeStackList).filter(stack => this.$root.selectedEndpoint === null || (stack.endpoint || "") === this.$root.selectedEndpoint);

            result = result.filter(stack => this.matchesSearch(stack) && this.matchesFilter(stack));

            result.sort((m1, m2) => {

                // sort by managed by dockge
                if (m1.isManagedByDockge && !m2.isManagedByDockge) {
                    return -1;
                } else if (!m1.isManagedByDockge && m2.isManagedByDockge) {
                    return 1;
                }

                // Sort by status, alert first: a crashed or degraded stack is the one
                // the user came to look at, so it goes above the healthy ones
                const rank = (stack) => {
                    switch (stack.status) {
                        case EXITED:
                            return isStackFailed(stack.status, stack.issues) ? 0 : 3;
                        case ATTENTION:
                            return 1;
                        case RUNNING:
                            return 2;
                        case CREATED_STACK:
                            return 4;
                        case CREATED_FILE:
                            return 5;
                        default:
                            // UNKNOWN and anything unexpected go last
                            return 6;
                    }
                };

                if (rank(m1) !== rank(m2)) {
                    return rank(m1) - rank(m2);
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
                stacks,
                managed: stacks.filter((stack) => stack.isManagedByDockge),
                foreign: stacks.filter((stack) => !stack.isManagedByDockge),
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

        /** Список сужен рукой: пусто из-за поиска или фильтра, а не из-за отсутствия стеков */
        isNarrowed() {
            return this.searchText !== "" || Boolean(this.activeFilter);
        },

        /**
         * Фильтры со своими счетчиками. Счетчик считается по всему списку, а не по
         * отфильтрованному, иначе кнопка меняла бы свое число от собственного нажатия.
         * @returns {Array<object>} Ключ, подпись и счетчик
         */
        /**
         * Whether the first stack list is still on its way.
         *
         * `stackListAt` stays zero until a list has actually arrived, which separates
         * "the server has not answered yet" from "the server answered, there is
         * nothing". Before this the two looked identical and the waiting screen
         * offered to create a first stack.
         * @returns {boolean} Признак ожидания первого списка
         */
        awaitingFirstList() {
            return this.$root.stackListAt === 0;
        },

        filters() {
            const all = Object.values(this.$root.completeStackList).filter(stack => this.$root.selectedEndpoint === null || (stack.endpoint || "") === this.$root.selectedEndpoint);

            return [
                { key: "running",
                    label: this.$t("filterRunning"),
                    count: all.filter((stack) => stack.status === RUNNING).length },
                { key: "attention",
                    label: this.$t("filterAttention"),
                    count: all.filter((stack) => stackNeedsAttention(stack)).length },
                { key: "stopped",
                    label: this.$t("filterStopped"),
                    count: all.filter((stack) => this.isStopped(stack)).length },
                { key: "unknown",
                    label: this.$t("filterUnknown"),
                    count: all.filter((stack) => stack.status === UNKNOWN).length },
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
    methods: {

        /**
         * Clear the search bar
         * @returns {void}
         */
        clearSearchText() {
            this.searchText = "";
        },

        /**
         * Вернуть весь список: снять поиск и нажатый фильтр разом. Фильтр живет еще
         * и в адресе, поэтому очистить одно поле мало - его снимает toggleFilter.
         * @returns {void}
         */
        resetSearchAndFilter() {
            this.clearSearchText();

            if (this.activeFilter) {
                this.toggleFilter(this.activeFilter);
            }
        },

        /**
         * Совпадает ли стек с поиском. Ищем по имени и по именам сервисов: владелец
         * помнит "gotenberg", а не то, в каком стеке он лежит.
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
         * Whether the foreign projects of a server are shown. A search, a filter or an
         * open foreign stack unfolds them: the user asked for exactly these rows
         * @param {object} agent Server group of the list
         * @returns {boolean} Whether the group is unfolded
         */
        isForeignOpen(agent) {
            if (this.openForeign.has(agent.endpoint) || this.isNarrowed) {
                return true;
            }
            const current = this.$route.params.stackName;
            return !!current && agent.foreign.some((stack) => stack.name === current && (stack.endpoint || "") === (this.$route.params.endpoint ?? ""));
        },

        /**
         * Fold or unfold the foreign projects of a server
         * @param {string} endpoint Server of the group
         * @returns {void}
         */
        toggleForeign(endpoint) {
            const agent = this.agentStackList.find((item) => item.endpoint === endpoint);
            if (agent && this.isForeignOpen(agent) && !this.openForeign.has(endpoint)) {
                // Unfolded by a search or an open stack: the click keeps it open for good
                this.openForeign.add(endpoint);
                return;
            }
            if (this.openForeign.has(endpoint)) {
                this.openForeign.delete(endpoint);
            } else {
                this.openForeign.add(endpoint);
            }
        },

        /**
         * Stopped by someone rather than crashed: a crash belongs under attention
         * @param {object} stack Stack from the list
         * @returns {boolean} Whether the stack is quietly stopped
         */
        isStopped(stack) {
            return (stack.status === EXITED && !isStackFailed(stack.status, stack.issues)) || stack.status === CREATED_FILE || stack.status === CREATED_STACK;
        },

        /**
         * Совпадает ли стек с нажатым фильтром
         * @param {object} stack Стек из списка
         * @returns {boolean} Показывать ли строку
         */
        matchesFilter(stack) {
            switch (this.activeFilter) {
                case "running":
                    return stack.status === RUNNING;
                case "attention":
                    return stackNeedsAttention(stack);
                case "stopped":
                    return this.isStopped(stack);
                case "unknown":
                    return stack.status === UNKNOWN;
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
.list-box { display: flex; flex-direction: column; min-height: 0; }
.list-header { padding: 0 0 var(--gap-sm); }
.header-top { display: flex; flex-direction: column; gap: var(--gap-sm); }
.search-wrapper { position: relative; }
.search-wrapper form { min-width: 0; }
.search-input { width: 100%; padding-left: 32px; font-size: var(--text-sm); background: var(--surface-base); border-color: var(--line-hair); }
.search-icon { position: absolute; left: 0; top: 0; width: 32px; height: 100%; display: grid; place-items: center; color: var(--text-faint); border: 0; background: none; font-size: var(--text-sm); }
.filter-disclosure summary { color: var(--text-muted); font-size: var(--text-sm); cursor: pointer; padding: var(--gap-xs); }
.filters { display: flex; flex-direction: column; gap: var(--gap-xs); padding-top: var(--gap-xs); }
.filter { display: flex; align-items: center; gap: var(--gap-xs); min-height: var(--control-height); padding: 0 var(--gap-sm); border: 1px solid var(--line-hair); border-radius: var(--radius-control); background: none; color: var(--text-muted); font-size: var(--text-sm); }
.filter.on { border-color: var(--accent); background: var(--accent-soft); color: var(--text-strong); }

// Заготовка строки: та же сетка, что у настоящего стека, поэтому список не
// прыгает, когда ответ приходит и заготовки сменяются именами
.skeleton-list { display: flex; flex-direction: column; gap: var(--gap-xs); padding: var(--gap-sm); }
.skeleton-row { display: flex; align-items: center; gap: var(--gap-sm); min-height: 46px; }
.skeleton-mark { flex: none; width: 28px; height: 28px; border-radius: var(--radius-control); }
.skeleton-lines { display: flex; flex-direction: column; gap: var(--gap-xs); flex: 1; min-width: 0; }
.skeleton-line { height: 9px; border-radius: var(--radius-chip); }
.skeleton-line.short { width: 55%; }

.skeleton-mark, .skeleton-line {
    background: var(--surface-sunken);
    animation: skeleton-pulse 1.4s var(--motion-ease) infinite;
}

.skeleton-row:nth-child(2) .skeleton-mark, .skeleton-row:nth-child(2) .skeleton-line { animation-delay: 80ms; }
.skeleton-row:nth-child(3) .skeleton-mark, .skeleton-row:nth-child(3) .skeleton-line { animation-delay: 160ms; }
.skeleton-row:nth-child(4) .skeleton-mark, .skeleton-row:nth-child(4) .skeleton-line { animation-delay: 240ms; }
.skeleton-row:nth-child(5) .skeleton-mark, .skeleton-row:nth-child(5) .skeleton-line { animation-delay: 320ms; }

@keyframes skeleton-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
}
.filter .count { margin-left: auto; }
.stack-list { overflow-y: auto; overflow-x: hidden; height: auto !important; }
.agent-select { display: flex; align-items: center; gap: var(--gap-xs); width: 100%; min-height: var(--control-height); padding: 0 var(--gap-sm); background: none; border: 0; color: var(--text-faint); font-size: var(--text-sm); }
.agent-select .count { margin-left: auto; }
.foreign-toggle { display: flex; align-items: center; gap: var(--gap-xs); width: 100%; min-height: var(--control-height); margin-top: var(--gap-sm); padding: 0 var(--gap-sm); background: none; border: 0; border-top: 1px solid var(--line-hair); color: var(--text-muted); font-size: var(--text-sm); text-align: start; }
.foreign-toggle:hover { color: var(--text-strong); }
.foreign-toggle:focus-visible { outline: var(--focus-ring); outline-offset: calc(var(--focus-offset) * -1); }
.foreign-toggle .count { margin-left: auto; font-variant-numeric: tabular-nums; }
.foreign-toggle .chevron { font-size: var(--icon-sm); transition: transform var(--motion-fast) var(--motion-ease); }
.foreign-toggle[aria-expanded="false"] .chevron { transform: rotate(-90deg); }
[dir="rtl"] .foreign-toggle[aria-expanded="false"] .chevron { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) {
    .foreign-toggle .chevron { transition: none; }
}
@media (max-width: 800px) {
    .search-icon { width: 44px; }
    .search-input { padding-left: 44px; }
    .filter-disclosure summary { min-height: var(--control-height-touch); display: flex; align-items: center; }
    .stack-list { max-height: 40dvh; }
}
</style>
