import { defineComponent } from "vue";

const narrowScreen = window.matchMedia("(max-width: 800px)");

/** Keep navigation behavior aligned with the narrow layout, including rotation. */
export default defineComponent({
    data() {
        return { isMobile: narrowScreen.matches };
    },
    mounted() {
        narrowScreen.addEventListener("change", this.onScreenSize);
    },
    beforeUnmount() {
        narrowScreen.removeEventListener("change", this.onScreenSize);
    },
    methods: {
        onScreenSize(event : MediaQueryListEvent) {
            this.isMobile = event.matches;
        },
    },
});
