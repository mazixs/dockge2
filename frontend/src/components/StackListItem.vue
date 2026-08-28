<template>
    <router-link
        :to="url"
        class="item"
        :class="{ 'dim': !stack.isManagedByDockge, 'fresh': isFresh }"
    >
        <!-- Стек, агент и источник: одна строка, как в таблице -->
        <div class="who">
            <Uptime :stack="stack" :compact="true" :dot-only="true" />
            <span class="name">{{ stackName }}</span>
            <span class="agent">{{ agentLabel }}</span>
            <span class="source" :class="`source-${sourceKind}`" :title="sourceTitle">{{ sourceLabel }}</span>
            <span v-if="isFresh" class="fresh-badge">{{ $t("justNow") }}</span>
        </div>

        <!-- Сервисы: точка и имя, лишние сворачиваются в «+N», но не исчезают -->
        <div class="services">
            <span
                v-for="service in shownServices" :key="service.name"
                class="service" :class="`state-${service.state}`"
                :title="serviceTitle(service)"
            >
                <i class="dot" aria-hidden="true"></i>{{ service.name }}
            </span>
            <span v-if="hiddenServices > 0" class="more" :title="hiddenServiceNames">+{{ hiddenServices }}</span>
            <span v-if="services.length === 0" class="more">{{ $t("noServicesYet") }}</span>
        </div>

        <!-- Доступность: процент только там, где наблюдений хватает на вывод -->
        <div class="availability" :class="`verdict-${availabilityVerdict}`" :title="availabilityTitle">{{ availabilityLabel }}</div>

        <!-- Обновления: только то, что известно чтением, без догадок про реестр -->
        <div class="updates" :class="{ pending: updatesPending }" :title="updatesTitle">{{ updatesLabel }}</div>
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

            if (data.verdict === "degraded") {
                const percent = formatPercent(data.ratio, this.$i18n.locale);
                return `${percent} · ${this.$t("availabilityIncidents", data.incidents)}`;
            }

            return this.$t("availabilityNoData");
        },

        /** Почему сказано «мало данных»: сколько наблюдений на самом деле есть */
        availabilityTitle() {
            const data = this.availability;

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
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(130px, max-content) minmax(80px, max-content);
    align-items: center;
    gap: var(--gap-md);
    min-height: var(--row-height);
    padding: 0 var(--gap-md);
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

.who {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    min-width: 0;
}

.name {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.agent {
    font-size: var(--text-xs);
    color: var(--text-faint);
    white-space: nowrap;
}

// Технические значения набираются моношрифтом: их читают, а не проглядывают
.source {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-chip);
    padding: 0 5px;
    white-space: nowrap;
}

.services {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    min-width: 0;
    overflow: hidden;
}

.service {
    --chip-state: var(--state-unknown);

    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;

    .dot {
        width: 6px;
        height: 6px;
        border-radius: var(--radius-pill);
        background-color: var(--chip-state);
        flex: none;
    }

    &.state-running {
        --chip-state: var(--state-running);
    }

    &.state-attention {
        --chip-state: var(--state-attention);
    }

    &.state-stopped {
        --chip-state: var(--state-stopped);
    }

    &.state-unknown {
        --chip-state: var(--state-unknown);
    }
}

.more {
    font-size: var(--text-xs);
    color: var(--text-faint);
    white-space: nowrap;
}

// Доступность: сбой заметен, «мало данных» не притворяется зелёным
.availability {
    justify-self: end;
    font-size: var(--text-xs);
    color: var(--text-faint);
    white-space: nowrap;

    &.verdict-clean {
        color: var(--text-muted);
    }

    &.verdict-degraded {
        color: var(--state-attention);
    }
}

.updates {
    justify-self: end;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-faint);
    white-space: nowrap;

    // Отставание - повод нажать «Обновить», поэтому оно заметнее остального
    &.pending {
        color: var(--state-attention);
        border: 1px solid color-mix(in srgb, var(--state-attention) 40%, transparent);
        border-radius: var(--radius-chip);
        padding: 0 5px;
    }
}

.fresh-badge {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--state-running);
    border: 1px solid color-mix(in srgb, var(--state-running) 45%, transparent);
    border-radius: var(--radius-chip);
    padding: 0 5px;
}

// Узкий экран: строка складывается в две, доступность уходит под имя
@media (max-width: 1100px) {
    a.item {
        grid-template-columns: minmax(0, 1fr) minmax(80px, max-content);
        padding: var(--gap-sm) var(--gap-md);
    }

    .services {
        grid-column: 1 / -1;
    }

    .availability {
        justify-self: start;
        grid-column: 1;
    }
}
</style>
