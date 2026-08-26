import { strict as assert } from "node:assert";
import test from "node:test";
import { Stack } from "../../backend/stack";
import type { ComposePsEntry } from "../../common/compose-status";
import { ATTENTION, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../../common/util-common";

const project = "demo";

/**
 * Build the host wide container map the way Stack.getInstanceMap() returns it
 * @param entries Containers of the demo project
 * @returns Instance map
 */
function instanceMap(entries : ComposePsEntry[]) : Map<string, ComposePsEntry[]> {
    return new Map([[ project, entries ]]);
}

test("project status comes from container states, not from the aggregated compose line", () => {
    // Issue #806: a clean-exit worker next to a running service is not a stopped stack
    const withWorker = Stack.resolveProjectStatus({ Name: project,
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
    const markedWorker = Stack.resolveProjectStatus({ Name: project,
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
    const failedWorker = Stack.resolveProjectStatus({ Name: project,
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
    assert.equal(Stack.resolveProjectStatus({ Name: project,
        Status: "running(1)" }, null).status, UNKNOWN);

    // The project has no container, so nothing can be claimed about it
    assert.equal(Stack.resolveProjectStatus({ Name: project,
        Status: "running(1)" }, new Map()).status, UNKNOWN);

    // An unreadable state is never promoted to running
    assert.equal(Stack.resolveProjectStatus({ Name: project,
        Status: "running(1)" }, instanceMap([
        { Service: "app",
            Name: "demo-app-1",
            State: "" },
    ])).status, ATTENTION);
});

test("stopped and created projects keep their own status", () => {
    assert.equal(Stack.resolveProjectStatus({ Name: project,
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

    assert.equal(Stack.resolveProjectStatus({ Name: project,
        Status: "created(1)" }, instanceMap([
        { Service: "app",
            Name: "demo-app-1",
            State: "created",
            Status: "Created" },
    ])).status, CREATED_STACK);
});
