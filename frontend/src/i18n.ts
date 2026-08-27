import { createI18n } from "vue-i18n";
import { setI18nLocale } from "./i18n-locale";
import en from "./lang/en.json";

const languageList: Record<string, string> = {
    "bg-BG": "Български",
    "es": "Español",
    "de": "Deutsch",
    "fr": "Français",
    "pl-PL": "Polski",
    "pt": "Português",
    "pt-BR": "Português-Brasil",
    "sl": "Slovenščina",
    "tr": "Türkçe",
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文(台灣)",
    "ur": "Urdu",
    "ko-KR": "한국어",
    "ru": "Русский",
    "cs-CZ": "Čeština",
    "ar": "العربية",
    "th": "ไทย",
    "it-IT": "Italiano",
    "sv-SE": "Svenska",
    "uk-UA": "Українська",
    "da": "Dansk",
    "ja": "日本語",
    "nl": "Nederlands",
    "ro": "Română",
    "id": "Bahasa Indonesia (Indonesian)",
    "vi": "Tiếng Việt",
    "hu": "Magyar",
    "ca": "Català",
    "ga": "Gaeilge",
    "de-CH": "Schwiizerdütsch",
    "mag": "मगही",
    "mai": "मैथिली",
};

const messages: Record<string, Record<string, string>> = {
    en: en as Record<string, string>,
};

for (let lang in languageList) {
    const languageName = languageList[lang];
    if (!languageName) {
        continue;
    }
    messages[lang] = {
        languageName,
    };
}

const rtlLangs = [ "fa", "ar-SY", "ur", "ar" ];

/**
 * Locale to start with: the stored choice, then the browser language, then English.
 * Storage and navigator are read defensively, because this module is also loaded
 * outside a browser (tests, tooling) where neither exists.
 * @returns Locale code
 */
export const currentLocale = () => {
    let stored : string | undefined;

    try {
        stored = localStorage.locale;
    } catch (e) {
        stored = undefined;
    }

    if (stored) {
        return stored;
    }

    const browserLanguage = typeof navigator === "undefined" ? "" : navigator.language ?? "";

    if (languageList[browserLanguage]) {
        return browserLanguage;
    }

    const shortLanguage = browserLanguage.substring(0, 2);

    if (languageList[shortLanguage]) {
        return shortLanguage;
    }

    return "en";
};

export const localeDirection = () => {
    return rtlLangs.includes(currentLocale()) ? "rtl" : "ltr";
};

export const i18n = createI18n({
    // Composition API mode: the Legacy API is deprecated in vue-i18n 11 and removed in 12.
    // globalInjection keeps `$t` available in templates and in options-API methods.
    legacy: false,
    globalInjection: true,
    locale: currentLocale(),
    fallbackLocale: "en",
    missingWarn: false,
    fallbackWarn: false,
    messages: messages,
});

/**
 * Languages the UI can switch to, as code and display name.
 * Read from the local list instead of the i18n instance, so components do not depend
 * on whether `messages` is a plain object or a ref.
 * @returns Language code and display name pairs
 */
export function availableLanguages() : Array<{ code : string, name : string }> {
    return Object.keys(messages)
        .map((code) => ({
            code,
            name: (messages[code]?.languageName as string | undefined) ?? code,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export { setI18nLocale };
