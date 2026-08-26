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
