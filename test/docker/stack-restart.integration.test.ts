import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import type { DockgeServer } from "../../backend/dockge-server";
import { Stack } from "../../backend/stack";
import type { DockgeSocket } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

test("restart applies selected env files, service operations preserve siblings and source bytes", {
    skip: process.env.DOCKGE_DOCKER_INTEGRATION !== "1",
}, async () => {
    await withDatabase(async () => {
        const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-it-restart-"));
        const name = `dockge-it-restart-${process.pid}`;
        const directory = path.join(stacksDir, name);
        await mkdir(directory);
        const compose = `# Preserve this file exactly.
services:
  app:
    image: bash:5.2
    command: ["sleep", "600"]
    environment:
      TEST_VALUE: \${TEST_VALUE}
    depends_on: [sibling]
  sibling:
    image: bash:5.2
    command: ["sleep", "600"]
`;
        await writeFile(path.join(directory, "selected.yml"), compose);
        await writeFile(path.join(directory, ".env.selected"), "TEST_VALUE=before\n");
        const server = { stacksDir } as DockgeServer;
        let stack = await Stack.getStack(server, name);
        await stack.setFileConfig({
            composeFileName: "selected.yml",
            envFileNames: [ ".env.selected" ],
            activeEnvFileName: ".env.selected",
            secretBindings: [],
        });
        stack = await Stack.getStack(server, name);
        const socket = { id: "restart-test",
            endpoint: "",
            connected: true,
            emitAgent: () => undefined } as unknown as DockgeSocket;
        const docker = async (command: string, ...args: string[]) => {
            const result = await spawn("docker", stack.getComposeOptions(command, ...args), {
                cwd: directory,
                encoding: "utf8",
                timeoutMs: 180_000,
            });
            return String(result.stdout).trim();
        };
        try {
            await docker("up", "-d", "--wait");
            const sibling = await docker("ps", "-q", "sibling");
            const original = await docker("ps", "-q", "app");
            await writeFile(path.join(directory, ".env.selected"), "TEST_VALUE=service\n");
            await stack.restartService(socket, "app");
            assert.equal(await docker("exec", "-T", "app", "printenv", "TEST_VALUE"), "service");
            assert.notEqual(await docker("ps", "-q", "app"), original);
            assert.equal(await docker("ps", "-q", "sibling"), sibling);

            await writeFile(path.join(directory, ".env.selected"), "TEST_VALUE=stack\n");
            await stack.restart(socket);
            assert.equal(await docker("exec", "-T", "app", "printenv", "TEST_VALUE"), "stack");
            const siblingAfterRestart = await docker("ps", "-q", "sibling");
            const beforeUpdate = await docker("ps", "-q", "app");
            await stack.updateService(socket, "app");
            assert.notEqual(await docker("ps", "-q", "app"), beforeUpdate);
            assert.equal(await docker("ps", "-q", "sibling"), siblingAfterRestart);
            await assert.rejects(stack.updateService(socket, "--all"), /Unknown service/);
            assert.equal(await readFile(path.join(directory, "selected.yml"), "utf8"), compose);
            assert.equal(await readFile(path.join(directory, ".env.selected"), "utf8"), "TEST_VALUE=stack\n");
        } finally {
            await docker("down");
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});
