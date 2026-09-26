import { strict as assert } from "node:assert";
import test from "node:test";
import en from "../../frontend/src/lang/en.json" with { type: "json" };
import ru from "../../frontend/src/lang/ru.json" with { type: "json" };
import { installGlobal, mountOptions } from "../helpers/vue-instance";
import { emulateImportMetaGlob } from "../helpers/vite-glob";

// `localStorage.locale` is read and written as a property, so a plain object stands in for it
const storage : Record<string, string> = {};
const html : Record<string, string> = {};
installGlobal("localStorage", () => storage);
installGlobal("document", () => ({ documentElement: { setAttribute(name : string, value : string) {
    html[name] = value;
} } }));

const loads = emulateImportMetaGlob(new URL("../../frontend/src/mixins/lang.ts", import.meta.url));
const { default: lang } = await import("../../frontend/src/mixins/lang");
const { i18n, setI18nLocale } = await import("../../frontend/src/i18n");

type Lang = InstanceType<typeof lang>;

// A string the Russian catalogue translates, so the language in use can be told from the text
const probe = Object.keys(ru).find((key) => {
    const text = (ru as Record<string, unknown>)[key];
    return typeof text === "string" && text !== (en as Record<string, unknown>)[key];
});
assert.ok(probe, "ru.json translates at least one string");

/**
 * A page opened with the language this browser saved
 * @param saved Saved language, if any
 * @returns The mounted mixin
 */
function openPage(saved? : string) {
    for (const key of Object.keys(storage)) {
        Reflect.deleteProperty(storage, key);
    }
    if (saved !== undefined) {
        storage.locale = saved;
    }
    for (const key of Object.keys(html)) {
        Reflect.deleteProperty(html, key);
    }
    loads.length = 0;
    setI18nLocale(i18n, "en");
    return mountOptions<Lang>({ mixins: [ lang ] });
}

/**
 * Wait until the language switch that runs in the background has finished
 * @param check True once it has
 */
async function until(check : () => boolean) : Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!check()) {
        assert.ok(Date.now() < deadline, "the language switch did not finish");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/**
 * The language the interface is in, read from the text it shows
 * @returns Locale code and the probe string
 */
function shown() {
    return { locale: (i18n.global.locale as unknown as { value : string }).value,
        text: i18n.global.t(probe!) };
}

test("English opens without loading a catalogue, and the page still names its language", () => {
    const { vm, errors, unmount } = openPage();

    assert.equal(vm.language, "en");
    assert.deepEqual(html, { lang: "en",
        dir: "ltr" });
    assert.deepEqual(loads, []);
    assert.equal(storage.locale, undefined, "opening in the default language is not a choice to save");
    assert.deepEqual(errors, []);
    unmount();
});

test("a saved language that is no longer offered opens in English", () => {
    const { vm, unmount } = openPage("de");
    assert.equal(vm.language, "en");
    assert.deepEqual(loads, []);
    unmount();
});

test("a saved Russian choice loads its catalogue when the page opens", async () => {
    const { vm, errors, unmount } = openPage("ru");
    assert.equal(vm.language, "ru");

    await until(() => html.lang === "ru");
    assert.deepEqual(loads, [ "../lang/ru.json" ]);
    assert.deepEqual(shown(), { locale: "ru",
        text: (ru as Record<string, unknown>)[probe!] });
    assert.equal(html.dir, "ltr");
    assert.deepEqual(errors, []);
    unmount();
});

test("choosing a language loads it, shows it, names it on the page and remembers it", async () => {
    const { vm, errors, unmount } = openPage();

    vm.language = "ru";
    await until(() => html.lang === "ru");
    assert.equal(storage.locale, "ru");
    assert.equal(shown().text, (ru as Record<string, unknown>)[probe!]);

    vm.language = "en";
    await until(() => html.lang === "en");
    assert.equal(storage.locale, "en");
    assert.deepEqual(shown(), { locale: "en",
        text: (en as Record<string, unknown>)[probe!] });
    assert.deepEqual(loads, [ "../lang/ru.json", "../lang/en.json" ]);
    assert.deepEqual(errors, []);
    unmount();
});

test("a code without a catalogue is refused and changes nothing", async () => {
    const { vm, unmount } = openPage();

    for (const code of [ "xx", "../en", "../../package", "" ]) {
        await assert.rejects(vm.changeLang(code), { message: `Unknown language: ${code}` });
    }
    assert.deepEqual(loads, []);
    assert.equal(shown().locale, "en");
    assert.equal(storage.locale, undefined);
    unmount();
});
