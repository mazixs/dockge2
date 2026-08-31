<template>
    <router-link
        :to="url"
        class="item"
        :class="{ 'dim': !stack.isManagedByDockge, 'fresh': isFresh }"
    >
        <!-- Навигатор: имя и одна мета-строка. Подробности живут в рабочей области -->
        <div class="line">
            <Uptime :stack="stack" :compact="true" :dot-only="true" />
            <span class="name">{{ stackName }}</span>
            <span v-if="isFresh" class="fresh-badge">{{ $t("justNow") }}</span>
        </div>

        <div class="meta">
            <span v-if="agentLabel !== $t('thisServer')" class="agent">{{ agentLabel }}</span>
            <span class="services-count">{{ $t("serviceCount", services.length) }}</span>
            <span class="dot-sep" aria-hidden="true">·</span>
            <span class="availability" :class="`verdict-${availabilityVerdict}`" :title="availabilityTitle">{{ availabilityLabel }}</span>
            <span v-if="updatesPending" class="updates" :title="updatesTitle">{{ updatesLabel }}</span>
        </div>
    </router-link>
</template>

<script>
import Uptime from "./Uptime.vue";
import { formatDuration, formatPercent } from "../format";

/** Сколько сервисов показывается до сворачивания в «+N» */
const SHOWN_SERVICES = 3;

export default {
    components: {
        Uptime
    },
    props: {
        /** Stack this represents */
        stack: {
            type: Object,
            default: null,
        },
        /** If the user is in select mode */
        isSelectMode: {
            type: Boolean,
            default: false,
        },
        /** Callback to determine if stack is selected */
        isSelected: {
            type: Function,
            default: () => {}
        },
        /** Callback fired when stack is selected */
        select: {
            type: Function,
            default: () => {}
        },
        /** Callback fired when stack is deselected */
        deselect: {
            type: Function,
            default: () => {}
        },
    },
    computed: {
        url() {
            if (this.stack.endpoint) {
                return `/stack/${this.stack.name}/${this.stack.endpoint}`;
            } else {
                return `/stack/${this.stack.name}`;
            }
        },

        stackName() {
            return this.stack.name;
        },

        /** Где стек живёт: свой сервер или агент по имени */
        agentLabel() {
            if (!this.stack.endpoint) {
                return this.$t("thisServer");
            }
            return this.$root.endpointDisplayFunction(this.stack.endpoint) || this.stack.endpoint;
        },

        services() {
            return Array.isArray(this.stack.services) ? this.stack.services : [];
        },

        shownServices() {
            return this.services.slice(0, SHOWN_SERVICES);
        },

        hiddenServices() {
            return Math.max(this.services.length - SHOWN_SERVICES, 0);
        },

        /** Скрытые сервисы названы в подсказке: молча обрезать список нельзя */
        hiddenServiceNames() {
            return this.services.slice(SHOWN_SERVICES).map((service) => service.name).join(", ");
        },

        source() {
            return this.stack.source ?? null;
        },

        sourceKind() {
            return this.source?.kind === "git" ? "git" : "local";
        },

        /** Источник словами: Git с отставанием, Git синхронно или локальный каталог */
        sourceLabel() {
            if (this.sourceKind !== "git") {
                return this.$t("sourceLocal");
            }

            const behind = this.source?.behind;

            if (behind === null || behind === undefined) {
                return this.$t("sourceGit");
            }

            if (behind === 0) {
                return this.$t("sourceGitInSync");
            }

            return this.$t("sourceGitBehind", [ behind ]);
        },

        /** Подробности источника в подсказке: адрес, ветвь и незакоммиченные правки */
        sourceTitle() {
            if (this.sourceKind !== "git") {
                return "";
            }

            const parts = [ this.source?.remote, this.source?.branch ].filter((part) => !!part);

            if (this.source?.dirty) {
                parts.push(this.$t("sourceDirty"));
            }

            return parts.join(" · ");
        },

        /**
         * Обновления. Отставание в коммитах известно из локальных ссылок, а «новее в
         * реестре» требует проверки digest, которой ещё нет - поэтому вместо догадки
         * стоит «неизвестно».
         */
        updatesLabel() {
            const behind = this.source?.behind;

            if (this.sourceKind === "git" && typeof behind === "number") {
                return behind > 0 ? this.$t("updatesGit", behind) : this.$t("updatesNone");
            }

            // Проверки образов в реестре ещё нет, поэтому вместо догадки стоит прочерк,
            // а объяснение - в подсказке
            return "—";
        },

        /** Почему в колонке обновлений прочерк */
        updatesTitle() {
            if (this.sourceKind === "git" && typeof this.source?.behind === "number") {
                return "";
            }
            return this.$t("updatesNotCheckedYet");
        },

        updatesPending() {
            return this.sourceKind === "git" && (this.source?.behind ?? 0) > 0;
        },

        availability() {
            return this.stack.availability ?? null;
        },

        availabilityVerdict() {
            return this.availability?.verdict ?? "noData";
        },

        /**
         * Доступность словами. Правила простые и обязательные: без наблюдений нет
         * процента, полное окно без сбоев - это «без сбоев», а не «100%», а
         * остановленный стек показывает срок, а не долю.
         */
        availabilityLabel() {
            const data = this.availability;

            if (!data) {
                return this.$t("availabilityNoData");
            }

            if (data.verdict === "stopped") {
                return this.$t("availabilityStopped", [ formatDuration(data.currentForMs, this.$t) ]);
            }

            if (data.verdict === "clean") {
                return this.$t("availabilityClean");
            }

            if (data.verdict === "degraded" && data.incidents === 0) {
                // Доля упала не из-за сбоя, а из-за остановки: «0 сбоев» было бы враньём
                return formatPercent(data.ratio, this.$i18n.locale, true);
            }

            if (data.verdict === "degraded") {
                const percent = formatPercent(data.ratio, this.$i18n.locale, true);
                return `${percent} · ${this.$t("availabilityIncidents", data.incidents)}`;
            }

            return this.$t("availabilityNoData");
        },

        /** Почему сказано «мало данных» или почему доля меньше единицы без сбоев */
        availabilityTitle() {
            const data = this.availability;

            if (data?.verdict === "degraded" && data.incidents === 0) {
                return this.$t("availabilityPartlyStopped");
            }

            if (!data || data.verdict !== "noData") {
                return "";
            }

            if (!data.coveredMs) {
                return this.$t("availabilityNothingObserved");
            }

            return this.$t("availabilityObservedFor", [ formatDuration(data.coveredMs, this.$t) ]);
        },

        /** Только что созданный стек, на который надо показать в списке */
        isFresh() {
            return this.$root.freshStack === this.stack.name;
        }
    },
    methods: {
        /**
         * Состояние сервиса словами для подсказки чипа
         * @param {object} service Сервис из сводки
         * @returns {string} Состояние и пометка разового сервиса
         */
        serviceTitle(service) {
            const state = this.$t(`serviceState_${service.state}`);
            return service.isOneShot ? `${state} · ${this.$t("oneShotService")}` : state;
        },

        /**
         * Toggle selection of stack
         * @returns {void}
         */
        toggleSelection() {
            if (this.isSelected(this.stack.id)) {
                this.deselect(this.stack.id);
            } else {
                this.select(this.stack.id);
            }
        },
    },
};
</script>

<style lang="scss" scoped>
// Специфичность a.item намеренная: правило перебивает наследие общего слоя
// независимо от порядка подключения файлов
a.item {
    display: block;
    padding: var(--gap-sm) var(--gap-md);
    border-bottom: 1px solid var(--line-hair);
    border-left: 2px solid transparent;
    text-decoration: none;
    color: var(--text-strong);

    &:hover {
        background-color: var(--surface-raised);
    }

    // Выбранный стек виден не только цветом: слева акцентная полоса
    &.active, &[aria-current] {
        background-color: var(--accent-soft);
        border-left-color: var(--accent);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: calc(var(--focus-offset) * -1);
    }

    &.dim {
        opacity: 0.6;
    }

    // Только что созданный стек: подсветка отвечает на «где он в списке»
    &.fresh {
        background-color: color-mix(in srgb, var(--state-running) 10%, transparent);
        border-left-color: var(--state-running);
    }
}

.line {
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    min-width: 0;
}

.name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

// Мета-строка: сколько сервисов и что с доступностью - этого хватает,
// чтобы выбрать стек, не открывая его
.meta {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-left: 14px;
    font-size: var(--text-xs);
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
}

.agent {
    font-family: var(--font-mono);
}

.dot-sep {
    color: var(--line-control);
}

.availability {
    overflow: hidden;
    text-overflow: ellipsis;

    &.verdict-degraded {
        color: var(--state-attention);
    }
}

// Отставание в Git - повод открыть стек, поэтому оно видно и в навигаторе
.updates {
    margin-left: auto;
    font-family: var(--font-mono);
    color: var(--state-attention);
}

.fresh-badge {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--state-running);
    border: 1px solid color-mix(in srgb, var(--state-running) 45%, transparent);
    border-radius: var(--radius-chip);
    padding: 0 5px;
}
</style>
