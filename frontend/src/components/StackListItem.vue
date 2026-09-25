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
                <span v-if="isFresh" class="fresh-badge" :title="$t('justNow')" :aria-label="$t('justNow')" role="img"><InterfaceIcon name="check" /></span>
            </div>

            <div class="meta">
                <Uptime :stack="stack" :compact="true" />
                <span v-for="(fact, index) in sourceFacts" :key="fact" class="updates" :title="sourceFactsTitle">
                    <InterfaceIcon v-if="index === 0" name="git" /> {{ fact }}
                </span>
            </div>
        </div>
        <Uptime :stack="stack" :compact="true" :dot-only="true" aria-hidden="true" />
    </router-link>
</template>

<script>
import InterfaceIcon from "./InterfaceIcon.vue";
import { stackColor } from "../stack-color";
import Uptime from "./Uptime.vue";
import { formatDuration } from "../format";
import { stackSourceState } from "../../../common/stack-source";

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

        /** Состояние источника словами общего слоя: рейка и панель говорят одинаково */
        sourceState() {
            return stackSourceState(this.source);
        },

        /**
         * Чем файлы стека отличаются от Git, по факту на пометку.
         *
         * Пометок может быть две, и они идут отдельными элементами, а не одной
         * строкой через разделитель: в узкой рейке строка переносится, и точка
         * повисает в конце первой половины. Стек, у которого расхождений нет,
         * молчит - рейка отвечает, что требует внимания, а давность проверки
         * и совпадение с Git объясняет панель источника на самой странице
         * @returns {string[]} Пометки в порядке чтения, пустой список если сверять нечего
         */
        sourceFacts() {
            const behind = this.source?.behind ?? 0;

            switch (this.sourceState) {
                case "edited":
                    return [ this.$t("sourceEditedShort") ];
                case "behind":
                    return [ this.$t("sourceBehindShort", [ behind ]) ];
                case "editedBehind":
                    return [ this.$t("sourceEditedShort"), this.$t("sourceBehindShort", [ behind ]) ];
                default:
                    return [];
            }
        },

        /** Подсказка пометок: адрес, ветвь и когда последний раз спрашивали origin */
        sourceFactsTitle() {
            if (this.source?.kind !== "git") {
                return "";
            }

            const parts = [ this.source.remote, this.source.branch ].filter((part) => !!part);

            parts.push(this.source.checkedAt
                ? this.$t("familiarGitCheckedAgo", [ formatDuration(Date.now() - this.source.checkedAt, this.$t) ])
                : this.$t("familiarGitNeverChecked"));

            return parts.join(" · ");
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

    // A project Dockge does not manage: quieter by colour, not by transparency,
    // which took its name below a readable contrast
    &.dim {
        color: var(--text-muted);

        // Outlined: in the dark theme the sunken surface is the sidebar itself
        .stack-letter {
            background: var(--surface-sunken);
            box-shadow: inset 0 0 0 1px var(--line-hair);
            color: var(--text-muted);
        }
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
    font-size: var(--text-sm);
    color: var(--text-faint);
    flex-wrap: wrap;
}

// Отставание в Git - повод открыть стек, поэтому оно видно и в навигаторе
.updates {
    margin-left: 0;
    font-family: var(--font-ui);
    color: var(--state-attention);
}

// Только что созданный стек уже подсвечен строкой. Слово здесь ничего не
// добавляло бы и устаревало бы молча, поэтому остается один знак
.fresh-badge {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    color: var(--state-running);
    font-size: var(--icon-sm);
}
</style>
