<template>
    <div
        v-if="visible"
        ref="menu"
        class="terminal-context-menu"
        :style="menuStyle"
        role="menu"
        @contextmenu.prevent
    >
        <button ref="pasteButton" type="button" class="menu-item" role="menuitem" @click="emitPaste">
            <font-awesome-icon icon="paste" />
            {{ $t("paste") }}
        </button>
        <div v-if="message" class="menu-message" role="status" aria-live="polite">{{ message }}</div>
    </div>
</template>

<script>
export default {
    props: {
        visible: {
            type: Boolean,
            default: false,
        },
        position: {
            type: Object,
            default: () => ({ x: 0,
                y: 0 }),
        },
        /** Shown inside the menu when the clipboard could not be read */
        message: {
            type: String,
            default: "",
        },
    },
    emits: [ "paste", "close" ],
    computed: {
        /**
         * Keep the menu inside the window, so a right click near an edge stays usable
         * @returns {object} Inline style
         */
        menuStyle() {
            const width = 180;
            const height = 90;
            const maxX = Math.max(0, window.innerWidth - width);
            const maxY = Math.max(0, window.innerHeight - height);

            return {
                top: `${Math.min(this.position.y, maxY)}px`,
                left: `${Math.min(this.position.x, maxX)}px`,
            };
        },
    },
    watch: {
        visible(value) {
            if (value) {
                document.addEventListener("click", this.onDocumentClick, true);
                document.addEventListener("keydown", this.onKeydown, true);

                // Focus the action, otherwise the menu cannot be used from the keyboard
                this.$nextTick(() => {
                    this.$refs.pasteButton?.focus();
                });
            } else {
                this.removeListeners();
            }
        },
    },
    unmounted() {
        this.removeListeners();
    },
    methods: {
        emitPaste() {
            this.$emit("paste");
        },

        removeListeners() {
            document.removeEventListener("click", this.onDocumentClick, true);
            document.removeEventListener("keydown", this.onKeydown, true);
        },

        /**
         * Close the menu when the click happened outside of it
         * @param {MouseEvent} event Click event
         * @returns {void}
         */
        onDocumentClick(event) {
            if (this.$refs.menu && !this.$refs.menu.contains(event.target)) {
                this.$emit("close");
            }
        },

        /**
         * Close the menu on Escape
         * @param {KeyboardEvent} event Key event
         * @returns {void}
         */
        onKeydown(event) {
            if (event.key === "Escape") {
                // Without this the escape also reaches the PTY and confuses the shell
                event.preventDefault();
                event.stopPropagation();
                this.$emit("close");
            }
        },
    },
};
</script>

<style scoped lang="scss">
@use "../styles/vars.scss" as *;

.terminal-context-menu {
    position: fixed;
    z-index: var(--layer-toast);
    min-width: 160px;
    padding: var(--gap-xs);
    background-color: var(--surface-panel);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);
    box-shadow: var(--shadow-panel);
}

.menu-item {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    width: 100%;
    padding: var(--gap-xs) var(--gap-sm);
    background: none;
    border: none;
    border-radius: var(--radius-control);
    color: var(--text-strong);
    text-align: left;

    &:hover,
    &:focus {
        background-color: var(--surface-raised);
    }
}

.menu-message {
    padding: var(--gap-xs) var(--gap-sm);
    font-size: var(--text-sm);
    opacity: 0.8;
}
</style>
