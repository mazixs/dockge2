import { strict as assert } from "node:assert";
import test from "node:test";
import { canApplyGitChoices, isSafeGitRepository, diffLineRows } from "../../frontend/src/git-ui";

test("Git source accepts HTTPS and server-configured SSH without embedded passwords", () => {
    assert.equal(isSafeGitRepository("https://github.com/example/app.git"), true);
    assert.equal(isSafeGitRepository("git@example.org:team/app.git"), true);
    assert.equal(isSafeGitRepository("ssh://git@example.org/team/app.git"), true);
    for (const repository of [ "", "file:///etc", "https://token@example.org/app", "ssh://git:password@example.org/app", "https://example.org/app?token=secret" ]) {
        assert.equal(isSafeGitRepository(repository), false);
    }
});

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
