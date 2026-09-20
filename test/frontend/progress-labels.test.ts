import { strict as assert } from "node:assert";
import test from "node:test";
import { COMMAND_KEYS, KIND_ICONS, KIND_KEYS, VERB_KEYS } from "../../frontend/src/progress-labels";
import en from "../../frontend/src/lang/en.json" with { type: "json" };
import ru from "../../frontend/src/lang/ru.json" with { type: "json" };

const CATALOGUES : Record<string, Record<string, unknown>> = { en,
    ru };

test("every word the progress panel uses exists in the catalogues", () => {
    // A key without an entry is shown to the person as the key itself, and the panel is
    // exactly where that happens while a command is running and nobody is reading code
    const keys = [ ...Object.values(COMMAND_KEYS), ...Object.values(VERB_KEYS), ...Object.values(KIND_KEYS) ];

    assert.ok(keys.length > 20);
    for (const [ language, catalogue ] of Object.entries(CATALOGUES)) {
        const missing = keys.filter((key) => typeof catalogue[key] !== "string");

        assert.deepEqual(missing, [], `${language} is missing entries`);
    }
});

test("a resource of a compose command is named and drawn the same way", () => {
    // The table of services and the progress panel show one kind of resource, so the two
    // maps have to describe the same set
    assert.deepEqual(Object.keys(KIND_ICONS).sort(), Object.keys(KIND_KEYS).sort());
});

test("an action on one service is named like the same action on a stack", () => {
    assert.equal(COMMAND_KEYS.startService, COMMAND_KEYS.startStack);
    assert.equal(COMMAND_KEYS.stopService, COMMAND_KEYS.stopStack);
    assert.equal(COMMAND_KEYS.restartService, COMMAND_KEYS.restartStack);
});
