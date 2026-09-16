import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const LANG_DIR = path.join(process.cwd(), "frontend/src/lang");
const I18N_PATH = path.join(process.cwd(), "frontend/src/i18n.ts");

/**
 * Codes offered by the language switcher, read from the source of the list itself.
 *
 * The list is a literal in `i18n.ts` and importing it would pull in vue-i18n and a
 * browser, so it is read as text. A parse failure fails the test rather than
 * silently checking an empty set.
 * @returns Language codes in the switcher
 */
function listedCodes() : string[] {
    const source = readFileSync(I18N_PATH, "utf-8");
    const block = /const languageList[^=]*=\s*\{([\s\S]*?)\n\};/.exec(source);

    assert.ok(block, "languageList not found in i18n.ts");

    const codes = [ ...block[1]!.matchAll(/"([^"]+)"\s*:/g) ].map((match) => match[1]!);

    assert.ok(codes.length > 0, "languageList is empty");
    return codes;
}

/**
 * Translation files present on disk, English excluded: it is bundled statically
 * and never loaded through the switcher's dynamic import
 * @returns Language codes that have a catalogue
 */
function fileCodes() : string[] {
    return readdirSync(LANG_DIR)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.replace(/\.json$/, ""))
        .filter((code) => code !== "en");
}

/**
 * Every key of a catalogue, nested objects flattened to dotted paths
 * @param value Parsed catalogue or one of its branches
 * @param prefix Path of the branch
 * @returns Dotted key paths
 */
function keysOf(value : Record<string, unknown>, prefix = "") : string[] {
    return Object.entries(value).flatMap(([ key, nested ]) => (
        nested !== null && typeof nested === "object"
            ? keysOf(nested as Record<string, unknown>, `${prefix}${key}.`)
            : [ `${prefix}${key}` ]
    ));
}

/**
 * Reads and parses one catalogue
 * @param code Language code
 * @returns Parsed catalogue
 */
function catalogue(code : string) : Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(LANG_DIR, `${code}.json`), "utf-8"));
}

test("every language in the switcher has a catalogue to load", () => {
    const files = new Set(fileCodes());
    const missing = listedCodes().filter((code) => !files.has(code));

    // changeLang() throws "Unknown language" when the file is absent, and the switcher
    // offers whatever the list says. A code without a file is a broken menu entry
    assert.deepEqual(missing, [], "listed but no lang/<code>.json");
});

test("every catalogue is reachable from the switcher", () => {
    const listed = new Set(listedCodes());
    const orphans = fileCodes().filter((code) => !listed.has(code));

    // A catalogue nobody can select is dead weight that still has to be kept in step
    assert.deepEqual(orphans, [], "lang/<code>.json with no entry in languageList");
});

test("English carries every key the other catalogues rely on", () => {
    const english = new Set(keysOf(catalogue("en")));
    const strays : string[] = [];

    for (const code of fileCodes()) {
        for (const key of keysOf(catalogue(code))) {
            if (!english.has(key)) {
                strays.push(`${code}: ${key}`);
            }
        }
    }

    // en.json is the source of truth: a key only another language has is either a
    // string the interface never asks for, or one English itself falls back to by
    // printing the key. Both are invisible until somebody reads the file
    assert.deepEqual(strays, [], "keys missing from en.json");
});

test("every language names itself in the switcher", () => {
    for (const code of fileCodes()) {
        const name = catalogue(code).languageName;

        assert.equal(typeof name, "string", `${code}: languageName is missing`);
        assert.notEqual(name, "", `${code}: languageName is empty`);
    }
});
