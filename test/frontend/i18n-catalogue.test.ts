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

test("the switcher offers a language only when it is fully translated", () => {
    const english = keysOf(catalogue("en"));
    const listed = new Set(listedCodes());
    const wrong : string[] = [];

    // Half a panel in one language and half in another is not a choice of language,
    // it is a fault. A catalogue that is behind stays in the repository and out of
    // the menu until it catches up, and one that is complete has no reason to hide
    for (const code of fileCodes()) {
        const keys = new Set(keysOf(catalogue(code)));
        const missing = english.filter((key) => !keys.has(key));

        if (missing.length > 0 && listed.has(code)) {
            wrong.push(`${code}: offered but ${missing.length} key(s) are missing`);
        }

        if (missing.length === 0 && !listed.has(code)) {
            wrong.push(`${code}: complete but not in languageList`);
        }
    }

    assert.deepEqual(wrong, []);
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

/**
 * Every source file of a directory tree, recursively
 * @param dir Directory to walk
 * @param extensions Extensions to keep, with the dot
 * @returns Absolute paths
 */
function sourceFiles(dir : string, extensions : string[]) : string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            return sourceFiles(full, extensions);
        }

        return extensions.some((ext) => entry.name.endsWith(ext)) ? [ full ] : [];
    });
}

test("every $t() literal names a key that exists", () => {
    const english = new Set(keysOf(catalogue("en")));
    const misses : string[] = [];

    for (const file of sourceFiles(path.join(process.cwd(), "frontend/src"), [ ".vue", ".ts" ])) {
        const source = readFileSync(file, "utf-8");

        // The toasts translate what they are given, so a sentence there is a miss too
        for (const match of source.matchAll(/(?:\$t|toastSuccess|toastError)\(\s*(["'`])([^"'`$]+)\1\s*(\)|,)/g)) {
            const key = match[2]!;

            if (!english.has(key)) {
                misses.push(`${path.relative(process.cwd(), file)}: ${key}`);
            }
        }
    }

    // The toasts translate their argument, so a text translated before it is looked up
    // as a key, misses, and is shown as an unexpected error
    for (const file of sourceFiles(path.join(process.cwd(), "frontend/src"), [ ".vue", ".ts" ])) {
        const source = readFileSync(file, "utf-8");

        for (const match of source.matchAll(/toast(?:Success|Error)\(\s*[^)]*(\$t\(|serverText\()/g)) {
            misses.push(`${path.relative(process.cwd(), file)}: ${match[0]}`);
        }
    }

    // A key that does not exist is not an error anywhere: vue-i18n prints the key
    // itself, in every language at once. `$t("Cancel")` next to a catalogue that
    // spells the key `cancel` put an English word in front of every reader, and the
    // catalogues agreed with each other the whole time
    assert.deepEqual(misses, [], "$t() asks for a key en.json does not have");
});

test("the server sends keys, not sentences, to the toast", () => {
    const english = new Set(keysOf(catalogue("en")));
    const strays : string[] = [];

    for (const dir of [ "backend/socket-handlers", "backend/agent-socket-handlers" ]) {
        for (const file of sourceFiles(path.join(process.cwd(), dir), [ ".ts" ])) {
            const source = readFileSync(file, "utf-8");

            for (const match of source.matchAll(/\bmsg:\s*"([^"]+)"/g)) {
                const value = match[1]!;

                if (!english.has(value)) {
                    strays.push(`${path.relative(process.cwd(), file)}: ${value}`);
                }
            }
        }
    }

    // `callbackError` marks every message as translatable, so whatever a handler puts
    // in `msg` reaches `$t`. A sentence assembled on the server - "Service x started" -
    // has no key and cannot get one, and the reader sees English. Handlers name a key
    // and pass the parts as values
    assert.deepEqual(strays, [], "msg: is a sentence rather than a key of en.json");

    // A thrown error ends up in the same `msg`, so the rule covers what the Git flow
    // throws as well. These went unchecked and reached the user as whole sentences in
    // one language - under "Unexpected error:", because no catalogue had them
    const thrown : string[] = [];
    let reasons = 0;

    for (const file of sourceFiles(path.join(process.cwd(), "backend"), [ ".ts" ])) {
        const source = readFileSync(file, "utf-8");

        for (const match of source.matchAll(/new StackGitError\(\s*"([^"]+)"/g)) {
            reasons++;

            if (!english.has(match[1]!)) {
                thrown.push(`${path.relative(process.cwd(), file)}: ${match[1]}`);
            }
        }
    }

    assert.ok(reasons > 20, `expected the Git flow to name many reasons, found ${reasons}`);
    assert.deepEqual(thrown, [], "StackGitError carries a sentence rather than a key of en.json");

    // An entry with a placeholder needs the value that fills it. Thrown without one, the
    // key is translated all the same and the reader is shown "{max}" where a number belongs
    const catalogueEn = catalogue("en");
    const placeholders = new Set(Object.entries(catalogueEn)
        .filter(([ , value ]) => typeof value === "string" && /\{[^}]+\}/.test(value))
        .map(([ key ]) => key));
    const unfilled : string[] = [];

    for (const file of sourceFiles(path.join(process.cwd(), "backend"), [ ".ts" ])) {
        const source = readFileSync(file, "utf-8");

        for (const match of source.matchAll(/new (?:ValidationError|StackGitError)\(\s*"([^"]+)"\s*(\)|,)/g)) {
            if (placeholders.has(match[1]!) && match[2] === ")") {
                unfilled.push(`${path.relative(process.cwd(), file)}: ${match[1]}`);
            }
        }
    }

    assert.deepEqual(unfilled, [], "thrown without the values its catalogue entry interpolates");

    // A refusal the interface can provoke names a key too, or a Russian reader is told
    // "Unexpected error: Stack not found". Only the checks of the protocol stay English:
    // a well-formed client never sends a number where a stack name belongs
    const sentences : string[] = [];

    for (const file of sourceFiles(path.join(process.cwd(), "backend"), [ ".ts" ])) {
        const source = readFileSync(file, "utf-8");

        for (const match of source.matchAll(/new ValidationError\(\s*(?:"([^"]*)"\s*([),+])|(`))/g)) {
            const [ , text, after, template ] = match;
            const protocol = text !== undefined && /must (?:be|hold)\b|^Wrong data type\?$/.test(text);

            if (template || after === "+" || (!protocol && !english.has(text!))) {
                sentences.push(`${path.relative(process.cwd(), file)}: ${text ?? "template"}`);
            }
        }
    }

    assert.deepEqual(sentences, [], "ValidationError carries a sentence rather than a key of en.json");
});

test("keys are camelCase, with an identifier the code looks up after an underscore", () => {
    const wrong : string[] = [];

    for (const [ key, value ] of Object.entries(catalogue("en"))) {
        if (!/^[a-z][a-zA-Z0-9]*(_[A-Za-z0-9_:.-]+)?$/.test(key)) {
            wrong.push(key);
        }
        // A nested branch is keyed by a protocol value, such as an updater reason
        if (value !== null && typeof value === "object") {
            wrong.push(...Object.keys(value).filter((child) => !/^[a-z][a-z0-9-]*$/.test(child)).map((child) => `${key}.${child}`));
        }
    }

    // "Current Password" next to "currentPassword" invited a second key for the same
    // label, and a sentence as a key breaks the moment the English wording is improved
    assert.deepEqual(wrong, [], "a key of en.json is not camelCase");
});

test("a message an older server sends still finds its entry", async () => {
    const { FORMER_MESSAGE_KEYS, currentMessageKey } = await import("../../frontend/src/server-message-keys");
    const english = catalogue("en");

    for (const [ former, current ] of Object.entries(FORMER_MESSAGE_KEYS)) {
        assert.equal(currentMessageKey(former), current);
        assert.equal(typeof english[current], "string", `${former} points at ${current}, which en.json does not have`);
        assert.equal(english[former], undefined, `${former} is still a key, the table is not needed for it`);
    }
    assert.equal(currentMessageKey("saved"), "saved");
    assert.equal(currentMessageKey("constructor"), "constructor");
});
