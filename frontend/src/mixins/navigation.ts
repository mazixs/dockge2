import { defineComponent } from "vue";

/** Workspace selection is local UI state; deployment still names an explicit endpoint. */
export default defineComponent({
    data() {
        return {
            selectedEndpoint: "" as string | null,
            createStackSeed: "",
            /**
             * Opens the create sheet, while a layout that owns one is on screen.
             *
             * Any screen may offer the action, and only the layout knows the sheet, so
             * the layout puts the handler here for as long as it exists. It was set on
             * the root instance from outside before, which left it out of the state and
             * therefore out of the reactivity a button in a template depends on.
             */
            openCreateStack: null as (() => void) | null,
        };
    },
    watch: {
        "$route.path": {
            immediate: true,
            handler() {
                if (/^\/(stack|compose|terminal)\//.test(this.$route.path) && this.selectedEndpoint !== null) {
                    this.selectedEndpoint = typeof this.$route.params.endpoint === "string" ? this.$route.params.endpoint : "";
                }
            },
        },
    },
});
