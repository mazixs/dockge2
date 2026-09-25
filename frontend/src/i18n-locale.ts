export interface LocaleHolder {
    global : {
        locale : unknown;
    };
}

/**
 * Switch the active locale of the application vue-i18n instance. It runs in Composition
 * API mode (`legacy: false`), where `locale` is a ref rather than a plain string.
 * @param i18nInstance vue-i18n instance to update
 * @param lang Language code to activate
 */
export function setI18nLocale(i18nInstance : LocaleHolder, lang : string) : void {
    (i18nInstance.global.locale as { value : string }).value = lang;
}
