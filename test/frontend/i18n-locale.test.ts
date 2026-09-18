import { strict as assert } from "node:assert";
import test from "node:test";
import { createI18n } from "vue-i18n";
import { setI18nLocale } from "../../frontend/src/i18n-locale";

const messages = {
    en: { hello: "Hello" },
    ru: { hello: "Привет" },
};

test("locale switching works in Legacy API mode", () => {
    const i18n = createI18n({
        locale: "en",
        fallbackLocale: "en",
        messages,
    });

    // The app still runs in Legacy API mode, where locale is a plain string
    assert.equal(typeof i18n.global.locale, "string");

    setI18nLocale(i18n, "ru");

    assert.equal(i18n.global.locale, "ru");
    assert.equal(i18n.global.t("hello"), "Привет");
});

test("locale switching works in Composition API mode", () => {
    const i18n = createI18n({
        legacy: false,
        locale: "en",
        fallbackLocale: "en",
        messages,
    });

    assert.equal(typeof i18n.global.locale, "object");

    setI18nLocale(i18n, "ru");

    assert.equal(i18n.global.locale.value, "ru");
    assert.equal(i18n.global.t("hello"), "Привет");
});

test("the application i18n instance runs in Composition API mode", async () => {
    // The app instance is built with legacy: false, because the Legacy API is removed in v12
    const { i18n, availableLanguages } = await import("../../frontend/src/i18n");

    assert.equal((i18n as unknown as { mode : string }).mode, "composition");

    // Locale is a ref in this mode, and the shared helper still switches it
    assert.equal(typeof i18n.global.locale, "object");
    setI18nLocale(i18n, "ru");
    assert.equal((i18n.global.locale as unknown as { value : string }).value, "ru");

    // The language list does not depend on the i18n internals
    // Only complete catalogues are offered, so the count follows the translations
    const languages = availableLanguages();
    assert.ok(languages.length >= 2);
    assert.ok(languages.every((language) => typeof language.code === "string" && language.name.length > 0));
    assert.ok(languages.some((language) => language.code === "en"));
});
