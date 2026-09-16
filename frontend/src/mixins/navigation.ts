import { defineComponent } from "vue";

/** Workspace selection is local UI state; deployment still names an explicit endpoint. */
export default defineComponent({
    data() {
        return {
            selectedEndpoint: "" as string | null,
            createStackSeed: "",
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
