import { strict as assert } from "node:assert";
import test from "node:test";
import {
    containerIdFromProc,
    discoverPanelInstallation,
    PanelUpdate,
    PanelUpdateError,
    panelUpdateRunArgs,
    redactPanelUpdateStatus,
    type DiscoveryEnvironment,
    type DockerFollower,
    type DockerResult,
    type DockerRunner,
    type PanelDiscovery,
    type PanelInstallation,
} from "../../backend/panel-update";
import { PANEL_UPDATE_LABELS, PANEL_UPDATE_PREVIEW_TTL_MS, type PanelUpdateKind, type PanelUpdateStatus } from "../../common/panel-update";

const FROM = "0.0.13";
const TO = "0.0.14";
const INSTALL_DIR = "/srv/dockge2";
const IMAGE = `sha256:${"a".repeat(64)}`;
const OWN_ID = "b".repeat(64);
const REQUEST = "11111111-1111-4111-8111-111111111111";
const REQUEST_2 = "22222222-2222-4222-8222-222222222222";
const REQUEST_3 = "33333333-3333-4333-8333-333333333333";
const AT = "2026-09-25T10:00:00.000Z";

const INSTALLATION : PanelInstallation = {
    installDir: INSTALL_DIR,
    project: "dockge2",
    imageId: IMAGE,
    dataDir: "/srv/dockge2/data",
    dockerSocket: "/run/docker.sock",
};

const MANAGED : PanelDiscovery = {
    managed: "yes",
    installDir: INSTALL_DIR,
    installation: INSTALLATION,
};

function ok(stdout = "") : DockerResult {
    return { code: 0,
        stdout,
        stderr: "" };
}

function fail(stderr : string, code = 1) : DockerResult {
    return { code,
        stdout: "",
        stderr };
}

function phase(name : string, to = TO) : string {
    return JSON.stringify({ dockge2: "phase",
        v: 1,
        op: "op-1",
        phase: name,
        from: FROM,
        to,
        at: AT });
}

function previewLine(to = TO) : string {
    return JSON.stringify({ dockge2: "preview",
        v: 1,
        from: FROM,
        to,
        channel: "stable",
        fields: [ "image" ],
        schemaChanges: false });
}

function result(outcome : string, to = TO, extra : Record<string, unknown> = {}) : string {
    return JSON.stringify({ dockge2: "result",
        v: 1,
        op: "op-1",
        outcome,
        phase: "prepared",
        from: FROM,
        to,
        ...extra });
}

function journal(name : string, op = "op-1", to = TO) : string {
    return JSON.stringify({ dockge2: "journal",
        v: 1,
        op,
        phase: name,
        from: FROM,
        to });
}

interface FakeContainer {
    id : string;
    name : string;
    labels : Record<string, string>;
    created : string;
    status : "created" | "running" | "exited";
    exitCode : number;
    startedAt : string;
    finishedAt : string;
    error : string;
    stdout : string;
}

interface HelperSpec {
    requestId? : string;
    to? : string;
    from? : string;
    running? : boolean;
    exitCode? : number;
    lines? : string[];
    /** How long ago it finished */
    finishedAgoMs? : number;
    installDir? : string;
}

/** Just enough of the Docker CLI for the helpers of one installation */
class FakeDocker {
    readonly containers : FakeContainer[] = [];
    readonly calls : string[][] = [];
    clock = Date.parse(AT);
    /** Answer of the next `docker run -d`, instead of a started helper */
    runFailure : DockerResult | undefined;
    /** With `runFailure`: the container that `docker run` created before failing */
    leftover : Partial<FakeContainer> | undefined;
    statusResult : DockerResult = ok();
    failReads = false;
    /** The daemon starts a created container just as it is being removed */
    startOnRemove = false;
    private counter = 0;

    readonly run : DockerRunner = async (args) => {
        this.calls.push([ ...args ]);
        return this.answer(args);
    };

    readonly now = () => this.clock;

    /** Arguments of every call of a docker command */
    callsOf(command : string) : string[][] {
        return this.calls.filter((call) => call[0] === command);
    }

    add(kind : PanelUpdateKind, spec : HelperSpec = {}) : FakeContainer {
        const running = spec.running ?? false;
        const container : FakeContainer = {
            id: this.nextId(),
            name: `dockge2-update-dockge2-${kind}`,
            labels: {
                [PANEL_UPDATE_LABELS.request]: spec.requestId ?? REQUEST,
                [PANEL_UPDATE_LABELS.kind]: kind,
                [PANEL_UPDATE_LABELS.installation]: spec.installDir ?? INSTALL_DIR,
                [PANEL_UPDATE_LABELS.from]: spec.from ?? FROM,
                [PANEL_UPDATE_LABELS.to]: spec.to ?? TO,
                [PANEL_UPDATE_LABELS.started]: AT,
            },
            created: new Date(this.clock - 60_000).toISOString(),
            status: running ? "running" : "exited",
            exitCode: running ? 0 : spec.exitCode ?? 0,
            startedAt: new Date(this.clock - 60_000).toISOString(),
            finishedAt: running ? "0001-01-01T00:00:00Z" : new Date(this.clock - (spec.finishedAgoMs ?? 1000)).toISOString(),
            error: "",
            stdout: (spec.lines ?? []).map((line) => `${line}\n`).join(""),
        };
        this.containers.push(container);
        return container;
    }

    find(kind : PanelUpdateKind) : FakeContainer | undefined {
        return this.containers.find((container) => container.name.endsWith(`-${kind}`));
    }

    /** The helper prints lines, as the updater would */
    write(kind : PanelUpdateKind, ...lines : string[]) : void {
        const container = this.find(kind);
        assert.ok(container);
        container.stdout += lines.map((line) => `${line}\n`).join("");
    }

    finish(kind : PanelUpdateKind, exitCode : number, ...lines : string[]) : void {
        this.write(kind, ...lines);
        const container = this.find(kind);
        assert.ok(container);
        container.status = "exited";
        container.exitCode = exitCode;
        container.finishedAt = new Date(this.clock).toISOString();
    }

    private nextId() : string {
        this.counter += 1;
        return this.counter.toString(16).padStart(64, "c");
    }

    private answer(args : readonly string[]) : DockerResult {
        const [ command, ...rest ] = args;
        switch (command) {
            case "ps":
                return this.failReads ? fail("Cannot connect to the Docker daemon") : this.ps(rest);
            case "inspect":
                return this.failReads ? fail("Cannot connect to the Docker daemon") : this.inspect(rest.slice(2));
            case "logs":
                return this.logs(rest[0] ?? "");
            case "run":
                return this.start(rest);
            case "kill":
                return this.kill(rest[2] ?? "");
            case "rm":
                return this.remove(rest[0] ?? "");
            default:
                return fail(`unexpected docker ${args.join(" ")}`);
        }
    }

    private ps(args : readonly string[]) : DockerResult {
        const filter = args[args.indexOf("--filter") + 1] ?? "";
        const prefix = `label=${PANEL_UPDATE_LABELS.installation}=`;
        assert.ok(filter.startsWith(prefix));
        const dir = filter.slice(prefix.length);
        return ok(this.containers.filter((container) => container.labels[PANEL_UPDATE_LABELS.installation] === dir).map((container) => `${container.id}\n`).join(""));
    }

    private lookup(ref : string) : FakeContainer | undefined {
        return this.containers.find((container) => container.id === ref || container.name === ref);
    }

    private inspect(refs : readonly string[]) : DockerResult {
        const found = refs.map((ref) => this.lookup(ref));
        const json = JSON.stringify(found.filter((container) => container !== undefined).map((container) => ({
            Id: container.id,
            Name: `/${container.name}`,
            Created: container.created,
            Image: IMAGE,
            Config: { Hostname: container.id.slice(0, 12),
                Labels: container.labels },
            State: {
                Status: container.status,
                Running: container.status === "running",
                ExitCode: container.exitCode,
                StartedAt: container.startedAt,
                FinishedAt: container.finishedAt,
                Error: container.error,
            },
            Mounts: [],
        })));
        const missing = refs.filter((_ref, index) => !found[index]);
        return { code: missing.length > 0 ? 1 : 0,
            stdout: json,
            stderr: missing.map((ref) => `Error: No such object: ${ref}\n`).join("") };
    }

    private logs(ref : string) : DockerResult {
        const container = this.lookup(ref);
        return container ? ok(container.stdout) : fail(`Error: No such container: ${ref}`);
    }

    private start(args : readonly string[]) : DockerResult {
        if (args.includes("--rm")) {
            return this.statusResult;
        }
        const name = args[args.indexOf("--name") + 1] ?? "";
        if (this.containers.some((container) => container.name === name)) {
            return fail(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "x".`, 125);
        }
        const labels : Record<string, string> = {};
        args.forEach((arg, index) => {
            if (arg === "--label") {
                const [ key, ...value ] = (args[index + 1] ?? "").split("=");
                labels[key ?? ""] = value.join("=");
            }
        });
        const base : FakeContainer = {
            id: this.nextId(),
            name,
            labels,
            created: new Date(this.clock).toISOString(),
            status: "running",
            exitCode: 0,
            startedAt: new Date(this.clock).toISOString(),
            finishedAt: "0001-01-01T00:00:00Z",
            error: "",
            stdout: "",
        };
        const failure = this.runFailure;
        if (failure) {
            this.runFailure = undefined;
            if (this.leftover) {
                this.containers.push({ ...base,
                    status: "created",
                    startedAt: "0001-01-01T00:00:00Z",
                    ...this.leftover });
            }
            return failure;
        }
        this.containers.push(base);
        return ok(`${base.id}\n`);
    }

    private kill(ref : string) : DockerResult {
        const container = this.lookup(ref);
        if (!container) {
            return fail(`Error: No such container: ${ref}`);
        }
        return container.status === "running" ? ok(`${ref}\n`) : fail(`Error response from daemon: cannot kill container: ${ref}: container ${ref} is not running`);
    }

    private remove(ref : string) : DockerResult {
        const index = this.containers.findIndex((container) => container.id === ref);
        const container = this.containers[index];
        if (!container) {
            return fail(`Error: No such container: ${ref}`);
        }
        if (this.startOnRemove && container.status === "created") {
            container.status = "running";
            container.startedAt = new Date(this.clock).toISOString();
        }
        if (container.status === "running") {
            return fail(`Error response from daemon: cannot remove container "/${container.name}": container is running: stop the container before removing or force remove`);
        }
        this.containers.splice(index, 1);
        return ok(`${ref}\n`);
    }
}

interface FakeStream {
    args : readonly string[];
    onLine : (line : string) => void;
    end : () => void;
    stopped : boolean;
}

/** `docker logs --follow` that the test feeds and ends */
class FakeFollow {
    readonly streams : FakeStream[] = [];

    readonly follow : DockerFollower = (args, onLine) => {
        let end = () => undefined as void;
        const done = new Promise<void>((resolve) => {
            end = resolve;
        });
        const stream : FakeStream = { args,
            onLine,
            end,
            stopped: false };
        this.streams.push(stream);
        return {
            done,
            stop: () => {
                stream.stopped = true;
                end();
            },
        };
    };
}

interface Observer {
    panel : PanelUpdate;
    published : PanelUpdateStatus[];
    follow : FakeFollow;
}

function observe(docker : FakeDocker, options : { version? : string; discovery? : PanelDiscovery } = {}) : Observer {
    const published : PanelUpdateStatus[] = [];
    const follow = new FakeFollow();
    const panel = new PanelUpdate({
        version: options.version ?? FROM,
        docker: docker.run,
        follow: follow.follow,
        discover: async () => options.discovery ?? MANAGED,
        publish: (status) => published.push(status),
        now: docker.now,
    });
    return { panel,
        published,
        follow };
}

async function refused(action : Promise<unknown>, code : string) : Promise<void> {
    await assert.rejects(action, (error : unknown) => error instanceof PanelUpdateError && error.code === code && error.message === `panelUpdateError.${code}`);
}

async function until(check : () => boolean) : Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(check(), "the condition never became true");
}

const MOUNTINFO = `1234 1200 259:2 /var/lib/docker/containers/${OWN_ID}/hostname /etc/hostname rw,relatime - ext4 /dev/nvme0n1p2 rw\n`;

function ownContainer(overrides : Record<string, unknown> = {}) : Record<string, unknown> {
    return {
        Id: OWN_ID,
        Name: "/dockge2-dockge-1",
        Image: IMAGE,
        Config: { Hostname: OWN_ID.slice(0, 12),
            Labels: { "com.docker.compose.project": "dockge2",
                "com.docker.compose.project.working_dir": INSTALL_DIR } },
        Mounts: [
            { Type: "bind",
                Source: "/srv/dockge2/data",
                Destination: "/app/data" },
            { Type: "bind",
                Source: "/run/docker.sock",
                Destination: "/var/run/docker.sock" },
        ],
        ...overrides,
    };
}

function environment(inspect : (ref : string) => DockerResult, env : Partial<DiscoveryEnvironment> = {}) : DiscoveryEnvironment & { calls : string[][] } {
    const calls : string[][] = [];
    return {
        calls,
        docker: async (args) => {
            calls.push([ ...args ]);
            return inspect(args[3] ?? "");
        },
        hostname: OWN_ID.slice(0, 12),
        readProcFile: async (file) => file.endsWith("mountinfo") ? MOUNTINFO : "0::/\n",
        containerHint: false,
        ...env,
    };
}

test("outside of a container discovery asks Docker nothing and reads not managed", async () => {
    const env = environment(() => fail("must not be called"), { readProcFile: async () => undefined });
    assert.deepEqual(await discoverPanelInstallation(env), { managed: "no",
        reason: "not-container" });
    assert.deepEqual(env.calls, []);
});

test("discovery reads the installation from the panel's own container", async () => {
    const env = environment(() => ok(JSON.stringify([ ownContainer() ])));
    assert.deepEqual(await discoverPanelInstallation(env), MANAGED);
    assert.deepEqual(env.calls, [[ "inspect", "--type", "container", OWN_ID.slice(0, 12) ]]);
});

test("a hostname that names another container is not taken for the panel", async () => {
    const foreign = ownContainer({ Id: "d".repeat(64) });
    const env = environment((ref) => ok(JSON.stringify([ ref === "panel" ? foreign : ownContainer() ])), { hostname: "panel" });
    assert.deepEqual(await discoverPanelInstallation(env), MANAGED);
    assert.deepEqual(env.calls.map((call) => call[3]), [ "panel", OWN_ID ]);

    const alone = environment((ref) => ref === "panel" ? ok(JSON.stringify([ foreign ])) : fail(`Error: No such object: ${ref}`), { hostname: "panel" });
    assert.deepEqual(await discoverPanelInstallation(alone), { managed: "no",
        reason: "not-container" });
});

test("discovery refuses installations the updater cannot handle", async () => {
    const noLabel = ownContainer({ Config: { Hostname: OWN_ID.slice(0, 12),
        Labels: {} } });
    assert.deepEqual(await discoverPanelInstallation(environment(() => ok(JSON.stringify([ noLabel ])))), { managed: "no",
        reason: "no-installation" });

    const badProject = ownContainer({ Config: { Hostname: OWN_ID.slice(0, 12),
        Labels: { "com.docker.compose.project": "Dockge2",
            "com.docker.compose.project.working_dir": INSTALL_DIR } } });
    assert.equal((await discoverPanelInstallation(environment(() => ok(JSON.stringify([ badProject ]))))).reason, "no-installation");

    const relativeDir = ownContainer({ Config: { Hostname: OWN_ID.slice(0, 12),
        Labels: { "com.docker.compose.project": "dockge2",
            "com.docker.compose.project.working_dir": "srv/dockge2" } } });
    assert.equal((await discoverPanelInstallation(environment(() => ok(JSON.stringify([ relativeDir ]))))).reason, "no-installation");

    const volumeData = ownContainer({ Mounts: [
        { Type: "volume",
            Source: "/var/lib/docker/volumes/data/_data",
            Destination: "/app/data" },
        { Type: "bind",
            Source: "/run/docker.sock",
            Destination: "/var/run/docker.sock" },
    ] });
    assert.deepEqual(await discoverPanelInstallation(environment(() => ok(JSON.stringify([ volumeData ])))), { managed: "no",
        reason: "unsupported",
        installDir: INSTALL_DIR });

    const noSocket = ownContainer({ Mounts: [{ Type: "bind",
        Source: "/srv/dockge2/data",
        Destination: "/app/data" }] });
    assert.equal((await discoverPanelInstallation(environment(() => ok(JSON.stringify([ noSocket ]))))).reason, "unsupported");
});

test("discovery that Docker does not answer is unknown, not unmanaged", async () => {
    const env = environment(() => fail("permission denied while trying to connect to the Docker daemon socket"));
    assert.deepEqual(await discoverPanelInstallation(env), { managed: "unknown",
        reason: "unreadable" });
});

test("the container id is read from the mounts or from a cgroup v1 path", () => {
    assert.equal(containerIdFromProc(MOUNTINFO, undefined), OWN_ID);
    assert.equal(containerIdFromProc("", `12:memory:/docker/${OWN_ID}\n`), OWN_ID);
    assert.equal(containerIdFromProc("", `0::/system.slice/docker-${OWN_ID}.scope\n`), OWN_ID);
    assert.equal(containerIdFromProc("1 2 3 / / rw - ext4 /dev/sda rw\n", "0::/\n"), undefined);
});

test("a helper is started with fixed arguments, bind mounts that refuse a missing source and no shell", () => {
    const args = panelUpdateRunArgs(INSTALLATION, { kind: "preview",
        requestId: REQUEST,
        from: FROM,
        to: TO,
        startedAt: AT });
    assert.deepEqual(args, [
        "run", "-d",
        "--name", "dockge2-update-dockge2-preview",
        "--restart", "no",
        "--pull", "never",
        "--user", "0:0",
        "--log-driver", "json-file",
        "--log-opt", "max-size=1m",
        "--label", `io.dockge2.update.request=${REQUEST}`,
        "--label", "io.dockge2.update.kind=preview",
        "--label", `io.dockge2.update.installation=${INSTALL_DIR}`,
        "--label", `io.dockge2.update.from=${FROM}`,
        "--label", `io.dockge2.update.to=${TO}`,
        "--label", `io.dockge2.update.started=${AT}`,
        "--mount", "type=bind,source=/srv/dockge2,target=/srv/dockge2,readonly",
        "--mount", "type=bind,source=/srv/dockge2/.dockge2,target=/srv/dockge2/.dockge2",
        "--mount", "type=bind,source=/srv/dockge2/data,target=/srv/dockge2/data,readonly",
        "--mount", "type=bind,source=/tmp,target=/tmp",
        "--mount", "type=bind,source=/run/docker.sock,target=/var/run/docker.sock",
        "--entrypoint", "/srv/dockge2/.dockge2/update",
        IMAGE,
        "--progress", "json", "--version", TO, "--dry-run",
    ]);

    const apply = panelUpdateRunArgs(INSTALLATION, { kind: "apply",
        requestId: REQUEST,
        from: FROM,
        to: TO,
        startedAt: AT });
    assert.deepEqual(apply.slice(apply.indexOf(IMAGE)), [ IMAGE, "--progress", "json", "--version", TO, "--yes", "--restore-on-failed-start" ]);
    assert.equal(apply[apply.indexOf("--name") + 1], "dockge2-update-dockge2-apply");

    const status = panelUpdateRunArgs(INSTALLATION, { kind: "status",
        requestId: REQUEST,
        from: FROM,
        to: TO,
        startedAt: AT });
    assert.equal(status[1], "--rm");
    assert.ok(status.includes("type=bind,source=/srv/dockge2/.dockge2,target=/srv/dockge2/.dockge2,readonly"));
    assert.deepEqual(status.slice(status.indexOf(IMAGE)), [ IMAGE, "--progress", "json", "--status" ]);

    for (const list of [ args, apply, status ]) {
        for (const forbidden of [ "-v", "--volume", "-e", "--env", "--env-file", "sh", "-c", "--privileged" ]) {
            assert.ok(!list.includes(forbidden), `${forbidden} in ${list.join(" ")}`);
        }
    }
});

test("an unmanaged panel shows its reason and refuses to start anything", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker, { discovery: { managed: "no",
        reason: "not-container" } });
    assert.deepEqual(await panel.status(), { schema: 1,
        panel: { version: FROM,
            managed: "no",
            reason: "not-container" } });
    await refused(panel.preview(REQUEST, TO), "unmanaged");
    assert.deepEqual(docker.calls, []);
});

test("arguments that are not a request id or a version are refused before Docker is asked", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    await refused(panel.preview("not-a-uuid", TO), "invalid");
    await refused(panel.preview("AAAAAAAA-1111-4111-8111-111111111111", TO), "invalid");
    await refused(panel.preview(REQUEST, "latest"), "invalid");
    await refused(panel.preview(REQUEST, "0.0.14 --yes"), "invalid");
    await refused(panel.preview(REQUEST, `0.0.14-${"x".repeat(80)}`), "invalid");
    await refused(panel.apply(REQUEST, REQUEST, TO), "invalid");
    await refused(panel.cancel(42), "invalid");
    await refused(panel.dismiss(undefined), "invalid");
    assert.deepEqual(docker.calls, []);
});

test("a dry run starts, is followed and ends as previewed", async () => {
    const docker = new FakeDocker();
    const { panel, published, follow } = observe(docker);

    const started = await panel.preview(REQUEST, TO);
    const run = docker.callsOf("run")[0];
    assert.ok(run);
    assert.ok(run.includes(`io.dockge2.update.from=${FROM}`));
    assert.equal(started.operation?.kind, "preview");
    assert.equal(started.operation?.running, true);
    assert.equal(started.operation?.requestId, REQUEST);

    const helper = docker.find("preview");
    assert.ok(helper);
    assert.deepEqual(follow.streams.map((stream) => stream.args), [[ "logs", "--follow", helper.id ]]);

    docker.finish("preview", 0, previewLine(), result("previewed"));
    follow.streams[0]?.end();
    await until(() => published.at(-1)?.operation?.result?.outcome === "previewed");
    assert.deepEqual(published.at(-1)?.operation?.preview, { channel: "stable",
        fields: [ "image" ],
        schemaChanges: false });
    panel.stop();
});

test("a dry run is refused while a helper runs or an update waits to be dismissed", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.add("preview", { running: true });
    await refused(panel.preview(REQUEST_2, TO), "busy");

    docker.containers.length = 0;
    docker.add("apply", { exitCode: 0,
        lines: [ result("success") ] });
    await refused(panel.preview(REQUEST_2, TO), "busy");
    assert.equal(docker.callsOf("run").length, 0);
    panel.stop();
});

test("a finished dry run is replaced by the next one", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    const old = docker.add("preview", { exitCode: 0,
        lines: [ result("previewed") ] });
    const status = await panel.preview(REQUEST_2, TO);
    assert.deepEqual(docker.callsOf("rm"), [[ "rm", old.id ]]);
    assert.equal(status.operation?.requestId, REQUEST_2);
    assert.equal(status.operation?.running, true);
    panel.stop();
});

test("a missing updater directory marks the panel as updater-missing", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.runFailure = fail("docker: Error response from daemon: invalid mount config for type \"bind\": bind source path does not exist: /srv/dockge2/.dockge2", 125);
    await refused(panel.preview(REQUEST, TO), "updater-missing");
    const status = await panel.status();
    assert.equal(status.panel.managed, "no");
    assert.equal(status.panel.reason, "updater-missing");
    assert.equal(status.panel.installDir, INSTALL_DIR);
    await refused(panel.preview(REQUEST, TO), "unmanaged");
});

test("an updater that cannot be executed is updater-missing, and its container is removed", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.runFailure = fail("docker: Error response from daemon: failed to create task: exec: \"/srv/dockge2/.dockge2/update\": stat: no such file or directory", 127);
    docker.leftover = { error: "exec: no such file or directory" };
    await refused(panel.preview(REQUEST, TO), "updater-missing");
    assert.equal(docker.callsOf("rm").length, 1);
    assert.equal(docker.containers.length, 0);
});

test("a name taken by another installation is name-taken, other refusals are start-failed", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    // Moved from /elsewhere with the same project name: its helper never shows in the status
    docker.add("preview", { installDir: "/elsewhere" });
    await refused(panel.preview(REQUEST, TO), "name-taken");
    assert.equal((await panel.status()).operation, undefined);

    docker.containers.length = 0;
    docker.runFailure = fail("docker: Error response from daemon: no space left on device", 125);
    docker.leftover = {};
    await refused(panel.preview(REQUEST, TO), "start-failed");
    assert.equal(docker.containers.length, 0, "the container that never started is removed");

    const status = await panel.status();
    assert.equal(status.panel.managed, "yes");
});

test("a docker run that failed after the helper started counts as started", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.runFailure = fail("Process timed out after 60000ms");
    docker.leftover = { status: "running",
        startedAt: AT };
    const status = await panel.preview(REQUEST, TO);
    assert.equal(status.operation?.running, true);
    assert.equal(docker.callsOf("rm").length, 0);
    panel.stop();
});

test("a helper that starts while its failed docker run is cleaned up counts as started", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.runFailure = fail("Process timed out after 60000ms", 127);
    docker.leftover = {};
    docker.startOnRemove = true;
    const status = await panel.preview(REQUEST, TO);
    assert.equal(status.operation?.running, true);
    assert.equal(status.panel.managed, "yes", "a helper that runs is not a missing updater");
    panel.stop();
});

test("an update needs a fresh dry run of that very version by this panel", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    const fresh = { requestId: REQUEST,
        exitCode: 0,
        lines: [ previewLine(), result("previewed") ] };

    await refused(panel.apply(REQUEST_2, REQUEST, TO), "stale-preview");

    docker.add("preview", fresh);
    await refused(panel.apply(REQUEST_2, REQUEST_3, TO), "stale-preview");
    await refused(panel.apply(REQUEST_2, REQUEST, "0.0.15"), "stale-preview");

    docker.containers.length = 0;
    docker.add("preview", { ...fresh,
        finishedAgoMs: PANEL_UPDATE_PREVIEW_TTL_MS + 1000 });
    await refused(panel.apply(REQUEST_2, REQUEST, TO), "stale-preview");

    docker.containers.length = 0;
    docker.add("preview", { ...fresh,
        from: "0.0.12" });
    await refused(panel.apply(REQUEST_2, REQUEST, TO), "stale-preview");

    docker.containers.length = 0;
    docker.add("preview", { requestId: REQUEST,
        exitCode: 1,
        lines: [ result("refused", TO, { error: "the release is not signed" }) ] });
    await refused(panel.apply(REQUEST_2, REQUEST, TO), "stale-preview");

    docker.containers.length = 0;
    docker.add("preview", { requestId: REQUEST,
        running: true,
        lines: [ previewLine() ] });
    await refused(panel.apply(REQUEST_2, REQUEST, TO), "stale-preview");

    docker.containers.length = 0;
    docker.add("preview", fresh);
    docker.add("apply", { requestId: REQUEST_3,
        exitCode: 1,
        lines: [ result("failed-before-cutover") ] });
    await refused(panel.apply(REQUEST_2, REQUEST, TO), "busy");
    assert.equal(docker.callsOf("run").length, 0);
});

test("an update starts, consumes its dry run and is followed", async () => {
    const docker = new FakeDocker();
    const { panel, follow } = observe(docker);
    const preview = docker.add("preview", { requestId: REQUEST,
        exitCode: 0,
        lines: [ previewLine(), result("previewed") ] });

    const status = await panel.apply(REQUEST_2, REQUEST, TO);
    const run = docker.callsOf("run")[0];
    assert.ok(run?.includes("--yes"));
    assert.ok(run?.includes("--restore-on-failed-start"));
    assert.deepEqual(docker.callsOf("rm"), [[ "rm", preview.id ]]);
    assert.equal(status.operation?.kind, "apply");
    assert.equal(status.operation?.requestId, REQUEST_2);
    assert.equal(status.operation?.running, true);
    assert.equal(follow.streams.length, 1);
    panel.stop();
    assert.equal(follow.streams[0]?.stopped, true);
});

test("cancel signals the update only until the image was downloaded", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    const helper = docker.add("apply", { requestId: REQUEST,
        running: true,
        lines: [ phase("prepared") ] });

    await refused(panel.cancel(REQUEST_2), "not-found");
    await panel.cancel(REQUEST);
    assert.deepEqual(docker.callsOf("kill"), [[ "kill", "--signal", "TERM", helper.id ]]);

    docker.write("apply", phase("downloaded"));
    await refused(panel.cancel(REQUEST), "too-late");

    docker.finish("apply", 0, result("success"));
    await refused(panel.cancel(REQUEST), "too-late");
    assert.equal(docker.callsOf("kill").length, 1);
    assert.equal(docker.callsOf("stop").length, 0);
    assert.equal(docker.callsOf("rm").length, 0, "a running helper is never removed");
    panel.stop();
});

test("a dry run can always be cancelled while it runs", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.add("preview", { requestId: REQUEST,
        running: true,
        lines: [ phase("downloaded") ] });
    await panel.cancel(REQUEST);
    assert.equal(docker.callsOf("kill").length, 1);
    panel.stop();
});

test("dismiss removes a finished helper and refuses a running one", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.add("apply", { requestId: REQUEST,
        running: true });
    await refused(panel.dismiss(REQUEST), "running");
    await refused(panel.dismiss(REQUEST_2), "not-found");
    assert.equal(docker.callsOf("rm").length, 0);

    docker.finish("apply", 1, result("failed-before-cutover", TO, { error: "the image could not be pulled" }));
    const status = await panel.dismiss(REQUEST);
    assert.equal(docker.callsOf("rm").length, 1);
    assert.equal(status.operation, undefined);
    panel.stop();
});

test("an update that left no result is read from the journal by one status helper", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.add("apply", { requestId: REQUEST,
        exitCode: 137,
        lines: [ phase("prepared"), phase("downloaded"), phase("stopping") ] });
    docker.statusResult = ok(`${journal("starting-target")}\n`);

    const status = await panel.status();
    assert.equal(status.operation?.result?.outcome, "unknown");
    assert.equal(status.operation?.result?.code, "interrupted");
    assert.equal(status.operation?.phase, "starting-target");

    const statusRuns = docker.callsOf("run");
    assert.equal(statusRuns.length, 1);
    assert.equal(statusRuns[0]?.[1], "--rm");
    assert.ok(statusRuns[0]?.includes("--status"));
    assert.ok(statusRuns[0]?.includes(`io.dockge2.update.request=${REQUEST}`));

    // The journal of that request is kept; asking again starts no second helper
    await panel.status();
    assert.equal(docker.callsOf("run").length, 1);
});

test("a journal that reached a final phase gives the outcome", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.add("apply", { requestId: REQUEST,
        exitCode: 143,
        lines: [ phase("prepared") ] });
    docker.statusResult = ok(`${journal("recovered")}\n`);
    const status = await panel.status();
    assert.equal(status.operation?.result?.outcome, "recovered");
});

test("the journal of an earlier update is not the result of a helper killed before its first line", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.add("apply", { requestId: REQUEST,
        exitCode: 137 });
    docker.statusResult = ok(`${journal("recovered", "20260920T080000.000000000")}\n`);
    const status = await panel.status();
    assert.equal(status.operation?.result?.outcome, "unknown");
    assert.equal(status.operation?.result?.code, "no-result");
});

test("a status helper Docker did not run is asked again later, and the result stays unknown", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.add("apply", { requestId: REQUEST,
        exitCode: 137 });
    docker.statusResult = fail("docker: Error response from daemon: Conflict.", 125);

    const status = await panel.status();
    assert.equal(status.operation?.result?.outcome, "unknown");
    assert.equal(status.operation?.result?.code, "no-result");
    await panel.status();
    assert.equal(docker.callsOf("run").length, 1);

    docker.clock += 31_000;
    // No line gave the operation id, so the journal must have recorded it after the helper started
    docker.statusResult = ok(`${journal("recovery-required", "20260925T100001.000000000")}\n`);
    const later = await panel.status();
    assert.equal(docker.callsOf("run").length, 2);
    assert.equal(later.operation?.result?.outcome, "recovery-required");
});

test("an installed updater older than the progress protocol reads as updater-outdated", async () => {
    const docker = new FakeDocker();
    const { panel } = observe(docker);
    docker.add("apply", { requestId: REQUEST,
        exitCode: 2 });
    const status = await panel.status();
    assert.equal(status.operation?.result?.outcome, "refused");
    assert.equal(status.operation?.result?.code, "updater-outdated");
    assert.equal(docker.callsOf("run").length, 0, "no status helper for an updater that never ran");
});

test("success needs the answering panel to run the target version", async () => {
    const docker = new FakeDocker();
    docker.add("apply", { requestId: REQUEST,
        exitCode: 0,
        lines: [ phase("checking-target"), result("success") ] });
    const oldPanel = observe(docker);
    assert.equal((await oldPanel.panel.status()).operation?.result?.code, "version-mismatch");
    const newPanel = observe(docker, { version: TO });
    assert.equal((await newPanel.panel.status()).operation?.result?.outcome, "success");
});

test("the observer follows a running update on start and pushes each change once", async () => {
    const docker = new FakeDocker();
    docker.add("apply", { requestId: REQUEST,
        running: true,
        lines: [ phase("prepared") ] });
    const { panel, published, follow } = observe(docker, { version: TO });

    await panel.start();
    assert.equal(published.length, 1);
    assert.equal(published[0]?.operation?.phase, "prepared");
    assert.equal(follow.streams.length, 1);

    docker.write("apply", phase("downloaded"));
    follow.streams[0]?.onLine(phase("downloaded"));
    await until(() => published.at(-1)?.operation?.phase === "downloaded");

    // Human text on stdout changes nothing and is not pushed
    const before = published.length;
    follow.streams[0]?.onLine("Pulling the image");
    await panel.refresh();
    assert.equal(published.length, before);

    docker.finish("apply", 0, phase("checking-target"), result("success"));
    follow.streams[0]?.end();
    await until(() => published.at(-1)?.operation?.result?.outcome === "success");
    assert.equal(published.at(-1)?.operation?.running, false);
    panel.stop();
});

test("a Docker that does not answer gives an unknown status that is never pushed", async () => {
    const docker = new FakeDocker();
    docker.failReads = true;
    const { panel, published } = observe(docker);
    const status = await panel.status();
    assert.equal(status.panel.managed, "unknown");
    assert.equal(status.panel.reason, "unreadable");
    assert.equal(status.operation, undefined);
    assert.deepEqual(published, []);
    await refused(panel.preview(REQUEST, TO), "unreadable");
    await refused(panel.cancel(REQUEST), "unreadable");
});

test("a user who is not an owner sees neither the installation path nor error texts", () => {
    const status : PanelUpdateStatus = {
        schema: 1,
        panel: { version: FROM,
            managed: "yes",
            installDir: INSTALL_DIR },
        operation: {
            requestId: REQUEST,
            kind: "apply",
            from: FROM,
            to: TO,
            startedAt: AT,
            running: false,
            result: { outcome: "failed-before-cutover",
                error: "pull access denied for registry.example.com/private" },
        },
    };
    const copy = structuredClone(status);
    const redacted = redactPanelUpdateStatus(status, false);
    assert.equal(redacted.panel.installDir, undefined);
    assert.equal(redacted.operation?.result?.error, undefined);
    assert.equal(redacted.operation?.result?.outcome, "failed-before-cutover");
    assert.deepEqual(status, copy, "the full status is left as it was");
    assert.equal(redactPanelUpdateStatus(status, true), status);
});
