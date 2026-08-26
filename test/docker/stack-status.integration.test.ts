import { strict as assert } from "node:assert";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "../../backend/child-process";
import { Stack } from "../../backend/stack";
import { ATTENTION, RUNNING } from "../../common/util-common";

const enabled = process.env.DOCKGE_DOCKER_INTEGRATION === "1";
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const markedFixture = path.join(fixtureDir, "clean-exit-stack.compose.yaml");
const unmarkedFixture = path.join(fixtureDir, "unmarked-exit-stack.compose.yaml");

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

test("a stack with a marked one-shot container is reported as running", {
    skip: enabled ? false : "set DOCKGE_DOCKER_INTEGRATION=1 and provide a working Docker Compose to run this test",
}, async () => {
    // The project name must not collide with stacks of the machine running the test
    const project = `dockge-it-marked-${process.pid}`;

    try {
        assert.equal(await docker([ "compose", "-p", project, "-f", markedFixture, "up", "-d" ]), 0);

        // Block until the one-shot container really exited, otherwise the check races with Docker
        assert.equal(await docker([ "compose", "-p", project, "-f", markedFixture, "wait", "init" ]), 0);

        const statusList = await Stack.getStatusList();
        assert.equal(statusList.get(project), RUNNING);
    } finally {
        assert.equal(await docker([ "compose", "-p", project, "-f", markedFixture, "down", "-v" ]), 0);
    }
});

test("an unmarked container that exited needs attention instead of looking stopped", {
    skip: enabled ? false : "set DOCKGE_DOCKER_INTEGRATION=1 and provide a working Docker Compose to run this test",
}, async () => {
    const project = `dockge-it-unmarked-${process.pid}`;

    try {
        assert.equal(await docker([ "compose", "-p", project, "-f", unmarkedFixture, "up", "-d" ]), 0);
        assert.equal(await docker([ "compose", "-p", project, "-f", unmarkedFixture, "wait", "init" ]), 0);

        const statusList = await Stack.getStatusList();

        // Issue #806: the running service must not be hidden behind a stopped one-shot container
        assert.equal(statusList.get(project), ATTENTION);
    } finally {
        assert.equal(await docker([ "compose", "-p", project, "-f", unmarkedFixture, "down", "-v" ]), 0);
    }
});
