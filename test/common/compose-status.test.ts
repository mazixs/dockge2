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
    summariseServices,
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

    // A stack without any container is not "every service is missing", it is not started,
    // so listing each declared service as a problem would be noise
    assert.deepEqual(resolveStackStatus([], [ "app" ]).issues, []);

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

    // The working directory is read as well, because a project can be renamed
    const renamed = fromDockerPs({
        State: "running",
        Status: "Up 1 minute",
        Names: "renamed-app-1",
        Labels: "com.docker.compose.project=other-name,com.docker.compose.service=app,com.docker.compose.project.working_dir=/opt/stacks/demo",
    });
    assert.equal(renamed.project, "other-name");
    assert.equal(renamed.workingDir, "/opt/stacks/demo");
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

test("services that are created but never started are visible", () => {
    // One service is up, another was created and never started: that is not a healthy stack
    const partiallyCreated = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 2 minutes" },
        { Service: "db",
            Name: "demo-db-1",
            State: "created",
            Status: "Created" },
    ]);
    assert.equal(partiallyCreated.status, ATTENTION);
    assert.equal(partiallyCreated.issues.some((issue) => issue.reason === "notStarted"), true);

    // A stack where nothing was started yet is simply created, without per-service noise
    const nothingStarted = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "created",
            Status: "Created" },
        { Service: "db",
            Name: "demo-db-1",
            State: "created",
            Status: "Created" },
    ]);
    assert.equal(nothingStarted.status, CREATED_STACK);
    assert.deepEqual(nothingStarted.issues, []);
});

test("a stack of one-shot jobs is running while a job runs", () => {
    const oneShotRunning = resolveComposePsStatus([
        { Service: "job",
            Name: "demo-job-1",
            State: "running",
            Status: "Up 10 seconds" },
    ], [ "job" ], new Set([ "job" ]));

    // The job is alive, so calling the stack exited would be wrong
    assert.equal(oneShotRunning.status, RUNNING);
    assert.deepEqual(oneShotRunning.issues, []);

    // Once it finished cleanly the stack is exited again
    const oneShotDone = resolveComposePsStatus([
        { Service: "job",
            Name: "demo-job-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 1 minute ago" },
    ], [ "job" ], new Set([ "job" ]));
    assert.equal(oneShotDone.status, EXITED);
});

test("a declared service is only reported as missing while the stack is up", () => {
    // Nothing runs: the stack is stopped, not "db is missing"
    const stopped = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 1 hour ago" },
    ], [ "app", "db" ]);
    assert.equal(stopped.status, EXITED);
    assert.equal(stopped.issues.some((issue) => issue.reason === "missingInstance"), false);

    // The stack is up, so a service without any container is a real problem
    const running = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 1 minute" },
    ], [ "app", "db" ]);
    assert.equal(running.status, ATTENTION);
    assert.equal(running.issues.some((issue) => issue.reason === "missingInstance"), true);
});

test("сводка сервисов держит порядок файла и судит каждый сервис отдельно", () => {
    const { instances } = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            State: "running",
            Status: "Up 2 minutes" },
        { Service: "worker",
            Name: "demo-worker-1",
            State: "exited",
            ExitCode: 137,
            Status: "Exited (137) 1 minute ago" },
        { Service: "sidecar",
            Name: "demo-sidecar-1",
            State: "running",
            Status: "Up 2 minutes" },
    ], [ "app", "db", "worker" ]);

    const summary = summariseServices(instances, [ "app", "db", "worker" ]);

    // Порядок - файла, а не докера; сервис из докера, которого нет в файле, идёт в конец
    assert.deepEqual(summary.map((item) => item.name), [ "app", "db", "worker", "sidecar" ]);

    assert.equal(summary[0]?.state, "running");
    // Объявлен, но контейнера нет, а стек поднят: это остановлен, а не «работает»
    assert.equal(summary[1]?.state, "stopped");
    // Код 137 - причина внимания, а не просто остановка
    assert.equal(summary[2]?.state, "attention");
    assert.equal(summary[3]?.state, "running");
});

test("сводка не выдаёт нечитаемое состояние за работающее", () => {
    // Стек без контейнеров: состояние сервисов неизвестно, а не «остановлен»
    const neverStarted = summariseServices([], [ "app", "db" ]);
    assert.deepEqual(neverStarted.map((item) => item.state), [ "unknown", "unknown" ]);

    // Docker вернул контейнер без состояния - это тоже «неизвестно»
    const { instances } = resolveComposePsStatus([
        { Service: "app",
            Name: "demo-app-1",
            Status: "" },
    ], [ "app" ]);
    assert.equal(summariseServices(instances, [ "app" ])[0]?.state, "unknown");
});

test("разовый сервис помечен в сводке отдельно от состояния", () => {
    const { instances } = resolveComposePsStatus([
        { Service: "job",
            Name: "demo-job-1",
            State: "exited",
            ExitCode: 0,
            Status: "Exited (0) 1 minute ago" },
    ], [ "job" ], new Set([ "job" ]));

    const summary = summariseServices(instances, [ "job" ], new Set([ "job" ]));
    assert.equal(summary[0]?.isOneShot, true);
    // Чистый выход разового контейнера внимания не требует
    assert.equal(summary[0]?.state, "stopped");
});
