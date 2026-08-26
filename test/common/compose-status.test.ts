import { strict as assert } from "node:assert";
import test from "node:test";
import {
    fromDockerPs,
    normaliseInstance,
    parseDockerLabels,
    readComposeServices,
    readOneShotServices,
    resolveComposePsStatus,
    resolveStackStatus,
} from "../../common/compose-status";
import { ATTENTION, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../../common/util-common";

const oneShotLabels = "com.docker.compose.project=demo,com.docker.compose.service=init,dockge.lifecycle=one-shot";

test("docker labels are parsed into a plain record", () => {
    assert.deepEqual(parseDockerLabels(oneShotLabels), {
        "com.docker.compose.project": "demo",
        "com.docker.compose.service": "init",
        "dockge.lifecycle": "one-shot",
    });
    assert.deepEqual(parseDockerLabels(undefined), {});
    assert.deepEqual(parseDockerLabels(""), {});
    assert.deepEqual(parseDockerLabels("=broken,also-broken"), {});
});

test("instances are normalised without promoting unknown values", () => {
    const running = normaliseInstance({ Service: "app",
        Name: "demo-app-1",
        State: "Running",
        Health: "Healthy",
        Status: "Up 2 minutes (healthy)" });
    assert.equal(running.state, "running");
    assert.equal(running.health, "healthy");
    assert.equal(running.issue, null);
    assert.equal(running.isOneShot, false);

    const worker = normaliseInstance({ Service: "init",
        Name: "demo-init-1",
        State: "exited",
        ExitCode: 0,
        Status: "Exited (0) 1 minute ago",
        Labels: oneShotLabels });
    assert.equal(worker.isOneShot, true);
    assert.equal(worker.exitCode, 0);
    assert.equal(worker.issue, null);

    // The exit code can also come from the status text only
    const legacy = normaliseInstance({ Service: "app",
        Name: "demo-app-1",
        State: "exited",
        Status: "Exited (137) 5 seconds ago" });
    assert.equal(legacy.exitCode, 137);
    assert.equal(legacy.issue, "serviceFailed");

    // An unreadable state is an issue, never a success
    const broken = normaliseInstance({ Service: "app",
        Name: "demo-app-1" });
    assert.equal(broken.state, "");
    assert.equal(broken.issue, "unknownState");

    const exitedWithoutCode = normaliseInstance({ Service: "app",
        Name: "demo-app-1",
        State: "exited",
        Status: "Exited" });
    assert.equal(exitedWithoutCode.exitCode, null);
    assert.equal(exitedWithoutCode.issue, "unknownExitCode");
});

test("a running stack with a clean one-shot worker stays running", () => {
    const result = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 3 minutes" },
        { Service: "init",
            Name: "demo-init-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 3 minutes ago",
            Labels: oneShotLabels },
    ], [ "app", "init" ]);

    assert.equal(result.status, RUNNING);
    assert.deepEqual(result.issues, []);
});

test("partial degradation is attention with the reason, never plain inactive", () => {
    const failedWorker = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 3 minutes" },
        { Service: "init",
            Name: "demo-init-1",
            State: "exited",
            ExitCode: 2,
            Status: "Exited (2) 3 minutes ago",
            Labels: oneShotLabels },
    ]);
    assert.equal(failedWorker.status, ATTENTION);
    assert.deepEqual(failedWorker.issues, [
        { service: "init",
            name: "demo-init-1",
            reason: "workerFailed",
            detail: "2" },
    ]);

    const unhealthy = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Health: "unhealthy",
            Status: "Up 3 minutes (unhealthy)" },
        { Service: "db",
            Name: "demo-db-1",
            State: "running",
            Status: "Up 3 minutes" },
    ]);
    assert.equal(unhealthy.status, ATTENTION);
    assert.equal(unhealthy.issues[0]?.reason, "unhealthy");

    const restarting = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 1 minute" },
        { Service: "db",
            Name: "demo-db-1",
            State: "restarting",
            Status: "Restarting (1) 2 seconds ago" },
    ]);
    assert.equal(restarting.status, ATTENTION);
    assert.equal(restarting.issues[0]?.reason, "restarting");

    // A declared service without any container is a missing instance, not a healthy stack
    const missing = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 1 minute" },
    ], [ "app", "db" ]);
    assert.equal(missing.status, ATTENTION);
    assert.deepEqual(missing.issues, [
        { service: "db",
            name: "",
            reason: "missingInstance" },
    ]);

    // One stopped long-lived replica next to a running one still needs attention
    const mixedReplicas = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 1 minute" },
        { Service: "app",
            Name: "demo-app-2",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 1 minute ago" },
    ]);
    assert.equal(mixedReplicas.status, ATTENTION);
    assert.equal(mixedReplicas.issues[0]?.reason, "serviceStopped");
});

test("stopped, created and unreadable stacks keep their own status", () => {
    const stopped = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 2 hours ago" },
    ]);
    assert.equal(stopped.status, EXITED);

    // A failed exit is still visible as an issue on a stopped stack
    const failed = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "exited",
            ExitCode: 1,
            Status: "Exited (1) 2 hours ago" },
    ]);
    assert.equal(failed.status, EXITED);
    assert.deepEqual(failed.issues, [
        { service: "app",
            name: "demo-app-1",
            reason: "serviceFailed",
            detail: "1" },
    ]);

    const created = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "created",
            Status: "Created" },
    ]);
    assert.equal(created.status, CREATED_STACK);

    // No output at all means Docker could not tell us anything
    assert.equal(resolveComposePsStatus([]).status, UNKNOWN);
    assert.equal(resolveStackStatus([], [ "app" ]).status, UNKNOWN);
    assert.deepEqual(resolveStackStatus([], [ "app" ]).issues, [
        { service: "app",
            name: "",
            reason: "missingInstance" },
    ]);

    // An unreadable state without any running service is not reported as stopped
    const unreadable = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "who-knows" },
    ]);
    assert.equal(unreadable.status, ATTENTION);
    assert.equal(unreadable.issues[0]?.reason, "unknownState");
});

test("one-shot services are read from the compose file, not guessed from names", () => {
    // Compose treats `x-` keys inside a service as extensions, so both spellings are supported
    const extension = readOneShotServices(`services:
  app:
    image: nginx
  init:
    image: alpine
    x-dockge:
      lifecycle: one-shot
  worker:
    image: alpine
    labels:
      dockge.lifecycle: one-shot
  job:
    image: alpine
    labels:
      - dockge.lifecycle=one-shot
`);
    assert.deepEqual([ ...extension ].sort(), [ "init", "job", "worker" ]);

    // A name alone gives no exemption
    assert.deepEqual([ ...readOneShotServices("services:\n  worker:\n    image: alpine\n") ], []);
    assert.deepEqual([ ...readOneShotServices("services: [") ], []);
    assert.deepEqual(readComposeServices("services:\n  app:\n    image: nginx\n  db:\n    image: mariadb\n"), [ "app", "db" ]);
    assert.deepEqual(readComposeServices("not: yaml: ["), []);
});

test("docker ps output of the whole host is mapped to compose entries", () => {
    const entry = fromDockerPs({
        State: "exited",
        Status: "Exited (0) 5 seconds ago",
        HealthStatus: "none",
        Names: "demo-init-1",
        Labels: "com.docker.compose.project=demo,com.docker.compose.service=init,dockge.lifecycle=one-shot",
    });

    assert.equal(entry.project, "demo");
    assert.equal(entry.Service, "init");
    assert.equal(entry.Name, "demo-init-1");
    assert.equal(entry.Health, undefined);

    const instance = normaliseInstance(entry);
    assert.equal(instance.isOneShot, true);
    assert.equal(instance.exitCode, 0);
    assert.equal(instance.issue, null);

    const unhealthy = normaliseInstance(fromDockerPs({
        State: "running",
        Status: "Up 2 minutes (unhealthy)",
        HealthStatus: "unhealthy",
        Names: "demo-app-1",
        Labels: "com.docker.compose.project=demo,com.docker.compose.service=app",
    }));
    assert.equal(unhealthy.health, "unhealthy");
    assert.equal(unhealthy.issue, "unhealthy");

    // A container outside any compose project has no project label
    assert.equal(fromDockerPs({ State: "running",
        Names: "standalone" }).project, "");
});

test("compose file marking makes a clean worker exit acceptable", () => {
    const entries = [
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 3 minutes" },
        { Service: "init",
            Name: "demo-init-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 3 minutes ago" },
    ];

    // Without the marking a stopped long-lived service is a warning
    assert.equal(resolveComposePsStatus(entries, [ "app", "init" ]).status, ATTENTION);

    // With the marking the stack is healthy
    const marked = resolveComposePsStatus(entries, [ "app", "init" ], new Set([ "init" ]));
    assert.equal(marked.status, RUNNING);
    assert.deepEqual(marked.issues, []);
});
