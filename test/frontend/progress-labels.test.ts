import { strict as assert } from "node:assert";
import test from "node:test";
import { COMMAND_KEYS, KIND_ICONS, KIND_KEYS, VERB_KEYS, VERB_KIND_KEYS } from "../../frontend/src/progress-labels";
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

test("a finished step names the resource in a form that agrees with it", () => {
    // "Сеть app_default создано" is what a single neutral verb produced: the sentence is
    // assembled from kind, name and verb, so the catalogue has to hold the form that
    // belongs to the noun in front of it
    for (const [ kind, verbs ] of Object.entries(VERB_KIND_KEYS)) {
        assert.ok(KIND_KEYS[kind], `${kind} is not a kind of resource`);

        for (const [ verb, key ] of Object.entries(verbs)) {
            assert.ok(VERB_KEYS[verb], `${verb} is not a verb of the progress panel`);

            for (const [ language, catalogue ] of Object.entries(CATALOGUES)) {
                assert.equal(typeof catalogue[key], "string", `${language} is missing ${key}`);
            }
        }
    }

    // The fallback is the only reason a missing form is not visible, so the forms that
    // do exist have to differ from it where the language asks for it
    assert.notEqual(ru.progressVerbCreatedNetwork, ru.progressVerbCreated);
});
