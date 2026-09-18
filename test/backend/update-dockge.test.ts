import { strict as assert } from "node:assert";
import test from "node:test";
import { buildUpdateCommands, DEFAULT_BRANCH, formatCommand, parseUpdateArgs } from "../../extra/update-dockge";

test("update commands are built as fixed argument arrays", () => {
    assert.deepEqual(buildUpdateCommands(false), [
        { command: "git",
            args: [ "pull", "--ff-only", "origin", "main" ] },
        { command: "docker",
            args: [ "compose", "config", "--quiet" ] },
        { command: "docker",
            args: [ "compose", "up", "-d", "--build", "--wait", "--wait-timeout", "60" ] },
    ]);

    assert.deepEqual(buildUpdateCommands(true).at(-1), {
        command: "docker",
        args: [ "compose", "up", "-d", "--build", "--force-recreate", "--wait", "--wait-timeout", "60" ],
    });
});

test("update commands never contain destructive or shell syntax", () => {
    const printed = [ ...buildUpdateCommands(true), ...buildUpdateCommands(false) ].map(formatCommand).join("\n");

    for (const forbidden of [ "down", "-v", "volume prune", "reset --hard", "clean -fdx", "&&", ";", "|", "$(" ]) {
        assert.equal(printed.includes(forbidden), false, `unexpected ${forbidden} in update commands`);
    }
});

test("only the documented arguments are accepted", () => {
    assert.equal(DEFAULT_BRANCH, "main");

    assert.deepEqual(parseUpdateArgs([]), { dryRun: false,
        forceRecreate: false,
        branch: "main" });
    assert.deepEqual(parseUpdateArgs([ "--dry-run" ]), { dryRun: true,
        forceRecreate: false,
        branch: "main" });
    assert.deepEqual(parseUpdateArgs([ "--dry-run", "--force-recreate" ]), { dryRun: true,
        forceRecreate: true,
        branch: "main" });

    // A deployment that still tracks another branch can name it
    assert.deepEqual(parseUpdateArgs([ "--branch=release/2.0" ]), { dryRun: false,
        forceRecreate: false,
        branch: "release/2.0" });
    assert.deepEqual(buildUpdateCommands(false, "release/2.0")[0], {
        command: "git",
        args: [ "pull", "--ff-only", "origin", "release/2.0" ],
    });

    assert.throws(() => parseUpdateArgs([ "--remove-volumes" ]), /Unknown argument/);
    assert.throws(() => parseUpdateArgs([ "-v" ]), /Unknown argument/);

    // A branch name must not smuggle options, paths or shell syntax
    for (const bad of [ "--upload-pack=evil", "../evil", "main;rm -rf /", "main branch", "" ]) {
        assert.throws(() => parseUpdateArgs([ `--branch=${bad}` ]), /Invalid branch name/, `${bad} must be rejected`);
        assert.throws(() => buildUpdateCommands(false, bad), /Invalid branch name/, `${bad} must be rejected`);
    }
});
