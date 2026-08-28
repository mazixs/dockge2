<template>
    <router-link :to="url" :class="{ 'dim' : !stack.isManagedByDockge, 'fresh': isFresh }" class="item">
        <Uptime :stack="stack" :fixed-width="true" />
        <div class="title">
            <span>{{ stackName }}</span>
        </div>
        <span v-if="isFresh" class="fresh-badge">{{ $t("justNow") }}</span>
    </router-link>
</template>

<script>
import Uptime from "./Uptime.vue";

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
        /** How many ancestors are above this stack */
        depth: {
            type: Number,
            default: 0,
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
    data() {
        return {
            isCollapsed: true,
        };
    },
    computed: {
        endpointDisplay() {
            return this.$root.endpointDisplayFunction(this.stack.endpoint);
        },
        url() {
            if (this.stack.endpoint) {
                return `/stack/${this.stack.name}/${this.stack.endpoint}`;
            } else {
                return `/stack/${this.stack.name}`;
            }
        },
        depthMargin() {
            return {
                marginLeft: `${31 * this.depth}px`,
            };
        },
        stackName() {
            return this.stack.name;
        },

        /** Только что созданный стек, на который надо показать в списке */
        isFresh() {
            return this.$root.freshStack === this.stack.name;
        }
    },
    watch: {
        isSelectMode() {
            // TODO: Resize the heartbeat bar, but too slow
            // this.$refs.heartbeatBar.resize();
        }
    },
    beforeMount() {

    },
    methods: {
        /**
         * Changes the collapsed value of the current stack and saves
         * it to local storage
         * @returns {void}
         */
        changeCollapsed() {
            this.isCollapsed = !this.isCollapsed;

            // Save collapsed value into local storage
            let storage = window.localStorage.getItem("stackCollapsed");
            let storageObject = {};
            if (storage !== null) {
                storageObject = JSON.parse(storage);
            }
            storageObject[`stack_${this.stack.id}`] = this.isCollapsed;

            window.localStorage.setItem("stackCollapsed", JSON.stringify(storageObject));
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
@use "../styles/vars.scss" as *;

.small-padding {
    padding-left: 5px !important;
    padding-right: 5px !important;
}

.collapse-padding {
    padding-left: 8px !important;
    padding-right: 2px !important;
}

// Специфичность через тег: правило `.stack-list .item` живёт ещё и в main.scss,
// а порядок подключения стилей не гарантирован.
a.item {
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    min-height: var(--row-height);
    border-radius: var(--radius-control);
    transition: background-color ease-in-out 0.15s;
    width: 100%;
    padding: var(--gap-xs) var(--gap-sm);
    color: var(--text-strong);
    // Полоса слева есть у всех строк, но прозрачная: иначе выбор сдвигает текст.
    box-shadow: inset 3px 0 0 transparent;

    &.disabled {
        opacity: 0.3;
    }

    &:hover {
        background-color: var(--surface-raised);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }

    // Выбранная строка: полоса слева плюс фон, чтобы выбор был виден и без цвета.
    &.active,
    &[aria-current] {
        background-color: var(--accent-soft);
        box-shadow: inset 3px 0 0 var(--accent);
    }

    .title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .endpoint {
        font-size: var(--text-xs);
        color: var(--text-muted);
    }

    // Только что созданный стек: зелёная полоса отвечает на «где он в списке».
    &.fresh {
        box-shadow: inset 3px 0 0 var(--state-running);
        background-color: color-mix(in srgb, var(--state-running) 10%, transparent);
    }
}

.fresh-badge {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--state-running);
    border: 1px solid color-mix(in srgb, var(--state-running) 45%, transparent);
    border-radius: var(--radius-chip);
    padding: 1px 6px;
}

.collapsed {
    transform: rotate(-90deg);
}

.animated {
    transition: all 0.2s $easing-in;
}

.select-input-wrapper {
    float: left;
    margin-top: 15px;
    margin-left: 3px;
    margin-right: 10px;
    padding-left: 4px;
    position: relative;
    z-index: 15;
}

.dim {
    opacity: 0.5;
}

</style>
