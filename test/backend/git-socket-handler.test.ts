import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentSocket } from "../../common/agent-socket";
import { ComposeEnvironmentError, GitSocketHandler, logSafeReason, missingEnvFiles, missingVariables } from "../../backend/agent-socket-handlers/git-socket-handler";
import { StackGitWorkflow } from "../../backend/stack-git";
import { StackConfig } from "../../backend/stack-config";
import { Stack } from "../../backend/stack";
import { roleAllowsEvent } from "../../backend/auth-access";
import type { DockgeSocket } from "../../backend/util-server";
import type { DockgeServer } from "../../backend/dockge-server";

function call(socket: AgentSocket, event: string, input: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => socket.call(event, input, resolve));
}

async function handler(t: test.TestContext) {
    const stacksDir = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-git-handler-"));
    t.after(() => fs.rm(stacksDir, { recursive: true,
        force: true }));
    const server = { stacksDir,
        sendStackList: () => undefined } as unknown as DockgeServer;
    const socket = { userID: "fixture-user",
        endpoint: "" } as DockgeSocket;
    const agent = new AgentSocket();
    new GitSocketHandler().create(socket, server, agent);
    return { socket,
        agent,
        stacksDir };
}

const input = { name: "fixture",
    repository: "https://example.invalid/repo.git",
    branch: "main",
    composeFile: "compose.yaml",
    deploy: false };

test("saving a Git clone does not invoke Docker deployment", async (t) => {
    const f = await handler(t);
    const clone = t.mock.method(StackGitWorkflow.prototype, "clone", async (dir: string) => {
        await fs.mkdir(dir);
        return { filesHash: "fixture-hash" };
    });
    const saveConfig = t.mock.method(StackConfig, "set", async () => undefined);
    const getStack = t.mock.method(Stack, "getStack", async () => {
        throw new Error("must not deploy");
    });
    const response = await call(f.agent, "gitCloneStack", input);
    assert.equal(response.ok, true);
    assert.equal(response.saved, true);
    assert.equal(response.deployed, false);
    assert.equal(clone.mock.callCount(), 1);
    assert.equal(saveConfig.mock.callCount(), 1);
    assert.equal(getStack.mock.callCount(), 0);
});

test("deployment failure keeps saved=true and never exposes process errors", async (t) => {
    const f = await handler(t);
    t.mock.method(StackGitWorkflow.prototype, "clone", async (dir: string) => {
        await fs.mkdir(dir);
        return { filesHash: "fixture-hash" };
    });
    t.mock.method(StackConfig, "set", async () => undefined);
    let deployed = 0;
    t.mock.method(Stack, "getStack", async () => ({ deploy: async () => {
        deployed++;
        throw new Error("password=must-not-leak");
    } } as unknown as Stack));
    const response = await call(f.agent, "gitCloneStack", { ...input,
        deploy: true });
    assert.equal(response.ok, true);
    assert.equal(response.saved, true);
    assert.equal(response.deployed, false);
    assert.equal(deployed, 1);
    assert.deepEqual(response.deploymentError, { key: "gitDeployFailedAfterSave" });
    assert.ok(!JSON.stringify(response).includes("must-not-leak"));
});

test("metadata failure never launches a stack with a different file selection", async (t) => {
    const f = await handler(t);
    t.mock.method(StackGitWorkflow.prototype, "clone", async (dir: string) => {
        await fs.mkdir(dir);
        return { filesHash: "fixture-hash" };
    });
    t.mock.method(StackConfig, "set", async () => {
        throw new Error("database unavailable");
    });
    const getStack = t.mock.method(Stack, "getStack", async () => {
        throw new Error("must not deploy");
    });
    const response = await call(f.agent, "gitCloneStack", { ...input,
        deploy: true });
    assert.equal(response.ok, true);
    assert.equal(response.saved, true);
    assert.equal(response.deployed, false);
    assert.deepEqual(response.deploymentError, { key: "gitSelectionNotStored" });
    assert.equal(getStack.mock.callCount(), 0);
});

test("a checkout whose environment is not filled in is saved and left stopped", async (t) => {
    // A repository keeps .env out of Git, so a compose file reading ${VAR:?} cannot pass a
    // check at clone time. Refusing the whole import would leave the user with nowhere to
    // put the variables: they go in the files this import is supposed to produce
    const f = await handler(t);
    t.mock.method(StackGitWorkflow.prototype, "clone", async (dir: string) => {
        await fs.mkdir(dir);
        return { filesHash: "fixture-hash",
            pending: new ComposeEnvironmentError([ "TELEGRAM_API_ID", "TELEGRAM_API_HASH" ]) };
    });
    const saveConfig = t.mock.method(StackConfig, "set", async () => undefined);
    const getStack = t.mock.method(Stack, "getStack", async () => {
        throw new Error("must not deploy");
    });
    const response = await call(f.agent, "gitCloneStack", { ...input,
        deploy: true });
    assert.equal(response.ok, true);
    assert.equal(response.saved, true);
    assert.equal(response.deployed, false);
    assert.equal(saveConfig.mock.callCount(), 1);
    // Starting it would only fail on the same variables, so it is not attempted
    assert.equal(getStack.mock.callCount(), 0);
    assert.deepEqual(response.notStarted, { key: "gitSavedNeedsVariables",
        values: { variables: "TELEGRAM_API_ID, TELEGRAM_API_HASH" } });
    // Waiting for the environment is not a failed deployment
    assert.equal(response.deploymentError, undefined);
});

test("a checkout without the env file a service reads is saved, and the card names the file and its example", async (t) => {
    // .env sits in .gitignore next to .env.example, and env_file: .env fails the check the
    // same way a missing variable does
    const f = await handler(t);
    let pending = new ComposeEnvironmentError([], [ ".env" ], [{ file: ".env",
        example: ".env.example" }]);
    t.mock.method(StackGitWorkflow.prototype, "clone", async (dir: string) => {
        await fs.mkdir(dir);
        return { filesHash: "fixture-hash",
            pending };
    });
    t.mock.method(StackConfig, "set", async () => undefined);
    const getStack = t.mock.method(Stack, "getStack", async () => {
        throw new Error("must not deploy");
    });
    const response = await call(f.agent, "gitCloneStack", { ...input,
        deploy: true });
    assert.equal(response.saved, true);
    assert.equal(response.deployed, false);
    assert.equal(getStack.mock.callCount(), 0);
    assert.deepEqual(response.notStarted, { key: "gitSavedNeedsEnvFileFromExample",
        values: { files: ".env",
            example: ".env.example" } });
    // The card offers the copy; making it is a separate request of the user
    assert.deepEqual(response.envExamples, [{ file: ".env",
        example: ".env.example" }]);
    // Without an example the card asks for the file alone
    pending = new ComposeEnvironmentError([], [ ".env" ]);
    const plain = await call(f.agent, "gitCloneStack", { ...input,
        name: "fixture-plain" });
    assert.deepEqual(plain.notStarted, { key: "gitSavedNeedsEnvFile",
        values: { files: ".env" } });
    assert.equal(plain.envExamples, undefined);
    // A file below the root of the stack is named, but the stack page cannot create it
    pending = new ComposeEnvironmentError([], [ "config/app.env" ], [{ file: "config/app.env",
        example: "config/app.env.example" }]);
    const nested = await call(f.agent, "gitCloneStack", { ...input,
        name: "fixture-nested" });
    assert.equal(nested.envExamples, undefined);
    // The error itself still says what is missing
    assert.equal(new ComposeEnvironmentError([], [ ".env" ]).message, "gitComposeNeedsEnvFile");
});

test("an update that needs variables or an env file writes the chosen files and does not start them", async (t) => {
    // Refusing the whole apply left the page with nothing to do but check again, and the
    // user in a loop: the variables are set in the very files this apply writes
    const f = await handler(t);
    t.mock.method(StackConfig, "inventory", async () => ({ config: { composeFileName: "compose.yaml",
        envFileNames: [],
        activeEnvFileName: "",
        secretBindings: [] } }));
    let pending = new ComposeEnvironmentError([ "APP_TOKEN" ]);
    const apply = t.mock.method(StackGitWorkflow.prototype, "apply", async () => ({ filesHash: "fixture-hash",
        pending }));
    const getStack = t.mock.method(Stack, "getStack", async () => {
        throw new Error("must not deploy");
    });
    const payload = { stackName: "fixture",
        previewId: "fixture-preview",
        choices: {},
        deploy: true };
    const response = await call(f.agent, "gitApplyUpdate", payload);
    assert.equal(response.ok, true);
    assert.equal(response.saved, true);
    assert.equal(response.deployed, false);
    assert.equal(apply.mock.callCount(), 1);
    assert.equal(getStack.mock.callCount(), 0);
    assert.deepEqual(response.notStarted, { key: "gitSavedNeedsVariables",
        values: { variables: "APP_TOKEN" } });
    pending = new ComposeEnvironmentError([], [ ".env" ], [{ file: ".env",
        example: ".env.example" }]);
    const envFile = await call(f.agent, "gitApplyUpdate", { ...payload,
        deploy: false });
    assert.equal(envFile.deployed, false);
    assert.deepEqual(envFile.envExamples, [{ file: ".env",
        example: ".env.example" }]);
    assert.equal(getStack.mock.callCount(), 0);
});

test("only the name of a missing env file inside the checkout is read out of Compose output", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-env-file-"));
    const link = `${dir}-link`;
    await fs.symlink(dir, link);
    t.after(async () => {
        await fs.rm(link, { force: true });
        await fs.rm(dir, { recursive: true,
            force: true });
    });
    const missing = (file: string) => ({ stderr: `env file ${file} not found: stat ${file}: no such file or directory` });
    assert.deepEqual(await missingEnvFiles(missing(`${dir}/.env`), dir), [ ".env" ]);
    assert.deepEqual(await missingEnvFiles(missing(`${dir}/config/app.env`), dir), [ "config/app.env" ]);
    // Compose may print the directory with its symlinks resolved
    assert.deepEqual(await missingEnvFiles(missing(`${dir}/.env`), link), [ ".env" ]);
    // The file passed with --env-file is reported in other words
    assert.deepEqual(await missingEnvFiles({ stderr: `couldn't find env file: ${dir}/.env\n` }, dir), [ ".env" ]);
    // A file outside the checkout names a path of the server, so it is not reported
    assert.deepEqual(await missingEnvFiles(missing("/etc/app/.env"), dir), []);
    assert.deepEqual(await missingEnvFiles(missing(`${dir}/../other/.env`), dir), []);
    assert.deepEqual(await missingEnvFiles({ stderr: "yaml: line 3: mapping values are not allowed" }, dir), []);
    assert.deepEqual(await missingEnvFiles({}, dir), []);
});

test("a stack name longer than the limit is refused before anything is cloned", async (t) => {
    const f = await handler(t);
    const clone = t.mock.method(StackGitWorkflow.prototype, "clone", async () => ({ filesHash: "" }));
    const response = await call(f.agent, "gitCloneStack", { ...input,
        name: "a".repeat(65) });
    assert.equal(response.ok, false);
    assert.equal(clone.mock.callCount(), 0);
    // The accepted length still goes through
    const accepted = await call(f.agent, "gitCloneStack", { ...input,
        name: "a".repeat(64) });
    assert.equal(accepted.ok, true);
});

test("only variable names are read out of Compose output, never the rest of it", () => {
    const stderr = [
        "error while interpolating services.bot.environment.TELEGRAM_API_HASH: required variable TELEGRAM_API_HASH is missing a value: set it to s3cr3t-from-the-old-file",
        "error while interpolating services.bot.environment.TELEGRAM_API_ID: required variable TELEGRAM_API_ID is missing a value",
    ].join("\n");
    const names = missingVariables({ stderr });
    assert.deepEqual(names, [ "TELEGRAM_API_HASH", "TELEGRAM_API_ID" ]);
    // The sentence around the name carries whatever the compose file put there
    assert.equal(names.join(" ").includes("s3cr3t"), false);

    // A failure that is not about variables stays unrecognised, so the files are refused
    assert.deepEqual(missingVariables({ stderr: "yaml: line 3: mapping values are not allowed" }), []);
    assert.deepEqual(missingVariables({}), []);
    assert.deepEqual(missingVariables(new Error("no stderr at all")), []);

    // A long list is cut, and each name is reported once however often Compose repeats it
    const many = Array.from({ length: 30 }, (_, i) => `required variable VAR_${i} is missing a value`).join("\n");
    assert.equal(missingVariables({ stderr: many }).length, 12);
    assert.deepEqual(missingVariables({ stderr: [ "required variable SAME is missing a value", "required variable SAME is missing a value" ].join("\n") }), [ "SAME" ]);
});

test("the reason of a refusal reaches the server log without what an address carries", () => {
    const reason = logSafeReason({ stderr: "failed to resolve https://deploy:ghp_token@git.example.com/app.git and ssh://key@host/x\n" });
    assert.equal(reason, "failed to resolve https://***@git.example.com/app.git and ssh://***@host/x");
    assert.equal(logSafeReason(new Error("pull access denied for app")), "pull access denied for app");
    assert.equal(logSafeReason({ stderr: "x".repeat(5000) }).length, 2000);
});

test("invalid requests and unauthenticated sockets cannot start Git operations", async (t) => {
    const f = await handler(t);
    const clone = t.mock.method(StackGitWorkflow.prototype, "clone", async () => undefined);
    for (const invalid of [ null, {}, { ...input,
        deploy: "true" }, { ...input,
        envFiles: "bad" }]) {
        assert.equal((await call(f.agent, "gitCloneStack", invalid)).ok, false);
    }
    f.socket.userID = "";
    assert.equal((await call(f.agent, "gitCloneStack", input)).ok, false);
    assert.equal(clone.mock.callCount(), 0);
});

test("the central role gate reserves all Git content and mutations for trusted operators", () => {
    for (const event of [ "gitCloneStack", "gitListBranches", "gitPreviewUpdate", "gitApplyUpdate", "createEnvFromExample" ]) {
        assert.equal(roleAllowsEvent("viewer", event, true), false);
        assert.equal(roleAllowsEvent("operator", event, true), true);
        assert.equal(roleAllowsEvent("admin", event, true), true);
    }
});

test("listing branches reaches the remote only for a signed-in caller with a usable address", async (t) => {
    const f = await handler(t);
    const listBranches = t.mock.method(StackGitWorkflow.prototype, "listBranches", async () => [ "main", "develop" ]);

    const response = await call(f.agent, "gitListBranches", "  https://example.invalid/repo.git  ");
    assert.equal(response.ok, true);
    assert.deepEqual(response.branches, [ "main", "develop" ]);
    assert.deepEqual(listBranches.mock.calls[0]?.arguments, [ "https://example.invalid/repo.git" ]);

    for (const invalid of [ null, 42, "", "   " ]) {
        assert.equal((await call(f.agent, "gitListBranches", invalid)).ok, false);
    }
    f.socket.userID = "";
    assert.equal((await call(f.agent, "gitListBranches", "https://example.invalid/repo.git")).ok, false);
    assert.equal(listBranches.mock.callCount(), 1);
});
