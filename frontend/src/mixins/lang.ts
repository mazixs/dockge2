import { currentLocale, i18n } from "../i18n";
import { setI18nLocale } from "../i18n-locale";
import { setPageLocale } from "../util-frontend";
import { defineComponent } from "vue";
const langModules = import.meta.glob<Record<string, string>>("../lang/*.json");

export default defineComponent({
    data() {
        return {
            language: currentLocale(),
        };
    },

    watch: {
        async language(lang) {
            await this.changeLang(lang);
        },
    },

    async created() {
        if (this.language !== "en") {
            await this.changeLang(this.language);
        }
    },

    methods: {
        /**
         * Change the application language
         * @param {string} lang Language code to switch to
         * @returns {Promise<void>}
         */
        async changeLang(lang : string) {
            const loadMessage = langModules["../lang/" + lang + ".json"];
            if (!loadMessage) {
                throw new Error("Unknown language: " + lang);
            }
            const message = (await loadMessage()).default ?? {};
            i18n.global.setLocaleMessage(lang, message);
            setI18nLocale(i18n, lang);
            localStorage.locale = lang;
            setPageLocale();
        }
    }
});
