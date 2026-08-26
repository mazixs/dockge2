export interface LocaleHolder {
    global : {
        locale : unknown;
    };
}

/**
 * Switch the active locale of a vue-i18n instance.
 * In Legacy API mode `locale` is a plain string, in Composition API mode it is a ref,
 * so writing `.value` unconditionally throws a TypeError on a string in strict mode.
 * @param i18nInstance vue-i18n instance to update
 * @param lang Language code to activate
 */
export function setI18nLocale(i18nInstance : LocaleHolder, lang : string) : void {
    const global = i18nInstance.global as { locale : unknown };

    if (typeof global.locale === "string") {
        global.locale = lang;
    } else {
        (global.locale as { value : string }).value = lang;
    }
}
