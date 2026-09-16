import { defineComponent } from "vue";
import { normaliseTheme, readThemePreference, resolveTheme } from "../theme-preference";

const media = window.matchMedia("(prefers-color-scheme: dark)");

export default defineComponent({
    data() {
        return {
            system: media.matches ? "dark" : "light",
            userTheme: readThemePreference(() => window.localStorage),
        };
    },
    computed: {
        theme() {
            return resolveTheme(this.userTheme, this.system === "dark");
        },
        isDark() {
            return this.theme === "dark";
        },
    },
    watch: {
        userTheme(value) {
            try {
                localStorage.setItem("theme", normaliseTheme(value));
            } catch {
                // An in-memory choice remains useful when browser storage is blocked.
            }
        },
        theme() {
            this.applyTheme();
        },
    },
    beforeMount() {
        this.applyTheme();
    },
    mounted() {
        media.addEventListener("change", this.onSystemTheme);
        window.addEventListener("storage", this.onThemeStorage);
    },
    beforeUnmount() {
        media.removeEventListener("change", this.onSystemTheme);
        window.removeEventListener("storage", this.onThemeStorage);
    },
    methods: {
        /** Follow operating system changes through the resolved preference. */
        onSystemTheme(event : MediaQueryListEvent) {
            this.system = event.matches ? "dark" : "light";
        },
        /** Keep multiple tabs on the same explicit device preference. */
        onThemeStorage(event : StorageEvent) {
            if (event.key === "theme" || event.key === null) {
                this.userTheme = readThemePreference(() => window.localStorage);
            }
        },
        /** Apply the same palette to application and native controls. */
        applyTheme() {
            document.body.classList.toggle("dark", this.theme === "dark");
            document.body.classList.toggle("light", this.theme === "light");
            document.documentElement.style.colorScheme = this.theme;
            document.documentElement.dataset.bsTheme = this.theme;
            this.updateThemeColorMeta();
        },
        updateThemeColorMeta() {
            const color = getComputedStyle(document.body).getPropertyValue("--surface-base").trim();
            document.querySelector("#theme-color")?.setAttribute("content", color);
        },
    },
});
