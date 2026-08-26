import { strict as assert } from "node:assert";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "../../backend/child-process";
import { Stack } from "../../backend/stack";
import { RUNNING } from "../../common/util-common";

const enabled = process.env.DOCKGE_DOCKER_INTEGRATION === "1";
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "clean-exit-stack.compose.yaml");

/**
 * Run a docker command with an argument array and a generous timeout
 * @param args Docker arguments
 * @returns Exit code of the command
 */
async function docker(args : readonly string[]) : Promise<number | null> {
    const res = await spawn("docker", args, {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeoutMs: 180_000,
    });
    return res.code;
}

test("a stack with a clean-exit init container is reported as running", {
    skip: enabled ? false : "set DOCKGE_DOCKER_INTEGRATION=1 and provide a working Docker Compose to run this test",
}, async () => {
    // The project name must not collide with stacks of the machine running the test
    const project = `dockge-it-${process.pid}`;

    try {
        assert.equal(await docker([ "compose", "-p", project, "-f", fixture, "up", "-d" ]), 0);

        const statusList = await Stack.getStatusList();
        assert.equal(statusList.get(project), RUNNING);
    } finally {
        assert.equal(await docker([ "compose", "-p", project, "-f", fixture, "down", "-v" ]), 0);
    }
});
