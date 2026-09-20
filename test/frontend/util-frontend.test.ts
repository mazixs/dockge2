import { strict as assert } from "node:assert";
import test from "node:test";
import { errorText, setPageLocale } from "../../frontend/src/util-frontend";

test("the page says which language it is in and which way it reads", () => {
    const attributes : Record<string, string> = {};
    const global = globalThis as { document? : unknown };
    const before = global.document;

    global.document = { documentElement: { setAttribute: (name : string, value : string) => {
        attributes[name] = value;
    } } };
    try {
        setPageLocale();
    } finally {
        global.document = before;
    }

    // A screen reader and the browser both need this, and a right to left language needs
    // the direction as well as the name of the language
    assert.equal(typeof attributes.lang, "string");
    assert.ok((attributes.lang ?? "").length >= 2);
    assert.ok([ "ltr", "rtl" ].includes(attributes.dir ?? ""));
});

test("what is shown for a failure is a message, whatever was thrown", () => {
    assert.equal(errorText(new Error("compose.yaml is not valid")), "compose.yaml is not valid");
    assert.equal(errorText(new TypeError("services is not an object")), "services is not an object");

    // A `catch` receives whatever was thrown, and a YAML parser or a library can throw a
    // string or a plain object. Reading `.message` off those shows the user "undefined"
    // exactly when something unexpected happened, which says nothing about the failure
    for (const thrown of [ "network error", { code: 42 }, 0, false ]) {
        const shown = errorText(thrown);

        assert.equal(typeof shown, "string");
        assert.notEqual(shown, "undefined", `${String(thrown)} has to be named, not reported as undefined`);
    }

    assert.equal(errorText("network error"), "network error");

    // Nothing at all was thrown along with the failure: there is no text to show, but the
    // caller still gets a string and the screen is not asked to render an absent value
    assert.equal(typeof errorText(undefined), "string");
    assert.equal(typeof errorText(null), "string");
});
