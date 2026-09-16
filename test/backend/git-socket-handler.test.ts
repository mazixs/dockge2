import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentSocket } from "../../common/agent-socket";
import { GitSocketHandler } from "../../backend/agent-socket-handlers/git-socket-handler";
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
    assert.match(String(response.deploymentError), /Файлы сохранены/);
    assert.ok(!JSON.stringify(response).includes("must-not-leak"));
});

test("metadata failure never launches a stack with a different file selection", async (t) => {
    const f = await handler(t);
    t.mock.method(StackGitWorkflow.prototype, "clone", async (dir: string) => {
        await fs.mkdir(dir);
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
    assert.match(String(response.deploymentError), /выбор файлов не записан/);
    assert.equal(getStack.mock.callCount(), 0);
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
    for (const event of [ "gitCloneStack", "gitListBranches", "gitPreviewUpdate", "gitApplyUpdate" ]) {
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
