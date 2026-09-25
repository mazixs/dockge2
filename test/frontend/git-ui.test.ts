import { strict as assert } from "node:assert";
import test from "node:test";
import { canApplyGitChoices, diffLineRows } from "../../frontend/src/git-ui";

test("Every preview file requires its own explicit choice before applying", () => {
    const files = [{ path: "compose.yaml" }, { path: ".env" }];
    assert.equal(canApplyGitChoices(files, {}), false);
    assert.equal(canApplyGitChoices(files, { "compose.yaml": "git" }), false);
    assert.equal(canApplyGitChoices(files, { "compose.yaml": "git",
        ".env": "server" }), true);
    assert.equal(canApplyGitChoices(files, { "compose.yaml": "edit",
        ".env": "server" }), false);
    assert.equal(canApplyGitChoices([], {}), false);
    assert.equal(canApplyGitChoices([{ path: "toString" }], {}), false);
});

test("Comparison identifies added and removed lines without changing source bytes", () => {
    const before = "services:\n  web:\n    image: app:1\n";
    const after = "services:\n  web:\n    image: app:2\n    restart: always\n";
    assert.deepEqual(diffLineRows(before, after).map(row => row.changed), [ false, false, true, false ]);
    assert.deepEqual(diffLineRows(after, before).map(row => row.changed), [ false, false, true, true, false ]);
    assert.deepEqual(diffLineRows("old\nshared\nold2", "new\nshared\nnew2").map(row => row.changed), [ true, false, true ]);
    assert.equal(diffLineRows(null, after).length, 0);
    assert.equal(diffLineRows("", after).length, 1);
});

test("Edited decisions require an explicit draft and cannot reveal hidden or binary files", () => {
    assert.equal(canApplyGitChoices([{ path: "a" }], { a: "edited" }), false);
    assert.equal(canApplyGitChoices([{ path: "a" }], { a: "edited" }, { a: "" }), true);
    assert.equal(canApplyGitChoices([{ path: "a",
        redacted: true }], { a: "edited" }, { a: "text" }), false);
    assert.equal(canApplyGitChoices([{ path: "a",
        binary: true }], { a: "edited" }, { a: "text" }), false);
});
