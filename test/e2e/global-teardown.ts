import { spawn } from "node:child_process";

/**
 * Stop the containers the e2e run started.
 *
 * Without this the projects keep running on the machine after the suite, and the
 * `sleep 900` command of the fixtures turns into a container that dies mid-run later on.
 */
export default function globalTeardown() : Promise<void> {
    return new Promise((resolve) => {
        const child = spawn("./node_modules/.bin/tsx", [ "test/e2e/teardown.ts" ], {
            stdio: "inherit",
        });

        // A failed cleanup must not fail the suite, it only leaves containers behind
        child.on("error", () => resolve());
        child.on("close", () => resolve());
    });
}
