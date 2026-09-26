import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "../../backend/child-process";
import { E2E_ATTENTION_STACK, E2E_FILES_STACK, E2E_PROGRESS_STACK, E2E_STACK_NAME, E2E_STANDALONE_CONTAINER } from "./constants";

/**
 * Stop every compose project the run started.
 *
 * By project name, without a compose file: the files spec switches its stack to another
 * compose file, and a `down` against the first one would leave the container running.
 * The working directory is empty, so Compose finds no file of its own there either.
 */
async function teardown() : Promise<void> {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "dockge-e2e-teardown-"));

    try {
        for (const stack of [ E2E_STACK_NAME, E2E_ATTENTION_STACK, E2E_FILES_STACK, E2E_PROGRESS_STACK ]) {
            try {
                await spawn("docker", [ "compose", "-p", stack, "down", "-v" ], {
                    cwd,
                    encoding: "utf-8",
                    maxBuffer: 4 * 1024 * 1024,
                    timeoutMs: 300_000,
                });
            } catch (e) {
                console.warn(`Could not stop ${stack}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        // A spec that failed halfway may leave its standalone container behind
        await spawn("docker", [ "rm", "-f", E2E_STANDALONE_CONTAINER ], { encoding: "utf-8",
            maxBuffer: 1024 * 1024,
            timeoutMs: 60_000 }).catch(() => undefined);
    } finally {
        await rm(cwd, { recursive: true,
            force: true });
    }
}

await teardown();
console.log("e2e containers stopped");
