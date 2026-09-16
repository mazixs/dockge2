import path from "node:path";
import { spawn } from "../../backend/child-process";
import { E2E_ATTENTION_STACK, E2E_FILES_STACK, E2E_STACK_NAME } from "./constants";

const stacksDir = process.env.DOCKGE_E2E_STACKS_DIR ?? "/tmp/dockge-e2e/stacks";

/**
 * Stop every compose project the run started.
 * The files stack is not started by the seed, but the progress spec starts it.
 */
async function teardown() : Promise<void> {
    for (const stack of [ E2E_STACK_NAME, E2E_ATTENTION_STACK, E2E_FILES_STACK ]) {
        try {
            await spawn("docker", [
                "compose", "-p", stack, "-f", path.join(stacksDir, stack, "compose.yaml"), "down", "-v",
            ], {
                encoding: "utf-8",
                maxBuffer: 4 * 1024 * 1024,
                timeoutMs: 300_000,
            });
        } catch (e) {
            console.warn(`Could not stop ${stack}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

await teardown();
console.log("e2e containers stopped");
