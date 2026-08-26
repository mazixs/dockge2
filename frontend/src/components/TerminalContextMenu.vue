<template>
    <div
        v-if="visible"
        ref="menu"
        class="terminal-context-menu shadow-box"
        :style="{ top: `${position.y}px`, left: `${position.x}px` }"
        role="menu"
        @contextmenu.prevent
    >
        <button class="menu-item" role="menuitem" @click="emitPaste">
            <font-awesome-icon icon="copy" class="me-2" />
            {{ $t("paste") }}
        </button>
        <div v-if="message" class="menu-message">{{ message }}</div>
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
    watch: {
        visible(value) {
            if (value) {
                document.addEventListener("click", this.onDocumentClick, true);
                document.addEventListener("keydown", this.onKeydown, true);
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
