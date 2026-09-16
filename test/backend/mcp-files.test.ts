import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readMcpFile, writeMcpFile } from "../../backend/mcp-files-git";

test("MCP file writes preserve exact text, compare hashes and reject symlinks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dockge-mcp-file-"));
    try {
        const original = "# Comment\r\nservices:\r\n  app: &app\r\n    image: 'example:test'\r\n";
        await writeFile(path.join(directory, "compose.yaml"), original);
        const file = await readMcpFile(directory, "compose.yaml");
        assert.equal(file.content, original);
        await writeMcpFile(directory, "compose.yaml", file.hash, original);
        assert.equal(await readFile(path.join(directory, "compose.yaml"), "utf8"), original);
        await assert.rejects(writeMcpFile(directory, "compose.yaml", "a".repeat(64), "services: {}\n"));
        assert.equal(await readFile(path.join(directory, "compose.yaml"), "utf8"), original);
        const changed = original.replace("example:test", "example:next");
        await writeMcpFile(directory, "compose.yaml", file.hash, changed);
        assert.equal(await readFile(path.join(directory, "compose.yaml"), "utf8"), changed);
        await symlink("compose.yaml", path.join(directory, ".env"));
        await assert.rejects(readMcpFile(directory, ".env"));
        await assert.rejects(writeMcpFile(directory, ".env", file.hash, ""));
        await assert.rejects(readMcpFile(directory, "../compose.yaml"));
        await assert.rejects(readMcpFile(directory, "secrets.txt"));
    } finally {
        await rm(directory, { recursive: true,
            force: true });
    }
});

import { withDatabase, createTestAccount } from "../helpers/database";
import { Database } from "../../backend/database";
import { McpKeys, synchronizeStackIdentities } from "../../backend/mcp-keys";
import { McpOperations } from "../../backend/mcp-operations";
import { registerMcpFilesGit } from "../../backend/mcp-files-git";
import { mkdir } from "node:fs/promises";
import type { DockgeServer } from "../../backend/dockge-server";
import { getStackGitWorkflow } from "../../backend/agent-socket-handlers/git-socket-handler";

test("file operation review is owner-only, apply is exact and hidden approval is denied", async () => {
    await withDatabase(async ({ stacksDir }) => {
        await createTestAccount();
        const server = { stacksDir,
            config: { stacksDir } } as DockgeServer;
        const directory = path.join(stacksDir, "demo");
        await mkdir(directory);
        const before = "# exact\nservices:\n  app:\n    image: 'busybox:latest'\n";
        await writeFile(path.join(directory, "compose.yaml"), before);
        await writeFile(path.join(directory, ".env"), "SECRET=hidden\n");
        const [ stack ] = await synchronizeStackIdentities(Database.getKnex(), server);
        assert.ok(stack);
        const owner = await Database.getKnex()("user").first();
        const keys = new McpKeys(Database.getKnex());
        const key = await keys.issue({ name: "operator",
            userId: owner.id,
            role: "operator",
            actions: [ "files:write", "files:read" ],
            mode: "approval",
            stacks: [ stack.id ] });
        const identity = await keys.authenticate(key.secret);
        const operations = new McpOperations(Database.getKnex(), id => keys.resolveIdentity(id));
        const files = registerMcpFilesGit(server, operations, id => keys.resolveIdentity(id));
        const read = await files.call(identity, "stack_files_read", { server_id: "local",
            stack_id: stack.id,
            file_name: "compose.yaml" }) as { hash : string };
        const prepared = await operations.call(identity, "operation_prepare", { action: "stack_files_write",
            request_id: "file-change",
            parameters: { server_id: "local",
                stack_id: stack.id,
                file_name: "compose.yaml",
                expected_hash: read.hash,
                content: before + "# preserved\n" } }) as { operation_id : string; parameters_hash : string };
        assert.equal(await readFile(path.join(directory, "compose.yaml"), "utf8"), before);
        assert.ok(!JSON.stringify(prepared).includes("busybox"));
        await assert.rejects(operations.review("not-owner", prepared.operation_id));
        assert.ok(JSON.stringify(await operations.review(owner.id, prepared.operation_id)).includes("# preserved"));
        await assert.rejects(operations.call(identity, "operation_apply", prepared));
        await operations.approve(owner.id, prepared.operation_id);
        await operations.call(identity, "operation_apply", { operation_id: prepared.operation_id,
            parameters_hash: prepared.parameters_hash });
        assert.equal(await readFile(path.join(directory, "compose.yaml"), "utf8"), before + "# preserved\n");
        const env = await readMcpFile(directory, ".env");
        await assert.rejects(operations.call(identity, "operation_prepare", { action: "stack_files_write",
            request_id: "hidden",
            parameters: { server_id: "local",
                stack_id: stack.id,
                file_name: ".env",
                expected_hash: env.hash,
                content: "SECRET=new\n" } }), /mcpApprovalHiddenFile/);
        assert.equal(await readFile(path.join(directory, ".env"), "utf8"), "SECRET=hidden\n");
    });
});

test("Git fetch waits for apply, preview is key-bound and deployment needs its own permission", async (context) => {
    await withDatabase(async ({ stacksDir }) => {
        await createTestAccount();
        const server = { stacksDir,
            config: { stacksDir } } as DockgeServer;
        const directory = path.join(stacksDir, "demo");
        await mkdir(directory);
        await writeFile(path.join(directory, "compose.yaml"), "services: {}\n");
        const [ stack ] = await synchronizeStackIdentities(Database.getKnex(), server);
        assert.ok(stack);
        const owner = await Database.getKnex()("user").first();
        const keys = new McpKeys(Database.getKnex());
        const args = { name: "operator",
            userId: owner.id,
            role: "operator",
            actions: [ "git:read", "git:apply" ],
            mode: "automatic",
            stacks: [ stack.id ] };
        const key = await keys.issue(args);
        const foreignKey = await keys.issue(args);
        const identity = await keys.authenticate(key.secret);
        const foreign = await keys.authenticate(foreignKey.secret);
        const operations = new McpOperations(Database.getKnex(), id => keys.resolveIdentity(id));
        const files = registerMcpFilesGit(server, operations, id => keys.resolveIdentity(id));
        let fetched = 0;
        let applied = 0;
        const workflow = getStackGitWorkflow(server);
        context.mock.method(workflow, "preview", async () => {
            fetched++;
            return { id: "underlying-preview",
                branch: "main",
                currentCommit: "a",
                targetCommit: "b",
                files: [],
                source: { kind: "git",
                    remote: "https://example.test/repo",
                    branch: "main",
                    behind: 1,
                    dirty: false } };
        });
        context.mock.method(workflow, "apply", async () => {
            applied++;
        });
        const prepared = await operations.call(identity, "operation_prepare", { action: "git_preview",
            request_id: "fetch-1",
            parameters: { server_id: "local",
                stack_id: stack.id } }) as { operation_id : string; parameters_hash : string };
        assert.equal(fetched, 0);
        const result = await operations.call(identity, "operation_apply", { operation_id: prepared.operation_id,
            parameters_hash: prepared.parameters_hash }) as { result : { preview_id : string } };
        assert.equal(fetched, 1);
        const parameters = { server_id: "local",
            stack_id: stack.id,
            preview_id: result.result.preview_id };
        await assert.rejects(files.call(foreign, "git_preview_result", parameters));
        assert.ok(await files.call(identity, "git_preview_result", parameters));
        await assert.rejects(operations.call(identity, "operation_prepare", { action: "git_apply",
            request_id: "deploy-denied",
            parameters: { ...parameters,
                choices: {},
                deploy: true } }));
        assert.equal(applied, 0);
        const save = await operations.call(identity, "operation_prepare", { action: "git_apply",
            request_id: "save-1",
            parameters: { ...parameters,
                choices: {},
                deploy: false } }) as { operation_id : string; parameters_hash : string };
        await operations.call(identity, "operation_apply", { operation_id: save.operation_id,
            parameters_hash: save.parameters_hash });
        assert.equal(applied, 1);
        await assert.rejects(files.call(identity, "git_preview_result", parameters));
    });
});

test("file change or replacement during authority revalidation is not overwritten", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dockge-mcp-race-"));
    try {
        const file = path.join(directory, "compose.yaml");
        await writeFile(file, "services: {}\n");
        const original = await readMcpFile(directory, "compose.yaml");
        await assert.rejects(writeMcpFile(directory, "compose.yaml", original.hash, "# proposed\nservices: {}\n", async () => {
            await writeFile(file, "# concurrent\nservices: {}\n");
        }));
        assert.equal(await readFile(file, "utf8"), "# concurrent\nservices: {}\n");
        await writeFile(file, original.content);
        await assert.rejects(writeMcpFile(directory, "compose.yaml", original.hash, "# proposed\nservices: {}\n", async () => {
            await rm(file);
            await writeFile(file, "# replacement\nservices: {}\n");
        }));
        assert.equal(await readFile(file, "utf8"), "# replacement\nservices: {}\n");
    } finally {
        await rm(directory, { recursive: true,
            force: true });
    }
});
