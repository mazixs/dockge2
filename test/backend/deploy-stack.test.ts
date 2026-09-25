import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import { fileExists } from "../../backend/util-server";
import { buildDeployCommands, formatCommand, parseDeployArgs, runDeploy } from "../../extra/deploy-stack";

const baseOptions = {
    stack: "my-stack",
    stacksDir: "/opt/stacks",
    composeFile: "compose.yaml",
    envFiles: [] as string[],
    branch: "main",
    dryRun: false,
    forceRecreate: false,
    skipGit: false,
};

test("stack deployment names the file, the env files and the branch explicitly", () => {
    const commands = buildDeployCommands({
        ...baseOptions,
        composeFile: "staging.yml",
        envFiles: [ ".env", ".env.product" ],
        branch: "release/2.0",
    });

    const stackDir = path.join("/opt/stacks", "my-stack");

    assert.deepEqual(commands.map(formatCommand), [
        `git -C ${stackDir} status --porcelain`,
        `git -C ${stackDir} pull --ff-only origin release/2.0`,
        "docker compose --env-file ./.env --env-file ./.env.product -f staging.yml config --quiet",
        "docker compose --env-file ./.env --env-file ./.env.product -f staging.yml up -d --pull always --wait --wait-timeout 60",
    ]);
});

test("the git step can be skipped and recreation is opt-in", () => {
    const withoutGit = buildDeployCommands({ ...baseOptions,
        skipGit: true,
        forceRecreate: true });

    assert.deepEqual(withoutGit.map(formatCommand), [
        "docker compose -f compose.yaml config --quiet",
        "docker compose -f compose.yaml up -d --pull always --force-recreate --wait --wait-timeout 60",
    ]);
});

test("deployment never contains destructive or shell syntax", () => {
    const printed = buildDeployCommands({ ...baseOptions,
        forceRecreate: true }).map(formatCommand).join("\n");

    for (const forbidden of [ "down", "reset --hard", "clean -fdx", "volume prune", "&&", ";", "|", "$(" ]) {
        assert.equal(printed.includes(forbidden), false, `unexpected ${forbidden} in deploy commands`);
    }
});

test("unsafe stack names, branches and file names are refused", () => {
    for (const stack of [ "../escape", "My-Stack", "stack;rm", "" ]) {
        assert.throws(() => buildDeployCommands({ ...baseOptions,
            stack }), /Invalid stack name/, `${stack} must be rejected`);
    }

    for (const branch of [ "--upload-pack=evil", "../evil", "main;rm -rf /", "" ]) {
        assert.throws(() => buildDeployCommands({ ...baseOptions,
            branch }), /Invalid branch name/, `${branch} must be rejected`);
    }

    for (const composeFile of [ "../compose.yaml", "/etc/compose.yaml", "notes.txt", ".env" ]) {
        assert.throws(() => buildDeployCommands({ ...baseOptions,
            composeFile }), /Invalid compose file/, `${composeFile} must be rejected`);
    }

    for (const envFile of [ "../outside.env", "compose.yaml", ".secret", "notes.txt" ]) {
        assert.throws(() => buildDeployCommands({ ...baseOptions,
            envFiles: [ envFile ] }), /Invalid env file/, `${envFile} must be rejected`);
    }
});

test("arguments are parsed and validated together", () => {
    const options = parseDeployArgs([
        "--stack=my-stack",
        "--stacks-dir=/tmp/stacks",
        "--file=staging.yml",
        "--env-file=.env",
        "--env-file=.env.dev",
        "--branch=main",
        "--dry-run",
    ]);

    assert.deepEqual(options, {
        stack: "my-stack",
        stacksDir: "/tmp/stacks",
        composeFile: "staging.yml",
        envFiles: [ ".env", ".env.dev" ],
        branch: "main",
        dryRun: true,
        forceRecreate: false,
        skipGit: false,
    });

    assert.throws(() => parseDeployArgs([]), /Missing --stack/);
    assert.throws(() => parseDeployArgs([ "--stack=my-stack", "--wipe" ]), /Unknown argument/);
    assert.throws(() => parseDeployArgs([ "--stack=../escape" ]), /Invalid stack name/);
});

test("a dry run prints the commands and touches nothing", async () => {
    const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-deploy-dry-"));
    const stackDir = path.join(stacksDir, "dry-stack");
    await mkdir(stackDir);
    await writeFile(path.join(stackDir, "compose.yaml"), "services:\n  app:\n    image: alpine\n");

    const lines : string[] = [];
    const originalLog = console.log;
    console.log = (...args : unknown[]) => {
        lines.push(args.join(" "));
    };

    try {
        await runDeploy({
            ...baseOptions,
            stack: "dry-stack",
            stacksDir,
            dryRun: true,
        });
    } finally {
        console.log = originalLog;
        await rm(stacksDir, { recursive: true,
            force: true });
    }

    const printed = lines.join("\n");
    assert.match(printed, /Dry run for dry-stack/);
    assert.match(printed, /git -C .*dry-stack status --porcelain/);
    assert.match(printed, /docker compose -f compose\.yaml config --quiet/);
    assert.match(printed, /docker compose -f compose\.yaml up -d --pull always --wait --wait-timeout 60/);

    // Nothing was executed, so no git repository appeared
    assert.equal(await fileExists(path.join(stacksDir, "dry-stack", ".git")), false);
});

test("a stack directory with local changes stops the deployment", async () => {
    const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-deploy-dirty-"));
    const stackDir = path.join(stacksDir, "dirty-stack");
    await mkdir(stackDir);
    await writeFile(path.join(stackDir, "compose.yaml"), "services:\n  app:\n    image: alpine\n");

    // A real git repository with an uncommitted file
    await spawn("git", [ "-C", stackDir, "init", "-q" ], {
        encoding: "utf-8",
        timeoutMs: 60_000,
    });

    const originalLog = console.log;
    console.log = () => undefined;

    try {
        await assert.rejects(runDeploy({
            ...baseOptions,
            stack: "dirty-stack",
            stacksDir,
            dryRun: false,
        }), /local changes/);

        // The deployment stopped before Docker was involved, the file is untouched
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), "services:\n  app:\n    image: alpine\n");
    } finally {
        console.log = originalLog;
        await rm(stacksDir, { recursive: true,
            force: true });
    }
});
