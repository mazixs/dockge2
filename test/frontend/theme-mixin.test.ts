import { strict as assert } from "node:assert";
import { getEventListeners } from "node:events";
import test from "node:test";
import { nextTick } from "vue";
import { FakeMediaQuery, MemoryStorage, installGlobal, mountOptions } from "../helpers/vue-instance";

/** The page as the theme sees it: body classes, the root element and the theme-color meta */
class ClassList {
    private names = new Set<string>();

    toggle(name : string, force : boolean) : boolean {
        if (force) {
            this.names.add(name);
        } else {
            this.names.delete(name);
        }
        return force;
    }

    contains(name : string) : boolean {
        return this.names.has(name);
    }
}

const body = { classList: new ClassList() };
const root = { style: { colorScheme: "" },
    dataset: {} as Record<string, string> };
const themeColor = { content: "",
    setAttribute(name : string, value : string) {
        if (name === "content") {
            this.content = value;
        }
    } };

// The two palettes of `tokens.scss`, with the whitespace a computed custom property keeps
const SURFACE = { light: " #f4f6f8",
    dark: " #111419" };

const system = new FakeMediaQuery("(prefers-color-scheme: dark)");
const storage = new MemoryStorage();
const queries : string[] = [];
const page = Object.assign(new EventTarget(), {
    matchMedia(query : string) {
        queries.push(query);
        return system;
    },
});
Object.defineProperty(page, "localStorage", { get: () => {
    if (storage.blocked) {
        // A blocked storage refuses the property itself, not only its methods
        throw new Error("The operation is insecure.");
    }
    return storage;
} });

installGlobal("window", () => page);
installGlobal("localStorage", () => (page as unknown as { localStorage : MemoryStorage }).localStorage);
installGlobal("document", () => ({ body,
    documentElement: root,
    querySelector: (selector : string) => selector === "#theme-color" ? themeColor : null }));
installGlobal("getComputedStyle", () => (element : typeof body) => ({
    getPropertyValue: (name : string) => name === "--surface-base" ? SURFACE[element.classList.contains("dark") ? "dark" : "light"] : "",
}));

const { default: theme } = await import("../../frontend/src/mixins/theme");

type Theme = InstanceType<typeof theme>;

/**
 * A fresh page: the stored choice and the system setting as a test sets them
 * @param options What the device has
 * @param options.stored Theme saved on this device, if any
 * @param options.systemDark Whether the operating system is dark
 * @param options.blocked Whether the browser refuses storage
 * @returns The mounted theme
 */
function openPage(options : { stored? : string; systemDark? : boolean; blocked? : boolean } = {}) {
    storage.blocked = false;
    storage.clear();
    if (options.stored !== undefined) {
        storage.setItem("theme", options.stored);
    }
    storage.blocked = options.blocked ?? false;
    system.matches = options.systemDark ?? false;
    return mountOptions<Theme>({ mixins: [ theme ] });
}

/**
 * The palette on the page, as the browser would draw it
 * @returns What the body, the root element and the meta say
 */
function drawn() {
    return { dark: body.classList.contains("dark"),
        light: body.classList.contains("light"),
        colorScheme: root.style.colorScheme,
        bsTheme: root.dataset.bsTheme,
        themeColor: themeColor.content };
}

/**
 * Another tab changing the storage this page shares
 * @param key Key the other tab changed, null when it cleared the storage
 */
function otherTab(key : string | null) : void {
    page.dispatchEvent(Object.assign(new Event("storage"), { key }));
}

test("the theme asks the operating system for its dark preference", () => {
    assert.deepEqual(queries, [ "(prefers-color-scheme: dark)" ]);
});

test("without a saved choice the page follows the system, now and when it changes", async () => {
    const { vm, errors, unmount } = openPage({ systemDark: true });

    assert.equal(vm.userTheme, "auto");
    assert.equal(vm.theme, "dark");
    assert.equal(vm.isDark, true);
    assert.deepEqual(drawn(), { dark: true,
        light: false,
        colorScheme: "dark",
        bsTheme: "dark",
        themeColor: "#111419" });

    system.change(false);
    await nextTick();
    assert.equal(vm.theme, "light");
    assert.deepEqual(drawn(), { dark: false,
        light: true,
        colorScheme: "light",
        bsTheme: "light",
        themeColor: "#f4f6f8" });

    // Following the system is not a choice, so nothing is written on the device's behalf
    assert.equal(storage.getItem("theme"), null);
    assert.deepEqual(errors, []);
    unmount();
});

test("an explicit choice outranks the system and is remembered on the device", async () => {
    const { vm, errors, unmount } = openPage({ stored: "light",
        systemDark: true });
    assert.equal(vm.theme, "light");

    system.change(false);
    system.change(true);
    await nextTick();
    assert.equal(vm.theme, "light");

    vm.userTheme = "dark";
    await nextTick();
    assert.equal(vm.theme, "dark");
    assert.equal(drawn().colorScheme, "dark");
    assert.equal(storage.getItem("theme"), "dark");

    // Going back to automatic is saved too, and hands the decision back to the system
    vm.userTheme = "auto";
    await nextTick();
    assert.equal(storage.getItem("theme"), "auto");
    assert.equal(vm.theme, "dark");
    assert.deepEqual(errors, []);
    unmount();
});

test("an obsolete value is read as automatic and never written to the device", async () => {
    const { vm, unmount } = openPage({ stored: "solarized",
        systemDark: false });
    assert.equal(vm.userTheme, "auto");
    assert.equal(vm.theme, "light");

    (vm as { userTheme : string }).userTheme = "solarized";
    await nextTick();
    assert.equal(storage.getItem("theme"), "auto");
    unmount();
});

test("a choice made in another tab is followed, a change of another key is not", async () => {
    const { vm, errors, unmount } = openPage({ systemDark: false });

    storage.setItem("theme", "dark");
    otherTab("theme");
    await nextTick();
    assert.equal(vm.userTheme, "dark");
    assert.equal(drawn().dark, true);

    storage.setItem("theme", "light");
    otherTab("locale");
    await nextTick();
    assert.equal(vm.userTheme, "dark", "a foreign key must not re-read the theme");

    // Another tab cleared the whole storage: the key is null and the choice is gone
    storage.clear();
    otherTab(null);
    await nextTick();
    assert.equal(vm.userTheme, "auto");
    assert.equal(vm.theme, "light");
    assert.deepEqual(errors, []);
    unmount();
});

test("blocked storage leaves the choice working for this page", async () => {
    const { vm, errors, unmount } = openPage({ stored: "dark",
        systemDark: true,
        blocked: true });

    // Nothing could be read, so the page follows the system rather than failing to open
    assert.equal(vm.userTheme, "auto");
    assert.equal(vm.theme, "dark");

    vm.userTheme = "light";
    await nextTick();
    assert.equal(vm.theme, "light");
    assert.equal(drawn().light, true);
    assert.deepEqual(errors, [], "a refused write must not surface as an error");

    storage.blocked = false;
    assert.equal(storage.getItem("theme"), "dark", "the refused write changed nothing");
    unmount();
});

test("an unmounted page stops following the system and the other tabs", async () => {
    const before = { system: getEventListeners(system, "change").length,
        storage: getEventListeners(page, "storage").length };
    const { vm, unmount } = openPage({ systemDark: false });
    assert.equal(getEventListeners(system, "change").length, before.system + 1);
    assert.equal(getEventListeners(page, "storage").length, before.storage + 1);

    unmount();
    assert.equal(getEventListeners(system, "change").length, before.system);
    assert.equal(getEventListeners(page, "storage").length, before.storage);

    system.change(true);
    storage.setItem("theme", "dark");
    otherTab("theme");
    await nextTick();
    assert.equal(vm.system, "light");
    assert.equal(vm.userTheme, "auto");
});
