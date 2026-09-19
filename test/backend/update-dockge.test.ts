import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildUpdateCommands, DEFAULT_BRANCH, formatCommand, imageComesFromRegistry, parseUpdateArgs, readConfiguredImage } from "../../extra/update-dockge";

test("update commands are built as fixed argument arrays", () => {
    assert.deepEqual(buildUpdateCommands(false), [
        { command: "git",
            args: [ "pull", "--ff-only", "origin", "main" ] },
        { command: "docker",
            args: [ "compose", "config", "--quiet" ] },
        { command: "docker",
            args: [ "compose", "up", "-d", "--build", "--wait", "--wait-timeout", "180" ] },
    ]);

    assert.deepEqual(buildUpdateCommands(true).at(-1), {
        command: "docker",
        args: [ "compose", "up", "-d", "--build", "--force-recreate", "--wait", "--wait-timeout", "180" ],
    });
});

test("a published image is downloaded instead of built", () => {
    // Building the frontend needs about 1 GB of memory, so a deployment that
    // runs a published image must never be rebuilt to update it
    assert.deepEqual(buildUpdateCommands(false, DEFAULT_BRANCH, "registry"), [
        { command: "git",
            args: [ "pull", "--ff-only", "origin", "main" ] },
        { command: "docker",
            args: [ "compose", "config", "--quiet" ] },
        { command: "docker",
            args: [ "compose", "pull" ] },
        { command: "docker",
            args: [ "compose", "up", "-d", "--wait", "--wait-timeout", "180" ] },
    ]);

    const built = buildUpdateCommands(false, DEFAULT_BRANCH, "build");
    assert.equal(built.some((c) => c.args.includes("pull") && c.args.includes("compose")), false);
    assert.equal(formatCommand(built.at(-1)!).includes("--build"), true);
});

test("an image name says whether it can be downloaded", () => {
    for (const published of [ "ghcr.io/mazixs/dockge2:latest", "mazixs/dockge2:2.0.0", " ghcr.io/mazixs/dockge2:nightly " ]) {
        assert.equal(imageComesFromRegistry(published), true, `${published} can be downloaded`);
    }

    for (const local of [ "dockge2:latest", "dockge2:rollback-2026-09-19", "" ]) {
        assert.equal(imageComesFromRegistry(local), false, `${local} was built here`);
    }
});

test("DOCKGE_IMAGE is read from .env without evaluating it", () => {
    const dir = mkdtempSync(join(tmpdir(), "dockge2-update-"));
    const envFile = join(dir, ".env");

    writeFileSync(envFile, "# a comment\nDOCKGE_PORT=5001\nDOCKGE_IMAGE=\"ghcr.io/mazixs/dockge2:latest\"\n");
    assert.equal(readConfiguredImage(envFile), "ghcr.io/mazixs/dockge2:latest");

    writeFileSync(envFile, "DOCKGE_IMAGE=dockge2:latest\n");
    assert.equal(readConfiguredImage(envFile), "dockge2:latest");

    writeFileSync(envFile, "DOCKGE_PORT=5001\n");
    assert.equal(readConfiguredImage(envFile), "");

    // A missing file is a deployment that never set it, not a crash
    assert.equal(readConfiguredImage(join(dir, "nothing-here")), "");

    rmSync(dir, { recursive: true,
        force: true });
});

test("update commands never contain destructive or shell syntax", () => {
    const printed = [
        ...buildUpdateCommands(true),
        ...buildUpdateCommands(false),
        ...buildUpdateCommands(true, DEFAULT_BRANCH, "registry"),
        ...buildUpdateCommands(false, DEFAULT_BRANCH, "registry"),
    ].map(formatCommand).join("\n");

    for (const forbidden of [ "down", "-v", "volume prune", "reset --hard", "clean -fdx", "&&", ";", "|", "$(" ]) {
        assert.equal(printed.includes(forbidden), false, `unexpected ${forbidden} in update commands`);
    }
});

test("only the documented arguments are accepted", () => {
    assert.equal(DEFAULT_BRANCH, "main");

    assert.deepEqual(parseUpdateArgs([]), { dryRun: false,
        forceRecreate: false,
        branch: "main",
        source: "auto" });
    assert.deepEqual(parseUpdateArgs([ "--dry-run" ]), { dryRun: true,
        forceRecreate: false,
        branch: "main",
        source: "auto" });
    assert.deepEqual(parseUpdateArgs([ "--dry-run", "--force-recreate" ]), { dryRun: true,
        forceRecreate: true,
        branch: "main",
        source: "auto" });

    // Which way the image comes can be said outright, in either direction
    assert.equal(parseUpdateArgs([ "--pull" ]).source, "registry");
    assert.equal(parseUpdateArgs([ "--build" ]).source, "build");

    // A deployment that still tracks another branch can name it
    assert.deepEqual(parseUpdateArgs([ "--branch=release/2.0" ]), { dryRun: false,
        forceRecreate: false,
        branch: "release/2.0",
        source: "auto" });
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
