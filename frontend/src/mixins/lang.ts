import { currentLocale, i18n, type Catalogue } from "../i18n";
import { setI18nLocale } from "../i18n-locale";
import { setPageLocale } from "../util-frontend";
import { defineComponent } from "vue";
const langModules = import.meta.glob<{ default? : Catalogue }>("../lang/*.json");

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
        // Английский уже загружен статически, догружать его нечем. Но язык и
        // направление страницы ставятся в любом случае: без них <html> уходит
        // к пользователю без атрибута lang, а это читает и экранный диктор,
        // и поиск, и CSS
        if (this.language === "en") {
            setPageLocale();
            return;
        }

        await this.changeLang(this.language);
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
