<template>
    <div class="page stability-dashboard">
        <div class="page-head">
            <div>
                <h1 id="stability-heading">{{ $t("stabilityTitle") }}</h1>
                <p class="page-lede">{{ $t("pagesContainerSummary") }}</p>
            </div>

            <div class="actions">
                <label class="control-label" for="stability-period">{{ $t("stabilityPeriod") }}</label>
                <select id="stability-period" v-model.number="windowHours" class="form-select form-select-sm period">
                    <option v-for="hours in windows" :key="hours" :value="hours">{{ $t(`availabilityWindow${hours}`) }}</option>
                </select>
                <button class="btn btn-sm btn-normal" type="button" :disabled="loading" @click="reload">
                    <InterfaceIcon name="refresh" />{{ $t("stabilityRefresh") }}
                </button>
            </div>
        </div>

        <!-- Что сломалось - прежде чем сколько: счет говорит "трое требуют
             внимания", а полоса называет их по именам и с причиной -->
        <AttentionStrip />

        <!-- Счет состояний: одна полоса на весь парк, по ней видно, куда смотреть.
             Каждое число - ссылка на тот же срез в списке стеков слева: увидеть,
             что одиннадцать остановлено, и не иметь возможности спросить "какие
             именно" - это половина ответа -->
        <div class="counts" aria-live="polite">
            <router-link
                v-for="state in states" :key="state"
                :to="filterLink(state)"
                :class="[ `count-${state}`, { zero: counts[state] === 0, on: activeFilter === state } ]"
                :aria-pressed="String(activeFilter === state)"
                :title="$t('stabilityCountLink', { state: $t(`stabilityState_${state}`) })"
            >
                <strong>{{ counts[state] }}</strong> {{ $t(`stabilityState_${state}`) }}
            </router-link>
        </div>

        <details class="history-details">
            <summary>{{ $t("pagesCalculation") }}</summary>
            <p class="history-explanation">{{ $t("stabilityMethod") }}</p>
            <div class="history-legend">
                <span v-for="state in states" :key="state"><i :class="`history-${state}`" aria-hidden="true"></i>{{ $t(`stabilityState_${state}`) }}</span>
            </div>
        </details>

        <!-- Сервер - панель, стеки внутри нее - группы строк под тонкими линиями -->
        <section v-for="host in hosts" :key="host.endpoint" class="panel host" :aria-label="host.label">
            <div class="panel-bar">
                <h2 class="panel-title"><InterfaceIcon name="server" />{{ host.label }}</h2>
                <span v-if="!host.online" class="panel-meta host-warning">{{ $t("stabilityAgentOffline") }}</span>
                <span v-else-if="host.overview?.observedAt" class="panel-meta">{{ $t("stabilityObservedAt", [ dateTime(host.overview.observedAt) ]) }}</span>
            </div>

            <p v-if="host.loading && !host.overview" class="panel-body host-message" role="status">{{ $t("stabilityLoading") }}</p>

            <div v-else-if="host.error || host.overview?.error || hostIsStale(host)" class="panel-body host-message" role="status">
                <span>{{ hostMessage(host) }}</span>
                <button v-if="host.online && hostCanRetry(host)" class="btn btn-sm btn-normal" type="button" :disabled="host.loading" @click="loadHost(host.endpoint)">{{ $t("stabilityRetry") }}</button>
            </div>

            <p v-if="host.overview && !hostIsStale(host) && !host.overview.stacks.length" class="panel-body host-message">{{ $t("stabilityEmpty") }}</p>

            <!-- Один сервер - одна таблица: колонки называются один раз и стоят
                 на общей сетке, а стек становится строкой-заголовком внутри нее.
                 Отдельные таблицы на каждый стек ломали эту сетку -->
            <div v-if="(host.overview?.stacks ?? []).length > 0" class="container-table-wrap">
                <table class="container-table">
                    <caption class="visually-hidden">{{ $t("stabilityHostTableCaption", [ host.label ]) }}</caption>
                    <thead>
                        <tr>
                            <th scope="col">{{ $t("stabilityContainer") }}</th>
                            <th scope="col">{{ $t("stabilityState") }}</th>
                            <th scope="col">{{ $t("stabilityUptime") }}</th>
                            <th scope="col">{{ $t("stabilityRestarts") }}</th>
                            <th scope="col">{{ $t("stabilityAvailability") }}</th>
                        </tr>
                    </thead>
                    <tbody v-for="stack in host.overview?.stacks ?? []" :key="stack.name" class="stack-group">
                        <tr class="group-row">
                            <th colspan="5" scope="colgroup">
                                <span class="group-name">
                                    <router-link v-if="stack.managed" :to="stackRoute(stack.name, host.endpoint)">{{ stack.name }}</router-link>
                                    <span v-else>{{ stack.standalone ? $t("stabilityStandalone") : stack.name }}</span>
                                    <span class="group-count">{{ $t("pagesContainers", [stack.containers.length]) }}</span>
                                </span>
                            </th>
                        </tr>
                        <tr v-for="container in stack.containers" :key="container.id">
                            <th scope="row" class="container-name">
                                <span>{{ container.name }}</span>
                                <small v-if="container.service">{{ container.service }}</small>
                            </th>
                            <td>
                                <StateChip
                                    :state="containerState(container, host)"
                                    :label="$t(`stabilityContainerState_${containerState(container, host)}`)"
                                    compact
                                />
                                <small>{{ healthLabel(container, host) }}</small>
                            </td>
                            <td class="uptime-cell">
                                <span>{{ hostIsStale(host) || container.uptimeMs === null ? $t("stabilityNotAvailable") : duration(container.uptimeMs) }}</span>
                                <small v-if="!hostIsStale(host) && container.uptimeMs !== null">{{ $t("stabilitySinceStart") }}</small>
                            </td>
                            <td>{{ hostIsStale(host) || container.restartCount === null ? $t("stabilityNotAvailable") : container.restartCount }}</td>
                            <td class="availability-cell">
                                <div class="availability-value">
                                    <span>{{ availabilityLabel(container) }}</span>
                                    <small>{{ $t("stabilityCoverage", [ percent(container.availability.coveredMs / container.availability.windowMs) ]) }}</small>
                                </div>
                                <div class="container-history" role="img" :aria-label="historyLabel(container)">
                                    <span v-for="(bucket, index) in container.history" :key="index" class="history-bucket" :title="bucketLabel(bucket)">
                                        <i :class="`history-${bucket.state}`" :style="{ width: `${bucket.coverage * 100}%` }"></i>
                                    </span>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { formatDuration, formatPercent } from "../format";
import { STABILITY_WINDOWS, STABILITY_STALE_MS, runtimeStatus, type StabilityOverview, type StabilityContainer, type StabilityHistoryBucket, type StabilityState } from "../../../common/stability";
import { ATTENTION, CREATED_STACK, EXITED, RUNNING } from "../../../common/util-common";
import AttentionStrip from "./AttentionStrip.vue";
import StateChip from "./StateChip.vue";
import InterfaceIcon from "./InterfaceIcon.vue";

interface HostView {
    endpoint : string;
    label : string;
    online : boolean;
    overview : StabilityOverview | null;
    loading : boolean;
    error : boolean;
}

export default defineComponent({
    components: { AttentionStrip,
        StateChip,
        InterfaceIcon },
    data() {
        return {
            windowHours: 24,
            windows: STABILITY_WINDOWS,
            states: [ "running", "attention", "stopped", "unknown" ] as StabilityState[],
            snapshots: {} as Record<string, StabilityOverview>,
            pending: {} as Record<string, boolean>,
            errors: {} as Record<string, boolean>,
            requestIds: {} as Record<string, number>,
            requestTimers: {} as Record<string, ReturnType<typeof setTimeout>>,
            refreshTimer: null as ReturnType<typeof setInterval> | null,
            clockTimer: null as ReturnType<typeof setInterval> | null,
            now: Date.now(),
            disposed: false,
        };
    },
    computed: {
        connections() {
            const endpoints = new Set([ "", ...Object.values(this.$root.agentList ?? {}).map((agent) => agent.endpoint) ]);
            return [ ...endpoints ].filter(endpoint => this.$root.selectedEndpoint === null || endpoint === this.$root.selectedEndpoint).map((endpoint) => ({ endpoint,
                online: this.$root.agentStatusList[endpoint] === "online" }));
        },
        hosts() : HostView[] {
            return this.connections.map(({ endpoint, online }) => ({
                endpoint,
                online,
                label: endpoint ? this.$root.endpointDisplayFunction(endpoint) || endpoint : this.$t("thisServer"),
                overview: this.snapshots[endpoint]?.windowHours === this.windowHours ? this.snapshots[endpoint] ?? null : null,
                loading: this.pending[endpoint] ?? false,
                error: this.errors[endpoint] ?? false,
            }));
        },
        activeFilter() : string {
            return String(this.$route.query.filter ?? "");
        },
        loading() : boolean {
            return Object.values(this.pending).some(Boolean);
        },
        counts() : Record<StabilityState, number> {
            const counts = { running: 0,
                attention: 0,
                stopped: 0,
                unknown: 0 };
            for (const host of this.hosts) {
                for (const stack of host.overview?.stacks ?? []) {
                    for (const container of stack.containers) {
                        counts[this.containerState(container, host)] += 1;
                    }
                }
            }
            return counts;
        },
    },
    watch: {
        windowHours() {
            this.reload();
        },
        connections: {
            deep: true,
            handler() {
                this.reload();
            },
        },
    },
    mounted() {
        this.reload();
        this.refreshTimer = setInterval(() => this.reload(), 30_000);
        this.clockTimer = setInterval(() => {
            this.now = Date.now();
        }, 5_000);
    },
    beforeUnmount() {
        this.disposed = true;
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        if (this.clockTimer) {
            clearInterval(this.clockTimer);
        }
        for (const timer of Object.values(this.requestTimers)) {
            clearTimeout(timer);
        }
    },
    methods: {
        reload() {
            for (const { endpoint, online } of this.connections) {
                if (online) {
                    this.loadHost(endpoint);
                }
            }
        },
        loadHost(endpoint : string) {
            const requestId = (this.requestIds[endpoint] ?? 0) + 1;
            this.requestIds[endpoint] = requestId;
            const previousTimer = this.requestTimers[endpoint];
            if (previousTimer) {
                clearTimeout(previousTimer);
            }
            this.pending[endpoint] = true;
            this.errors[endpoint] = false;
            this.requestTimers[endpoint] = setTimeout(() => {
                if (!this.disposed && this.requestIds[endpoint] === requestId) {
                    this.pending[endpoint] = false;
                    this.errors[endpoint] = true;
                    this.requestIds[endpoint] = requestId + 1;
                }
            }, 10_000);
            this.$root.emitAgent(endpoint, "stabilityOverview", this.windowHours, (response : { ok? : boolean; overview? : StabilityOverview }) => {
                if (this.disposed || this.requestIds[endpoint] !== requestId) {
                    return;
                }
                clearTimeout(this.requestTimers[endpoint]);
                this.pending[endpoint] = false;
                if (response.ok && response.overview) {
                    this.snapshots[endpoint] = response.overview;
                    this.errors[endpoint] = false;
                } else {
                    this.errors[endpoint] = true;
                }
                this.now = Date.now();
            });
        },
        /**
         * Where a count leads. The same count twice is the same question asked
         * twice, and the answer to it is the whole list back
         * @param state Состояние, которое считает эта ссылка
         * @returns Адрес для router-link
         */
        filterLink(state : StabilityState) : { path : string; query : Record<string, string> } {
            const query = { ...this.$route.query } as Record<string, string>;

            if (this.activeFilter === state) {
                delete query.filter;
            } else {
                query.filter = state;
            }

            return { path: "/",
                query };
        },
        /**
         * Whether repeating the request could change anything.
         * Первое наблюдение приходит по времени, а не по просьбе: страница
         * перечитывает данные сама каждые тридцать секунд, и кнопка здесь
         * обещала бы ускорение, которого нет
         * @param host Сервер, о котором идет речь
         * @returns Истина, если повтор запроса имеет смысл
         */
        hostCanRetry(host : HostView) : boolean {
            return host.overview?.error !== "noObservation";
        },
        hostIsStale(host : HostView) : boolean {
            return !host.online || host.error || !host.overview || host.overview.stale || !host.overview.observedAt || this.now - host.overview.observedAt > STABILITY_STALE_MS;
        },
        hostMessage(host : HostView) : string {
            if (!host.online) {
                return this.$t("stabilityOfflineDescription");
            }
            if (host.error) {
                return this.$t("stabilityRequestError");
            }
            if (host.overview?.error === "dockerUnavailable") {
                return this.$t("stabilityDockerError");
            }
            return this.$t(host.overview?.error === "noObservation" ? "stabilityNoObservation" : "stabilityStale");
        },
        containerState(container : StabilityContainer, host : HostView) : StabilityState {
            if (this.hostIsStale(host)) {
                return "unknown";
            }
            const status = runtimeStatus(container.state, container.health);
            return status === RUNNING ? "running" : status === ATTENTION ? "attention" : [ EXITED, CREATED_STACK ].includes(status) ? "stopped" : "unknown";
        },
        healthLabel(container : StabilityContainer, host : HostView) : string {
            if (this.hostIsStale(host)) {
                return this.$t("stabilityNoFreshData");
            }
            if ([ "healthy", "unhealthy", "starting" ].includes(container.health)) {
                return this.$t(`stabilityHealth_${container.health}`);
            }
            if ([ "restarting", "paused", "dead", "removing", "created", "exited" ].includes(container.state)) {
                return this.$t(`stabilityDocker_${container.state}`);
            }
            return this.$t(container.state === "running" ? "stabilityNoHealthcheck" : "stabilityNoFreshData");
        },
        availabilityLabel(container : StabilityContainer) : string {
            const availability = container.availability;
            if (availability.verdict === "stopped") {
                return this.$t("stabilityObservedStopped");
            }
            return availability.ratio === null ? this.$t("stabilityLearning") : this.percent(availability.ratio);
        },
        duration(ms : number) : string {
            return ms < 60_000 ? this.$t("stabilityLessMinute") : formatDuration(ms, this.$t);
        },
        percent(ratio : number) : string {
            return formatPercent(ratio, this.$i18n.locale, true);
        },
        dateTime(timestamp : number) : string {
            return new Date(timestamp).toLocaleString(this.$i18n.locale, { month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit" });
        },
        historyLabel(container : StabilityContainer) : string {
            return this.$t("stabilityHistoryLabel", [ container.name, this.$t(`availabilityWindow${this.windowHours}`), this.availabilityLabel(container), this.percent(container.availability.coveredMs / container.availability.windowMs) ]);
        },
        bucketLabel(bucket : StabilityHistoryBucket) : string {
            return `${this.dateTime(bucket.from)} - ${this.dateTime(bucket.to)}: ${this.$t(`stabilityState_${bucket.state}`)}; ${this.$t("stabilityCoverage", [ this.percent(bucket.coverage) ])}`;
        },
        stackRoute(name : string, endpoint : string) {
            return endpoint ? { name: "stackInspectorEndpoint",
                params: { stackName: name,
                    endpoint } } : { name: "stackInspector",
                params: { stackName: name } };
        },
    },
});
</script>

<style scoped lang="scss">
.stability-dashboard {
    color: var(--text-strong);
}

.actions .control-label {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
}

.period {
    width: auto;
    font-size: var(--text-sm);
}

.btn {
    gap: var(--gap-sm);
}

// Счет состояний стоит над списком серверов и отделен той же тонкой линией
.counts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-xl);
    padding-bottom: var(--gap-lg);
    border-bottom: 1px solid var(--line-hair);
}

.counts > a {
    display: flex;
    align-items: baseline;
    gap: var(--gap-sm);
    padding: var(--gap-xs) var(--gap-sm);
    margin: calc(var(--gap-xs) * -1) calc(var(--gap-sm) * -1);
    border-radius: var(--radius-control);
    font-size: var(--text-sm);
    text-decoration: none;
    transition: background-color var(--motion-fast) var(--motion-ease);
}

.counts > a:hover {
    background: var(--surface-sunken);
}

.counts > a:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
}

.counts strong {
    font-size: var(--text-xl);
    line-height: var(--line-xl);
    font-weight: var(--weight-medium);
    font-variant-numeric: tabular-nums;
}

.history-details {
    color: var(--text-muted);
    font-size: var(--text-sm);
}

.history-details summary {
    cursor: pointer;
}

.history-explanation {
    max-width: 95ch;
    margin: var(--gap-sm) 0 0;
}

.history-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-md);
    margin-top: var(--gap-sm);
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.history-legend span {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-xs);
}

.history-legend i {
    width: 10px;
    height: 10px;
    border-radius: var(--radius-chip);
}

.host-warning {
    color: var(--state-attention);
}

.host-message {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-md);
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
}

// Группа стека внутри таблицы: линия сверху и имя отдельной строкой,
// без второй рамки и без повтора шапки колонок
.stack-group {
    border-top: 1px solid var(--line-hair);
}

// Строка стека - полка, а не еще один контейнер: без своей подложки имя стека
// и имя контейнера под ним читались как две строки одного списка
.group-row th {
    padding: var(--gap-sm) var(--gap-md);
    background-color: var(--surface-sunken);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    font-weight: var(--weight-medium);
}

// Имя группы и счет контейнеров - одна строка: ячейка таблицы своей раскладки не дает
.group-name {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);

    // Имя стека в таблице пишется так же, как в списке слева: подчеркивание
    // на трех строках подряд читалось как разметка, а не как ссылка
    a {
        color: var(--text-strong);
        text-decoration: none;
    }

    a:hover,
    a:focus-visible {
        color: var(--accent-text);
        text-decoration: underline;
    }
}

// Строка стека и его первый контейнер - одна группа, линия между ними лишняя
.group-row + tr {
    border-top: 0;
}

.group-count {
    color: var(--text-faint);
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
}

.container-table-wrap {
    overflow-x: auto;
    overflow-y: hidden;
    position: relative;
    animation: table-in var(--motion-base) var(--motion-ease) both;
}

// Наблюдения приходят по сети, и таблица возникает через долю секунды после
// остальной страницы. Без перехода это выглядит как рывок верстки, поэтому
// она проявляется и подтягивается на несколько пикселей вверх
@keyframes table-in {
    from {
        opacity: 0;
        transform: translateY(var(--gap-xs));
    }
}

@media (prefers-reduced-motion: reduce) {
    .container-table-wrap {
        animation: none;
    }
}

.container-table {
    width: 100%;
    font-size: var(--text-sm);
    border-collapse: collapse;
}

.container-table thead {
    color: var(--text-muted);
}

.container-table th,
.container-table td {
    padding: var(--gap-sm) var(--gap-md);
    text-align: left;
    vertical-align: middle;
}

.container-table thead th {
    font-weight: var(--weight-regular);
    font-size: var(--text-sm);
}

.container-table tr + tr {
    border-top: 1px solid var(--line-hair);
}

.container-name {
    width: 25%;
    font-weight: var(--weight-medium);
    // Перенос только по границе слова: anywhere разрешал таблице сузить колонку
    // до одной буквы, и имя контейнера рвалось посреди слова
    overflow-wrap: break-word;
}

.container-table small {
    display: block;
    margin-top: var(--gap-xs);
    color: var(--text-faint);
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
}

.uptime-cell {
    white-space: nowrap;
}

.availability-cell {
    min-width: 205px;
    width: 30%;
    font-variant-numeric: tabular-nums;
}

.availability-value {
    display: flex;
    // По первой строке, а не по середине: при длинном вердикте подпись покрытия
    // уезжала на полстроки вниз и переставала стоять в одну линию с соседними
    align-items: baseline;
    justify-content: space-between;
    gap: var(--gap-xs);
}

.availability-value small {
    margin: 0;

    // Подпись покрытия одинакова во всех строках, поэтому она не переносится:
    // иначе вид ячейки зависел бы от длины вердикта слева, и одна и та же
    // подпись стояла бы то в строку, то в две
    flex: none;
    white-space: nowrap;
}

.container-history {
    display: flex;
    width: 100%;
    height: 14px;
    gap: 2px;
    margin-top: var(--gap-sm);
}

.history-bucket {
    background: var(--surface-sunken);
    flex: 1 1 0;
    min-width: 1px;
    overflow: hidden;
    border-bottom: 1px solid var(--line-control);
}

.history-bucket i {
    display: block;
    height: 100%;
}

// Ноль не сообщает ничего, и полный цвет состояния на нем тянет взгляд туда,
// где все в порядке: оранжевое "0 Требуют внимания" читалось как предупреждение.
// Цвет остается - он же легенда полос истории ниже, - но приглушен: любая замена
// на серый оказывалась в одной из тем заметнее живого "Остановлены"
.counts > a.zero {
    opacity: 0.5;
}

// Нажатый счет - это включенный фильтр списка слева, и нажать его еще раз
// значит снять фильтр. Подложка говорит, что кнопка сейчас удерживается
.counts > a.on {
    background: var(--accent-soft);
    opacity: 1;
}

.count-running { color: var(--state-running); }
.count-attention { color: var(--state-attention); }
.count-stopped { color: var(--state-stopped); }
.count-unknown { color: var(--state-unknown); }
.history-running { background: var(--state-running); }
.history-attention { background: var(--state-attention); }
.history-stopped { background: var(--state-stopped); }
.history-unknown { background: var(--surface-sunken); border: 1px solid var(--line-control); }

@media (max-width: 650px) {
    .page-head .actions {
        width: 100%;
    }

    .counts {
        gap: var(--gap-md);
    }

    .counts > span {
        width: calc(50% - var(--gap-md));
    }

    .counts strong {
        font-size: var(--text-lg);
    }

    .container-table {
        min-width: 670px;
    }
}
</style>
