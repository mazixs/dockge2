import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import { OperationError } from "../../backend/operation-error";
import { Stack } from "../../backend/stack";
import type { DockgeServer } from "../../backend/dockge-server";
import type { DockgeSocket } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

test("real Docker update failures distinguish pull from build and preserve the running container", {
    skip: process.env.DOCKGE_DOCKER_INTEGRATION !== "1",
}, async () => {
    await withDatabase(async () => {
        const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-it-update-errors-"));
        const name = `dockge-it-update-errors-${process.pid}`;
        const directory = path.join(stacksDir, name);
        await mkdir(directory);
        const file = path.join(directory, "compose.yaml");
        const original = "services:\n  app:\n    image: bash:5.2\n    command: [sleep, '600']\n";
        await writeFile(file, original);
        const server = { stacksDir } as DockgeServer;
        const socket = { id: "update-errors-test",
            endpoint: "",
            connected: true,
            emitAgent: () => undefined } as unknown as DockgeSocket;
        const docker = async (...args : string[]) => String((await spawn("docker", [ "compose", "-p", name, "-f", file, ...args ], {
            cwd: directory,
            encoding: "utf8",
            timeoutMs: 180_000,
        })).stdout).trim();
        try {
            await docker("up", "-d", "--wait");
            const container = await docker("ps", "-q", "app");
            assert.ok(container);
            for (const phase of [ "pull", "build" ]) {
                const compose = phase === "pull"
                    ? "services:\n  app:\n    image: 127.0.0.1:1/unavailable:fixture\n"
                    : `services:\n  app:\n    image: ${name}:fixture\n    build: .\n`;
                await writeFile(file, compose);
                // A deterministic build failure, without pulling a base image.
                await writeFile(path.join(directory, "Dockerfile"), "FROM scratch\nCOPY nonexistent-fixture-input /required\n");
                const stack = await Stack.getStack(server, name);
                for (const update of [ () => stack.update(socket), () => stack.updateService(socket, "app") ]) {
                    await assert.rejects(update(), (error : unknown) => error instanceof OperationError && error.code === phase);
                    assert.equal(await docker("ps", "-q", "app"), container);
                    assert.equal(await readFile(file, "utf8"), compose);
                }
            }
        } finally {
            await docker("down");
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});
