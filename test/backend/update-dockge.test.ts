import { strict as assert } from "node:assert";
import test from "node:test";
import { buildUpdateCommands, formatCommand, parseUpdateArgs } from "../../extra/update-dockge";

test("update commands are built as fixed argument arrays", () => {
    assert.deepEqual(buildUpdateCommands(false), [
        { command: "git",
            args: [ "pull", "--ff-only", "origin", "master" ] },
        { command: "docker",
            args: [ "compose", "config", "--quiet" ] },
        { command: "docker",
            args: [ "compose", "up", "-d", "--pull", "always", "--wait", "--wait-timeout", "60" ] },
    ]);

    assert.deepEqual(buildUpdateCommands(true)[2], {
        command: "docker",
        args: [ "compose", "up", "-d", "--pull", "always", "--force-recreate", "--wait", "--wait-timeout", "60" ],
    });
});

test("update commands never contain destructive or shell syntax", () => {
    const printed = [ ...buildUpdateCommands(true), ...buildUpdateCommands(false) ].map(formatCommand).join("\n");

    for (const forbidden of [ "down", "-v", "volume prune", "reset --hard", "clean -fdx", "&&", ";", "|", "$(" ]) {
        assert.equal(printed.includes(forbidden), false, `unexpected ${forbidden} in update commands`);
    }
});

test("only the documented arguments are accepted", () => {
    assert.deepEqual(parseUpdateArgs([]), { dryRun: false,
        forceRecreate: false });
    assert.deepEqual(parseUpdateArgs([ "--dry-run" ]), { dryRun: true,
        forceRecreate: false });
    assert.deepEqual(parseUpdateArgs([ "--dry-run", "--force-recreate" ]), { dryRun: true,
        forceRecreate: true });

    assert.throws(() => parseUpdateArgs([ "--remove-volumes" ]), /Unknown argument/);
    assert.throws(() => parseUpdateArgs([ "-v" ]), /Unknown argument/);
});
