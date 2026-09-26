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
                    <form role="search" @submit.prevent>
                        <input v-model="searchText" type="search" class="form-control search-input" autocomplete="off" :placeholder="$t('searchStacksPlaceholder')" :aria-label="$t('searchStacksPlaceholder')" />
                    </form>
                </div>

                <!-- Фильтры - кнопки с aria-pressed, а не вкладки и не метки -->
                <details class="filter-disclosure" :open="Boolean(activeFilter)">
                    <summary>{{ $t("filterStacks") }}<span v-if="activeFilter"> · {{ filters.find(filter => filter.key === activeFilter)?.label }}</span></summary>
                    <div class="filters">
                        <button
                            v-for="filter in filters" :key="filter.key"
                            class="filter" type="button"
                            :aria-pressed="activeFilter === filter.key"
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

            <div v-for="group in groups" :key="group.key" class="stack-list-inner">
                <button
                    v-if="$root.agentCount > 1"
                    class="agent-select" type="button"
                    :aria-expanded="!closedAgents.has(group.key)"
                    @click="toggleAgent(group.key)"
                >
                    <font-awesome-icon :icon="closedAgents.has(group.key) ? 'chevron-circle-right' : 'chevron-circle-down'" />
                    <span>{{ group.server }}</span>
                    <span class="count">{{ group.total }}</span>
                </button>

                <template v-if="$root.agentCount === 1 || !closedAgents.has(group.key)">
                    <StackListItem v-for="item in rowsOf(group, 'managed')" :key="`${group.key}/${item.name}`" :stack="item" />
                    <button v-if="hiddenCount(group, 'managed') > 0" class="more-rows" type="button" @click="showMore(group, 'managed')">
                        {{ $t("listShowMore", [ Math.min(hiddenCount(group, 'managed'), pageSize) ]) }}
                    </button>

                    <!-- Compose projects started past the panel: listed, since they run on
                         the machine, but folded away so they do not bury the owner's stacks -->
                    <template v-if="group.foreign.length > 0">
                        <button
                            class="fold-toggle" type="button"
                            :aria-expanded="isFoldOpen(group, 'foreign')"
                            :title="$t('otherProjectsHint')"
                            @click="toggleFold(group, 'foreign')"
                        >
                            <font-awesome-icon icon="chevron-down" class="chevron" />
                            <span>{{ $t("otherProjects") }}</span>
                            <span class="count">{{ group.foreign.length }}</span>
                        </button>
                        <template v-if="isFoldOpen(group, 'foreign')">
                            <StackListItem v-for="item in rowsOf(group, 'foreign')" :key="`${group.key}/${item.name}`" :stack="item" />
                            <button v-if="hiddenCount(group, 'foreign') > 0" class="more-rows" type="button" @click="showMore(group, 'foreign')">
                                {{ $t("listShowMore", [ Math.min(hiddenCount(group, 'foreign'), pageSize) ]) }}
                            </button>
                        </template>
                    </template>

                    <!-- Containers of no compose project: docker run and other tools -->
                    <template v-if="group.standalone.length > 0">
                        <button
                            class="fold-toggle" type="button"
                            :aria-expanded="isFoldOpen(group, 'standalone')"
                            :title="$t('standaloneContainersHint')"
                            @click="toggleFold(group, 'standalone')"
                        >
                            <font-awesome-icon icon="chevron-down" class="chevron" />
                            <span>{{ $t("standaloneContainers") }}</span>
                            <span class="count">{{ group.standalone.length }}</span>
                        </button>
                        <template v-if="isFoldOpen(group, 'standalone')">
                            <ContainerListItem v-for="item in rowsOf(group, 'standalone')" :key="`${group.key}/${item.id}`" :container="item" :endpoint="group.endpoint" />
                            <button v-if="hiddenCount(group, 'standalone') > 0" class="more-rows" type="button" @click="showMore(group, 'standalone')">
                                {{ $t("listShowMore", [ Math.min(hiddenCount(group, 'standalone'), pageSize) ]) }}
                            </button>
                        </template>
                    </template>
                </template>
            </div>
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import EmptyState from "../components/EmptyState.vue";
import StackListItem from "../components/StackListItem.vue";
import ContainerListItem from "../components/ContainerListItem.vue";
import { RUNNING, UNKNOWN, stackNeedsAttention } from "../../../common/util-common";
import {
    LIST_PAGE_SIZE,
    compareStacks,
    containerMatchesFilter,
    containerSearchFields,
    isStackStopped,
    matchesSearch,
    pageRows,
    readListFilter,
    stackMatchesFilter,
    stackSearchFields,
    withListQuery,
    type ListFilter,
    type ListedStack,
} from "../stack-list-model";
import type { StandaloneContainer } from "../../../common/types/container";

/** Rows of one server in the list */
interface ListGroup {
    /** "current" for this server, the endpoint for an agent */
    key : string;
    /** Endpoint of the server, empty for this one */
    endpoint : string;
    /** Name of the server as the header shows it */
    server : string;
    managed : ListedStack[];
    foreign : ListedStack[];
    standalone : StandaloneContainer[];
    total : number;
}

type GroupKind = "managed" | "foreign" | "standalone";
type FoldKind = Exclude<GroupKind, "managed">;

export default defineComponent({
    components: {
        ContainerListItem,
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
            /** Строка поиска живет в адресе вместе с фильтром: срез можно открыть ссылкой */
            searchText: typeof this.$route.query.q === "string" ? this.$route.query.q : "",
            /** Нажатый фильтр. Живет в адресе, поэтому счетчик в шапке может привести сразу к нужному срезу */
            activeFilter: readListFilter(this.$route.query.filter),
            closedAgents: new Set<string>(),
            /** Folded groups the user unfolded, as "server:kind"; folded by default */
            openGroups: new Set<string>(),
            /** Rows drawn per group, as "server:kind", beyond the first page */
            limits: {} as Record<string, number>,
            pageSize: LIST_PAGE_SIZE,
        };
    },
    computed: {
        needle() : string {
            return this.searchText.trim().toLowerCase();
        },

        /** Stacks of the servers in view, before search and filter */
        stacksInView() : ListedStack[] {
            return Object.values(this.$root.completeStackList).filter(stack => this.inView(stack.endpoint || ""));
        },

        /** Containers outside every project of the servers in view, before search and filter */
        containersInView() : { endpoint : string; container : StandaloneContainer }[] {
            return Object.entries(this.$root.hostContainers)
                .filter(([ endpoint ]) => this.inView(endpoint))
                .flatMap(([ endpoint, host ]) => host.standalone.map((container) => ({ endpoint,
                    container })));
        },

        /**
         * Rows after search and filter, grouped by server: this server first, the rest
         * by name; stacks by state with the alarming ones on top
         * @returns Groups of the list
         */
        groups() : ListGroup[] {
            const groups = new Map<string, ListGroup>();
            const groupOf = (endpoint : string) : ListGroup => {
                const key = endpoint || "current";
                let group = groups.get(key);
                if (!group) {
                    group = { key,
                        endpoint,
                        server: this.serverName(endpoint),
                        managed: [],
                        foreign: [],
                        standalone: [],
                        total: 0 };
                    groups.set(key, group);
                }
                return group;
            };

            for (const stack of this.stacksInView) {
                const endpoint = stack.endpoint || "";
                if (stackMatchesFilter(stack, this.activeFilter) && matchesSearch(this.needle, stackSearchFields(stack, this.serverName(endpoint)))) {
                    const group = groupOf(endpoint);
                    (stack.isManagedByDockge ? group.managed : group.foreign).push(stack);
                }
            }
            for (const { endpoint, container } of this.containersInView) {
                if (containerMatchesFilter(container, this.activeFilter) && matchesSearch(this.needle, containerSearchFields(container, this.serverName(endpoint)))) {
                    groupOf(endpoint).standalone.push(container);
                }
            }

            for (const group of groups.values()) {
                group.managed.sort(compareStacks);
                group.foreign.sort(compareStacks);
                group.total = group.managed.length + group.foreign.length + group.standalone.length;
            }

            return [ ...groups.values() ].sort((a, b) => {
                if (a.key === "current" || b.key === "current") {
                    return a.key === "current" ? -1 : 1;
                }
                return a.server.localeCompare(b.server);
            });
        },

        stackListStyle() : Record<string, string> {
            // Шапка списка: поиск с фильтрами плюс строка заголовков колонок
            return {
                "height": "calc(100% - 96px)"
            };
        },

        /** Сколько строк осталось после поиска и фильтра */
        visibleCount() : number {
            return this.groups.reduce((sum, group) => sum + group.total, 0);
        },

        /** Список сужен рукой: пусто из-за поиска или фильтра, а не из-за отсутствия стеков */
        isNarrowed() : boolean {
            return this.needle !== "" || Boolean(this.activeFilter);
        },

        /**
         * Whether the first stack list is still on its way.
         *
         * `stackListAt` stays zero until a list has actually arrived, which separates
         * "the server has not answered yet" from "the server answered, there is
         * nothing". Before this the two looked identical and the waiting screen
         * offered to create a first stack.
         * @returns Признак ожидания первого списка
         */
        awaitingFirstList() : boolean {
            return this.$root.stackListAt === 0;
        },

        /**
         * Фильтры со своими счетчиками. Счетчик считается по всему списку, а не по
         * отфильтрованному, иначе кнопка меняла бы свое число от собственного нажатия.
         * Отдельные контейнеры считаются тоже: число обещает ровно те строки, которые
         * покажет нажатие
         * @returns Ключ, подпись и счетчик
         */
        filters() : { key : ListFilter; label : string; count : number }[] {
            const stacks = this.stacksInView;
            const containers = this.containersInView.map((row) => row.container);
            const count = (filter : ListFilter) => containers.filter((container) => containerMatchesFilter(container, filter)).length;

            return [
                { key: "running",
                    label: this.$t("filterRunning"),
                    count: stacks.filter((stack) => stack.status === RUNNING).length + count("running") },
                { key: "attention",
                    label: this.$t("filterAttention"),
                    count: stacks.filter((stack) => stackNeedsAttention(stack)).length + count("attention") },
                { key: "stopped",
                    label: this.$t("filterStopped"),
                    count: stacks.filter((stack) => isStackStopped(stack)).length + count("stopped") },
                { key: "unknown",
                    label: this.$t("filterUnknown"),
                    count: stacks.filter((stack) => stack.status === UNKNOWN).length + count("unknown") },
                { key: "updates",
                    label: this.$t("filterUpdates"),
                    count: stacks.filter((stack) => stackMatchesFilter(stack, "updates")).length },
            ];
        },
    },
    watch: {
        "$route.query.filter"(value : unknown) {
            this.activeFilter = readListFilter(value);
        },
        "$route.query.q"(value : unknown) {
            const text = typeof value === "string" ? value : "";
            if (text !== this.searchText) {
                this.searchText = text;
            }
        },
        searchText(value : string) {
            const current = typeof this.$route.query.q === "string" ? this.$route.query.q : "";
            if (value !== current) {
                this.$router.replace({ path: this.$route.path,
                    query: withListQuery(this.$route.query, "q", value) });
            }
        },
    },
    methods: {
        /**
         * Whether a server is in view: all of them, or the one chosen in the switcher
         * @param endpoint Endpoint, empty for this server
         * @returns Whether its rows are listed
         */
        inView(endpoint : string) : boolean {
            return this.$root.selectedEndpoint === null || endpoint === this.$root.selectedEndpoint;
        },

        /**
         * Name of a server as the list shows it and the search finds it
         * @param endpoint Endpoint, empty for this server
         * @returns Its name
         */
        serverName(endpoint : string) : string {
            return endpoint ? this.$root.endpointDisplayFunction(endpoint) || endpoint : this.$t("currentEndpoint");
        },

        /**
         * Clear the search bar
         */
        clearSearchText() {
            this.searchText = "";
        },

        /**
         * Вернуть весь список: снять поиск и нажатый фильтр разом
         */
        resetSearchAndFilter() {
            this.clearSearchText();

            if (this.activeFilter) {
                this.toggleFilter(this.activeFilter);
            }
        },

        /**
         * Fold or unfold every row of one server
         * @param key Key of the server group
         */
        toggleAgent(key : string) {
            if (this.closedAgents.has(key)) {
                this.closedAgents.delete(key);
            } else {
                this.closedAgents.add(key);
            }
        },

        /**
         * Rows of one part of a group to draw now
         * @param group Server group
         * @param kind Part of the group
         * @returns The first pages, and the open row if it lies further down
         */
        rowsOf<K extends GroupKind>(group : ListGroup, kind : K) : ListGroup[K] {
            const limit = this.limits[`${group.key}:${kind}`] ?? LIST_PAGE_SIZE;
            if (kind === "standalone") {
                return pageRows(group.standalone, limit, (row) => this.isCurrentContainer(group, row)) as ListGroup[K];
            }
            return pageRows(group[kind] as ListedStack[], limit, (row) => this.isCurrentStack(row)) as ListGroup[K];
        },

        /**
         * How many rows of one part of a group are not drawn yet
         * @param group Server group
         * @param kind Part of the group
         * @returns Rows left
         */
        hiddenCount(group : ListGroup, kind : GroupKind) : number {
            return group[kind].length - this.rowsOf(group, kind).length;
        },

        /**
         * Draw the next page of one part of a group
         * @param group Server group
         * @param kind Part of the group
         */
        showMore(group : ListGroup, kind : GroupKind) {
            const key = `${group.key}:${kind}`;
            this.limits[key] = (this.limits[key] ?? LIST_PAGE_SIZE) + LIST_PAGE_SIZE;
        },

        /**
         * @param stack Stack of the list
         * @returns Whether it is the stack the page shows
         */
        isCurrentStack(stack : ListedStack) : boolean {
            return this.$route.params.stackName === stack.name && (this.$route.params.endpoint ?? "") === (stack.endpoint || "");
        },

        /**
         * @param group Server group
         * @param container Container of the list
         * @returns Whether it is the container the page shows
         */
        isCurrentContainer(group : ListGroup, container : StandaloneContainer) : boolean {
            return this.$route.params.containerId === container.id && (this.$route.params.endpoint ?? "") === group.endpoint;
        },

        /**
         * Whether a folded part of a server is shown. A search, a filter or an open row
         * unfolds it: the user asked for exactly these rows
         * @param group Server group
         * @param kind Folded part
         * @returns Whether it is unfolded
         */
        isFoldOpen(group : ListGroup, kind : FoldKind) : boolean {
            if (this.openGroups.has(`${group.key}:${kind}`) || this.isNarrowed) {
                return true;
            }
            return kind === "standalone"
                ? group.standalone.some((row) => this.isCurrentContainer(group, row))
                : group.foreign.some((row) => this.isCurrentStack(row));
        },

        /**
         * Fold or unfold a part of a server
         * @param group Server group
         * @param kind Folded part
         */
        toggleFold(group : ListGroup, kind : FoldKind) {
            const key = `${group.key}:${kind}`;
            // A part unfolded by a search or an open row is not in the set yet: the
            // click keeps it open for good rather than folding what the user sees
            if (this.openGroups.has(key)) {
                this.openGroups.delete(key);
            } else {
                this.openGroups.add(key);
            }
        },

        /**
         * Нажатие на фильтр включает его или снимает: фильтр - переключатель, а не вкладка.
         * Значение уходит в адрес, чтобы срез можно было открыть ссылкой.
         * @param key Ключ фильтра
         */
        toggleFilter(key : ListFilter) {
            const next = this.activeFilter === key ? "" : key;
            this.activeFilter = next;
            this.$router.replace({ path: this.$route.path,
                query: withListQuery(this.$route.query, "filter", next) });
        },
    },
});
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
.fold-toggle { display: flex; align-items: center; gap: var(--gap-xs); width: 100%; min-height: var(--control-height); margin-top: var(--gap-sm); padding: 0 var(--gap-sm); background: none; border: 0; border-top: 1px solid var(--line-hair); color: var(--text-muted); font-size: var(--text-sm); text-align: start; }
.fold-toggle:hover { color: var(--text-strong); }
.more-rows { display: block; width: 100%; min-height: var(--control-height); margin-bottom: var(--gap-xs); padding: 0 var(--gap-sm); background: none; border: 1px dashed var(--line-hair); border-radius: var(--radius-panel); color: var(--text-muted); font-size: var(--text-sm); }
.more-rows:hover { color: var(--text-strong); border-color: var(--line-control); }
.more-rows:focus-visible { outline: var(--focus-ring); outline-offset: calc(var(--focus-offset) * -1); }
.fold-toggle:focus-visible { outline: var(--focus-ring); outline-offset: calc(var(--focus-offset) * -1); }
.fold-toggle .count { margin-left: auto; font-variant-numeric: tabular-nums; }
.fold-toggle .chevron { font-size: var(--icon-sm); transition: transform var(--motion-fast) var(--motion-ease); }
.fold-toggle[aria-expanded="false"] .chevron { transform: rotate(-90deg); }
[dir="rtl"] .fold-toggle[aria-expanded="false"] .chevron { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) {
    .fold-toggle .chevron { transition: none; }
}
@media (max-width: 800px) {
    .search-icon { width: 44px; }
    .search-input { padding-left: 44px; }
    .filter-disclosure summary { min-height: var(--control-height-touch); display: flex; align-items: center; }
    .stack-list { max-height: 40dvh; }
}
</style>
