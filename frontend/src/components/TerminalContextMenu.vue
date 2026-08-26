<template>
    <div
        v-if="visible"
        ref="menu"
        class="terminal-context-menu shadow-box"
        :style="menuStyle"
        role="menu"
        @contextmenu.prevent
    >
        <button ref="pasteButton" type="button" class="menu-item" role="menuitem" @click="emitPaste">
            <font-awesome-icon icon="paste" class="me-2" />
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
@import "../styles/vars";

.terminal-context-menu {
    position: fixed;
    z-index: 1080;
    min-width: 160px;
    padding: 4px;
    background-color: $dark-bg2;
    border-radius: 8px;
}

.menu-item {
    display: block;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    border-radius: 6px;
    color: $dark-font-color;
    text-align: left;

    &:hover,
    &:focus {
        background-color: rgba(127, 127, 127, 0.25);
    }
}

.menu-message {
    padding: 4px 10px 6px;
    font-size: 0.8rem;
    opacity: 0.8;
}
</style>
