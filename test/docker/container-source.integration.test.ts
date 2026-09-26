import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import { controlContainer, inspectContainer } from "../../backend/container-source";
import { readHostContainers } from "../../backend/stack-state";

const enabled = process.env.DOCKGE_DOCKER_INTEGRATION === "1";
const IMAGE = "alpine:3.20";

/**
 * Run docker and return what it printed
 * @param args Docker arguments
 * @returns Standard output, trimmed
 */
async function docker(args : readonly string[]) : Promise<string> {
    try {
        const res = await spawn("docker", args, { encoding: "utf-8",
            maxBuffer: 1024 * 1024,
            timeoutMs: 180_000 });
        return String(res.stdout ?? "").trim();
    } catch (error) {
        const failure = error as Error & { stderr? : string | Buffer };
        throw new Error(`docker ${args.join(" ")}: ${failure.message}\n${failure.stderr ?? ""}`, { cause: error });
    }
}

/**
 * State of one container, read by its id
 * @param id Container id
 * @returns Docker state
 */
async function stateOf(id : string) : Promise<string> {
    return docker([ "inspect", "--format", "{{.State.Status}}", id ]);
}

test("a compose project outside the stacks directory and a standalone container are told apart and controlled by id", {
    skip: enabled ? false : "set DOCKGE_DOCKER_INTEGRATION=1 and provide a working Docker Compose to run this test",
}, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dockge-outside-"));
    const stacksDir = path.join(root, "stacks");
    const projectDir = path.join(root, "elsewhere");
    // Names carry the process id, so nothing of the machine running the test is touched
    const project = `dockge-it-outside-${process.pid}`;
    const standaloneName = `dockge-it-standalone-${process.pid}`;
    const compose = path.join(projectDir, "compose.yaml");

    await mkdir(stacksDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(compose, `services:\n  sleeper:\n    image: ${IMAGE}\n    command: ["sleep", "600"]\n    init: true\n`);

    try {
        await docker([ "compose", "-p", project, "-f", compose, "up", "-d", "--wait" ]);
        const standaloneId = await docker([ "run", "-d", "--init", "--name", standaloneName, IMAGE, "sleep", "600" ]);
        const projectId = await docker([ "compose", "-p", project, "-f", compose, "ps", "--quiet", "sleeper" ]);

        const host = await readHostContainers(1234);
        assert.ok(host, "Docker answered");
        assert.ok(host.instances.get(project)?.some((entry) => entry.Service === "sleeper"), "the project is found by its name");
        assert.ok(host.instances.get(projectDir)?.length, "and by its directory");
        const row = host.standalone.find((item) => item.id === standaloneId);
        assert.deepEqual(row && { name: row.name,
            source: row.source,
            state: row.state,
            lastSeen: row.lastSeen }, { name: standaloneName,
            source: "standalone",
            state: "running",
            lastSeen: 1234 });
        assert.ok(!host.standalone.some((item) => item.id === projectId), "a compose container is not standalone");

        const external = await inspectContainer(projectId, stacksDir);
        assert.equal(external.source, "external-compose");
        assert.equal(external.workingDir, projectDir);
        assert.equal(external.panel, false);
        assert.equal((await inspectContainer(standaloneId, stacksDir)).source, "standalone");
        // The same project started from the stacks directory would be a stack of this panel
        assert.equal((await inspectContainer(projectId, root)).source, "managed");
        await assert.rejects(controlContainer(projectId, "stop", root), /containerNotControllable/);

        await controlContainer(standaloneId, "stop", stacksDir);
        assert.equal(await stateOf(standaloneId), "exited");
        await controlContainer(standaloneId, "start", stacksDir);
        assert.equal(await stateOf(standaloneId), "running");
        await controlContainer(projectId, "restart", stacksDir);
        assert.equal(await stateOf(projectId), "running");
    } finally {
        await docker([ "rm", "-f", standaloneName ]).catch(() => "");
        await docker([ "compose", "-p", project, "-f", compose, "down", "-v", "--timeout", "1" ]);
        await rm(root, { recursive: true,
            force: true });
    }
});
