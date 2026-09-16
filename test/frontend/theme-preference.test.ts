import { strict as assert } from "node:assert";
import test from "node:test";
import { normaliseTheme, readThemePreference, resolveTheme } from "../../frontend/src/theme-preference";

test("new devices and invalid saved settings follow the operating system", () => {
    for (const value of [ null, undefined, "", "system", "obsolete" ]) {
        assert.equal(normaliseTheme(value), "auto");
        assert.equal(resolveTheme(value, true), "dark");
        assert.equal(resolveTheme(value, false), "light");
    }
});

test("an explicit selection survives a system theme change", () => {
    for (const systemDark of [ false, true ]) {
        assert.equal(resolveTheme("light", systemDark), "light");
        assert.equal(resolveTheme("dark", systemDark), "dark");
    }
    assert.equal(resolveTheme("auto", true), "dark");
    assert.equal(resolveTheme("auto", false), "light");
});

test("restricted storage still allows the interface to open", () => {
    assert.equal(readThemePreference(() => {
        throw new Error("storage unavailable");
    }), "auto");
    assert.equal(readThemePreference({ getItem: () => {
        throw new Error("denied");
    } }), "auto");
    assert.equal(readThemePreference({ getItem: () => "dark" }), "dark");
});
