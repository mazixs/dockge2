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

/**
 * Runs a check with `localStorage` and `navigator` replaced, restoring the originals after
 * @param storage Value to expose as `localStorage`
 * @param language Browser language to expose as `navigator.language`
 * @param check Assertions to run
 */
async function withBrowser(storage : unknown, language : string, check : () => Promise<void>) : Promise<void> {
    const originals = {
        localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
        navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
    };

    Object.defineProperty(globalThis, "localStorage", { value: storage,
        configurable: true,
        writable: true });
    Object.defineProperty(globalThis, "navigator", { value: { language },
        configurable: true,
        writable: true });

    try {
        await check();
    } finally {
        for (const [ name, descriptor ] of Object.entries(originals)) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                delete (globalThis as Record<string, unknown>)[name];
            }
        }
    }
}

test("English is the default language, whatever the browser language", async () => {
    const { currentLocale } = await import("../../frontend/src/i18n");

    // First run and cleared storage open in English even in a Russian browser
    await withBrowser({}, "ru-RU", async () => {
        assert.equal(currentLocale(), "en");
    });

    // An explicit choice is kept
    await withBrowser({ locale: "ru" }, "en-US", async () => {
        assert.equal(currentLocale(), "ru");
    });

    // A stored code the switcher no longer offers falls back to English, not to a blank selector
    await withBrowser({ locale: "de" }, "de-DE", async () => {
        assert.equal(currentLocale(), "en");
    });

    // Storage that throws (private mode, blocked site data) is not fatal
    const blocked = new Proxy({}, { get() {
        throw new Error("SecurityError");
    } });
    await withBrowser(blocked, "ru-RU", async () => {
        assert.equal(currentLocale(), "en");
    });
});

test("English leads the language list and Russian follows, whatever the browser locale", async () => {
    const { availableLanguages } = await import("../../frontend/src/i18n");
    const originalCompare = String.prototype.localeCompare;

    // A browser in Russian collates Cyrillic before Latin when no locale is given
    String.prototype.localeCompare = function (that : string, locales? : Intl.LocalesArgument, options? : Intl.CollatorOptions) {
        return originalCompare.call(this, that, locales ?? "ru", options);
    };

    try {
        const codes = availableLanguages().map((language) => language.code);
        assert.deepEqual(codes.slice(0, 2), [ "en", "ru" ]);
    } finally {
        String.prototype.localeCompare = originalCompare;
    }
});
