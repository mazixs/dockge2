<template>
    <router-link
        :to="url"
        class="item"
        :class="{ 'dim': !stack.isManagedByDockge, 'fresh': isFresh, 'active': isCurrent }"
        :aria-current="isCurrent ? 'page' : null"
    >
        <!-- Навигатор: имя и одна мета-строка. Подробности живут в рабочей области -->
        <span class="stack-letter" :class="`stack-color-${stackColor(stackName)}`" aria-hidden="true">{{ stackName.slice(0, 1).toUpperCase() }}</span>
        <div class="stack-item-text">
            <div class="line">
                <span v-ellipsis-title class="name">{{ stackName }}</span>
                <span v-if="isFresh" class="fresh-badge">{{ $t("justNow") }}</span>
            </div>

            <div class="meta">
                <Uptime v-if="source?.dirty || source?.behind > 0" :stack="stack" :compact="true" />
                <span v-if="source?.dirty || source?.behind > 0" class="updates"><InterfaceIcon name="git" /> {{ $t("familiarHasChanges") }}</span>
                <template v-else>
                    <Uptime :stack="stack" :compact="true" />
                    <span v-if="updatesPending" class="updates" :title="updatesTitle">{{ updatesLabel }}</span>
                </template>
            </div>
        </div>
        <Uptime :stack="stack" :compact="true" :dot-only="true" aria-hidden="true" />
    </router-link>
</template>

<script>
import InterfaceIcon from "./InterfaceIcon.vue";
import { stackColor } from "../stack-color";
import Uptime from "./Uptime.vue";

/** Сколько сервисов показывается до сворачивания в "+N" */
const SHOWN_SERVICES = 3;

export default {
    components: { InterfaceIcon,
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
            // Вкладка едет за человеком: кто читает журналы, переключает стеки
            // ради журналов, и возврат на обзор каждый раз стоил бы ему двух
            // лишних действий. Обзор и отдельные экраны стека ведут на обзор
            const tab = { stackFiles: "files",
                stackLogs: "logs",
                stackTerminal: "terminal",
                stackGitChanges: "git" }[String(this.$route.name)] ?? "";

            const path = `/stack/${this.stack.name}${tab ? `/${tab}` : ""}`;
            return this.stack.endpoint ? `${path}/${this.stack.endpoint}` : path;
        },

        stackName() {
            return this.stack.name;
        },

        /** Где стек живет: свой сервер или агент по имени */
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
         * Обновления. Отставание в коммитах известно из локальных ссылок, а "новее в
         * реестре" требует проверки digest, которой еще нет - поэтому вместо догадки
         * стоит "неизвестно".
         */
        updatesLabel() {
            const behind = this.source?.behind;

            if (this.sourceKind === "git" && typeof behind === "number") {
                return behind > 0 ? this.$t("updatesGit", behind) : this.$t("updatesNone");
            }

            // Проверки образов в реестре еще нет, поэтому вместо догадки стоит прочерк,
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

        /**
         * Открытый сейчас стек. Отмечать его должна рейка, а не только адресная
         * строка: маршруты вкладок - соседи обзора, а не его дети, поэтому сам
         * router-link считает пункт активным лишь на обзоре и на файлах, журнале,
         * терминале и сравнении Git отметка пропадала
         * @returns {boolean} Это строка текущего стека
         */
        isCurrent() {
            if (this.$route.params.stackName !== this.stack.name) {
                return false;
            }

            return (this.$route.params.endpoint || "") === (this.stack.endpoint || "");
        },

        /** Только что созданный стек, на который надо показать в списке */
        isFresh() {
            return this.$root.freshStack === this.stack.name;
        }
    },
    methods: {
        stackColor,
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
.stack-letter { display: grid; place-items: center; width: var(--gap-2xl); height: var(--gap-2xl); flex-shrink: 0; border-radius: var(--radius-card); background: var(--stack-letter-background, var(--accent-soft)); color: var(--stack-letter-color, var(--accent-text)); font-size: var(--text-md); font-weight: var(--weight-medium); }
.stack-item-text { min-width: 0; flex: 1; }

// Специфичность a.item намеренная: правило перебивает наследие общего слоя
// независимо от порядка подключения файлов
a.item {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: var(--gap-sm);
    border-radius: var(--radius-panel);
    margin-bottom: var(--gap-xs);
    border: 1px solid transparent;

    text-decoration: none;
    color: var(--text-strong);

    &:hover {
        background-color: var(--surface-raised);
    }

    // Открытый стек: заливка акцентом и рамка вместо прозрачной - строка
    // выступает из рейки, и место в списке видно, не читая имен
    &.active, &[aria-current] {
        background-color: var(--accent-soft);
        border-color: var(--line-hair);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: calc(var(--focus-offset) * -1);
    }

    &.dim {
        opacity: 0.6;
    }

    // Только что созданный стек: подсветка отвечает на "где он в списке"
    &.fresh {
        background-color: color-mix(in srgb, var(--state-running) 10%, transparent);
        border-color: var(--state-running);
    }
}

.line {
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    min-width: 0;
}

.item:focus-visible .name { white-space: normal; overflow-wrap: anywhere; }

.name {
    font-weight: var(--weight-medium);
    font-size: var(--text-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

// Мета-строка: состояние словом и несохраненные изменения - этого хватает,
// чтобы выбрать стек, не открывая его
.meta {
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    margin-left: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
    flex-wrap: wrap;
}

// Отставание в Git - повод открыть стек, поэтому оно видно и в навигаторе
.updates {
    margin-left: 0;
    font-family: var(--font-ui);
    color: var(--state-attention);
}

.fresh-badge {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--state-running);
    border: 1px solid color-mix(in srgb, var(--state-running) 45%, transparent);
    border-radius: var(--radius-chip);
    padding: 0 var(--gap-xs);
}
</style>
