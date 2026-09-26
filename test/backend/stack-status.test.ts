import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { readOwnProjectName, resolveProjectStatus } from "../../backend/stack-state";
import { findOwnContainerId } from "../../backend/own-container";
import type { ComposePsEntry } from "../../common/compose-status";
import { ATTENTION, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../../common/util-common";

const project = "demo";

/**
 * Build the host wide container map the way readHostContainers() groups it
 * @param entries Containers of the demo project
 * @returns Instance map
 */
function instanceMap(entries : ComposePsEntry[]) : Map<string, ComposePsEntry[]> {
    return new Map([[ project, entries ]]);
}

test("project status comes from container states, not from the aggregated compose line", () => {
    // Issue #806: a clean-exit worker next to a running service is not a stopped stack
    const withWorker = resolveProjectStatus({ Name: project,
        Status: "exited(1), running(1)" }, instanceMap([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 5 minutes" },
        { Service: "init",
            Name: "demo-init-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 5 minutes ago" },
    ]));
    assert.equal(withWorker.status, ATTENTION);
    assert.equal(withWorker.issues[0]?.reason, "serviceStopped");

    // Marking the worker as one-shot makes the same stack healthy
    const markedWorker = resolveProjectStatus({ Name: project,
        Status: "exited(1), running(1)" }, instanceMap([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 5 minutes" },
        { Service: "init",
            Name: "demo-init-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 5 minutes ago",
            Labels: "com.docker.compose.project=demo,com.docker.compose.service=init,dockge.lifecycle=one-shot" },
    ]));
    assert.equal(markedWorker.status, RUNNING);
    assert.deepEqual(markedWorker.issues, []);

    // A failed worker is reported with its exit code
    const failedWorker = resolveProjectStatus({ Name: project,
        Status: "exited(1), running(1)" }, instanceMap([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 5 minutes" },
        { Service: "init",
            Name: "demo-init-1",
            State: "exited",
            ExitCode: 3,
            Status: "Exited (3) 5 minutes ago",
            Labels: "com.docker.compose.project=demo,com.docker.compose.service=init,dockge.lifecycle=one-shot" },
    ]));
    assert.equal(failedWorker.status, ATTENTION);
    assert.deepEqual(failedWorker.issues, [
        { service: "init",
            name: "demo-init-1",
            reason: "workerFailed",
            detail: "3" },
    ]);
});

test("project status stays fail-closed when Docker output is missing", () => {
    // Docker could not be read at all
    assert.equal(resolveProjectStatus({ Name: project,
        Status: "running(1)" }, null).status, UNKNOWN);

    // The project has no container, so nothing can be claimed about it
    assert.equal(resolveProjectStatus({ Name: project,
        Status: "running(1)" }, new Map()).status, UNKNOWN);

    // An unreadable state is never promoted to running
    assert.equal(resolveProjectStatus({ Name: project,
        Status: "running(1)" }, instanceMap([
        { Service: "app",
            Name: "demo-app-1",
            State: "" },
    ])).status, ATTENTION);
});

test("stopped and created projects keep their own status", () => {
    assert.equal(resolveProjectStatus({ Name: project,
        Status: "exited(2)" }, instanceMap([
        { Service: "app",
            Name: "demo-app-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 1 hour ago" },
        { Service: "db",
            Name: "demo-db-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 1 hour ago" },
    ])).status, EXITED);

    assert.equal(resolveProjectStatus({ Name: project,
        Status: "created(1)" }, instanceMap([
        { Service: "app",
            Name: "demo-app-1",
            State: "created",
            Status: "Created" },
    ])).status, CREATED_STACK);
});

test("a stack whose compose project was renamed is still matched by its directory", () => {
    const stackDir = "/opt/stacks/demo";

    // The containers carry a different project name, set through COMPOSE_PROJECT_NAME
    const entries = [
        { Service: "app",
            Name: "renamed-app-1",
            State: "running",
            Status: "Up 5 minutes",
            Labels: `com.docker.compose.project=renamed,com.docker.compose.service=app,com.docker.compose.project.working_dir=${stackDir}` },
    ];

    const map = new Map([[ "renamed", entries ], [ stackDir, entries ]]);
    const stack = { isManagedByDockge: true,
        path: stackDir,
        composeYAML: "services:\n  app:\n    image: nginx\n" };

    // Looked up by the stack directory, the status is correct
    const matched = resolveProjectStatus({ Name: "demo",
        Status: "running(1)" }, map, stack);
    assert.equal(matched.status, RUNNING);

    // Without the directory index the project name of the stack finds nothing
    const nameOnly = resolveProjectStatus({ Name: "demo",
        Status: "running(1)" }, new Map([[ "renamed", entries ]]));
    assert.equal(nameOnly.status, UNKNOWN);
});

test("asking which project the panel runs as never throws, and is asked once", async () => {
    // Deliberately not asserting a value: these tests run on a development machine, in
    // CI, and inside the container ./local.sh builds, and the honest answer differs in
    // each. What must hold everywhere is that the question is safe to ask and settles
    const first = await readOwnProjectName();
    const second = await readOwnProjectName();

    assert.equal(typeof first, "string");
    assert.equal(second, first, "the answer is cached, not asked again");

    // Outside a container there is no own project, and nothing is hidden from the list
    if (!findOwnContainerId(await readFile("/proc/self/mountinfo", "utf8").catch(() => ""), os.hostname())) {
        assert.equal(first, "");
    }
});
