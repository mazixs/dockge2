import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import type { DockgeServer } from "../../backend/dockge-server";
import { Stack } from "../../backend/stack";
import { readStackContainerIds } from "../../backend/stack-delete";
import type { DockgeSocket } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

const socket = { id: "delete-test",
    endpoint: "",
    connected: true,
    emitAgent: () => undefined } as unknown as DockgeSocket;

/** Run Docker only against the uniquely named resources created below. */
async function docker(...args : string[]) : Promise<string> {
    const result = await spawn("docker", args, { encoding: "utf8",
        timeoutMs: 120_000 });
    return String(result.stdout ?? "").trim();
}

test("delete recovers unconfigured Git stacks and deployed stacks with broken Compose", {
    skip: process.env.DOCKGE_DOCKER_INTEGRATION !== "1",
}, async () => {
    await withDatabase(async ({ stacksDir }) => {
        const server = { stacksDir } as DockgeServer;
        const prefix = `dockge-it-delete-${process.pid}`;
        for (const [ index, compose ] of [
            "services:\n  app:\n    image: ${DOCKGE_DELETE_MISSING:?required}\n",
            "name: 'INVALID NAME!'\nservices:\n  app:\n    image: bash:5.2\n",
            "services: [broken yaml\n",
            "services:\n  app:\n    image: bash:5.2\n    env_file: missing.env\n",
        ].entries()) {
            const name = `${prefix}-${index}`;
            const directory = path.join(stacksDir, name);
            await mkdir(directory);
            execFileSync("git", [ "init", directory ], { stdio: "ignore" });
            await writeFile(path.join(directory, "compose.yaml"), compose);
            const stack = await Stack.getStack(server, name);
            assert.equal(await stack.delete(socket), 0);
            await assert.rejects(access(directory));
        }

        const name = `${prefix}-deployed`;
        const directory = path.join(stacksDir, name);
        const foreignDirectory = path.join(stacksDir, `${prefix}-foreign`);
        const volume = `${prefix}-data`;
        const foreign = `${prefix}-foreign`;
        await mkdir(directory);
        const compose = `name: ${prefix}-custom
services:
  app:
    image: bash:5.2
    command: ["sleep", "600"]
    volumes: ["data:/data"]
volumes:
  data:
    name: ${volume}
`;
        const composeFile = path.join(directory, "compose.yaml");
        await writeFile(composeFile, compose);
        try {
            await docker("compose", "-f", composeFile, "up", "-d", "--wait");
            // The same project label must not grant ownership of a different directory.
            await docker("run", "-d", "--name", foreign,
                "--label", `com.docker.compose.project=${prefix}-custom`,
                "--label", `com.docker.compose.project.working_dir=${foreignDirectory}`,
                "bash:5.2", "sleep", "600");
            const ids = await readStackContainerIds(directory);
            assert.equal(ids.length, 1);
            await writeFile(composeFile, "name: 'invalid name!'\nservices: {}\n");
            const stack = await Stack.getStack(server, name);
            assert.equal(await stack.delete(socket), 0);
            await assert.rejects(access(directory));
            await assert.rejects(docker("inspect", ids[0]!));
            assert.equal(await docker("inspect", "--format", "{{.State.Running}}", foreign), "true");
            assert.equal(await docker("volume", "inspect", "--format", "{{.Name}}", volume), volume);
        } finally {
            await docker("rm", "-f", foreign).catch(() => undefined);
            await mkdir(directory, { recursive: true });
            await writeFile(composeFile, compose);
            await docker("compose", "-f", composeFile, "down", "--volumes");
            await rm(directory, { recursive: true,
                force: true });
        }
    });
});
