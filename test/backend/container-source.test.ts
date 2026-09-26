import { strict as assert } from "node:assert";
import test from "node:test";
import { ContainerSocketHandler } from "../../backend/agent-socket-handlers/container-socket-handler";
import {
    classifyContainerSource,
    controlContainer,
    inspectContainer,
    StandaloneInventory,
    type DockerCall,
} from "../../backend/container-source";
import type { DockgeServer } from "../../backend/dockge-server";
import { setOwnContainerReader } from "../../backend/own-container";
import { Settings } from "../../backend/settings";
import { ValidationError } from "../../backend/util-server";
import { AgentSocket } from "../../common/agent-socket";
import { ERROR_TYPE_VALIDATION } from "../../common/util-common";
import { CONTAINER_CONTROL_SETTING, type StandaloneContainer } from "../../common/types/container";
import { makeAuthenticatedSocket, withDatabase } from "../helpers/database";

const STACKS = "/opt/stacks";
const WEB = "a1".repeat(32);
const TOOL = "b2".repeat(32);
const APP = "c3".repeat(32);
const ODD = "d4".repeat(32);
const PANEL = "e5".repeat(32);

/**
 * Compose labels as Compose writes them
 * @param project Project name
 * @param service Service name
 * @param workingDir Directory the project was started from
 * @returns Labels
 */
function compose(project : string, service : string, workingDir : string) : Record<string, string> {
    return {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
        "com.docker.compose.project.working_dir": workingDir,
        "com.docker.compose.project.config_files": `${workingDir}/compose.yaml`,
    };
}

/** What each fake container answers to `docker inspect` */
const CONTAINERS : Record<string, Record<string, unknown>> = {
    [WEB]: { Name: "/web-1",
        Config: { Image: "nginx:1.27",
            Labels: compose("web", "web", "/srv/web"),
            Env: [ "PASSWORD=hunter2" ] },
        State: { Status: "running",
            StartedAt: "2026-09-26T08:00:00Z",
            FinishedAt: "0001-01-01T00:00:00Z",
            ExitCode: 0,
            Health: { Status: "healthy" } },
        RestartCount: 1,
        Mounts: [{ Type: "volume",
            Source: "/var/lib/docker/volumes/web/_data",
            Destination: "/usr/share/nginx/html",
            RW: false }],
        NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "0.0.0.0",
            HostPort: "8080" }],
        "443/tcp": null },
        Networks: { web_default: {},
            proxy: {} } } },
    [TOOL]: { Name: "/tool",
        Config: { Image: "alpine",
            Labels: { maintainer: "someone" } },
        State: { Status: "exited",
            ExitCode: 3 } },
    [APP]: { Name: "/app-web-1",
        Config: { Image: "nginx",
            Labels: compose("app", "web", `${STACKS}/app`) },
        State: { Status: "running" } },
    [ODD]: { Name: "/odd",
        Config: { Image: "busybox",
            Labels: { "com.docker.compose.service": "odd" } },
        State: { Status: "running" } },
    [PANEL]: { Name: "/dockge",
        Config: { Image: "ghcr.io/example/dockge2",
            Labels: null },
        State: { Status: "running" } },
};

/**
 * A Docker that knows the containers above
 * @returns How to ask it and what it was asked to do
 */
function fakeDocker() : { docker : DockerCall; commands : string[][] } {
    const commands : string[][] = [];
    return {
        commands,
        docker: async (args) => {
            if (args[0] === "inspect") {
                const id = args.at(-1) ?? "";
                const container = CONTAINERS[id];
                return JSON.stringify(container ? [{ Id: id,
                    ...container }] : []);
            }
            commands.push(args);
            if (args[1] === TOOL && args[0] === "start") {
                throw new Error("Error response from daemon: secret detail");
            }
            return args[1] ?? "";
        },
    };
}

/** Make the panel believe it runs as the container PANEL */
function runAsPanel() : void {
    setOwnContainerReader({
        mountinfo: async () => `1 1 0:1 /var/lib/docker/containers/${PANEL}/hostname /etc/hostname rw - ext4 /dev/sda rw\n`,
        hostname: () => "dockge",
        inspect: async () => JSON.stringify([{ Id: PANEL,
            Config: { Labels: {} } }]),
        imageDigests: async () => "[]",
    });
}

test("a container's source comes from the labels Compose wrote, never from its name", () => {
    assert.equal(classifyContainerSource(compose("app", "web", `${STACKS}/app`), STACKS), "managed");
    assert.equal(classifyContainerSource(compose("app", "web", `${STACKS}/app/`), `${STACKS}/`), "managed");
    assert.equal(classifyContainerSource(compose("app", "web", "/srv/app"), STACKS), "external-compose");
    assert.equal(classifyContainerSource(compose("app", "web", `${STACKS}/app/nested`), STACKS), "external-compose", "only a direct child is a stack");
    assert.equal(classifyContainerSource(compose("stacks", "web", STACKS), STACKS), "external-compose", "the stacks directory itself is not a stack");
    assert.equal(classifyContainerSource({ maintainer: "someone" }, STACKS), "standalone");
    assert.equal(classifyContainerSource({}, STACKS), "standalone");
    assert.equal(classifyContainerSource({ "com.docker.compose.service": "odd" }, STACKS), "unknown", "partial labels are not guessed at");
    assert.equal(classifyContainerSource({ ...compose("app", "web", "relative/dir") }, STACKS), "unknown");
    assert.equal(classifyContainerSource(null, STACKS), "unknown");
    assert.equal(classifyContainerSource(compose("app", "web", `${STACKS}/app`), ""), "external-compose", "without a stacks directory nothing is managed");
});

test("a Docker that stops answering turns the standalone rows unknown and keeps when they were seen", () => {
    const inventory = new StandaloneInventory();
    const row = (name : string, lastSeen : number) : StandaloneContainer => ({ id: name.padEnd(64, "0"),
        name,
        image: "alpine",
        state: "running",
        status: "Up 2 minutes",
        health: "healthy",
        exitCode: null,
        source: "standalone",
        lastSeen });

    inventory.observe([ row("zeta", 1000), row("alpha", 1000) ]);
    assert.deepEqual(inventory.list().map((item) => item.name), [ "alpha", "zeta" ]);

    inventory.lose();
    assert.deepEqual(inventory.list().map((item) => [ item.state, item.status, item.health, item.lastSeen ]), [[ "unknown", "", "", 1000 ], [ "unknown", "", "", 1000 ]]);

    inventory.observe([ row("zeta", 2000) ]);
    assert.deepEqual(inventory.list().map((item) => item.name), [ "zeta" ], "a container gone from a successful reading was removed");
});

test("the container page reads state, ports, mounts and networks, and nothing of the environment", async (t) => {
    t.after(() => setOwnContainerReader());
    runAsPanel();
    const { docker } = fakeDocker();

    const web = await inspectContainer(WEB, STACKS, docker);
    assert.deepEqual(web, {
        id: WEB,
        name: "web-1",
        image: "nginx:1.27",
        source: "external-compose",
        project: "web",
        service: "web",
        workingDir: "/srv/web",
        state: "running",
        health: "healthy",
        startedAt: "2026-09-26T08:00:00Z",
        finishedAt: "0001-01-01T00:00:00Z",
        restartCount: 1,
        exitCode: 0,
        ports: [{ container: "80/tcp",
            host: "0.0.0.0:8080" }, { container: "443/tcp",
            host: "" }],
        mounts: [{ type: "volume",
            source: "/var/lib/docker/volumes/web/_data",
            destination: "/usr/share/nginx/html",
            readOnly: true }],
        networks: [ "proxy", "web_default" ],
        panel: false,
    });
    assert.doesNotMatch(JSON.stringify(web), /hunter2/);

    const tool = await inspectContainer(TOOL, STACKS, docker);
    assert.equal(tool.source, "standalone");
    assert.equal(tool.restartCount, null, "what Docker did not say stays unknown");
    assert.deepEqual(tool.ports, []);
    assert.equal((await inspectContainer(PANEL, STACKS, docker)).panel, true);

    for (const id of [ "web-1", WEB.slice(0, 12), "f".repeat(64), 42 ]) {
        await assert.rejects(inspectContainer(id, STACKS, docker), (e : Error) => e instanceof ValidationError && e.message === "containerNotFound", String(id));
    }
    await assert.rejects(inspectContainer(WEB, STACKS, async () => "not json"), /containerNotFound/);
});

test("only containers outside the stacks directory can be started, stopped or restarted, and never the panel", async (t) => {
    t.after(() => setOwnContainerReader());
    runAsPanel();
    const { docker, commands } = fakeDocker();

    await controlContainer(WEB, "restart", STACKS, docker);
    await controlContainer(TOOL, "stop", STACKS, docker);
    assert.deepEqual(commands, [[ "restart", WEB ], [ "stop", TOOL ]]);

    const refusals : [ string, unknown, string ][] = [
        [ APP, "stop", "containerNotControllable" ],
        [ ODD, "stop", "containerNotControllable" ],
        [ PANEL, "stop", "stackIsPanel" ],
        [ WEB, "rm", "containerActionInvalid" ],
        [ WEB, "kill", "containerActionInvalid" ],
        [ WEB, [ "stop" ], "containerActionInvalid" ],
        [ "--help", "stop", "containerNotFound" ],
    ];
    for (const [ id, action, message ] of refusals) {
        await assert.rejects(controlContainer(id, action, STACKS, docker), (e : Error) => e instanceof ValidationError && e.message === message, `${id} ${String(action)}`);
    }
    assert.equal(commands.length, 2, "nothing refused reached Docker");

    await assert.rejects(controlContainer(TOOL, "start", STACKS, docker), (e : Error) => !(e instanceof ValidationError) && e.message === "containerActionFailed", "what Docker said stays in the log");
});

test("controlling a container needs the owner's setting on the server that runs it", async (t) => {
    t.after(() => setOwnContainerReader());
    runAsPanel();
    await withDatabase(async () => {
        const { docker, commands } = fakeDocker();
        let listsSent = 0;
        const server = { stacksDir: STACKS,
            sendStackList: async () => {
                listsSent++;
            } } as unknown as DockgeServer;
        const agentSocket = new AgentSocket();
        new ContainerSocketHandler(docker).create(makeAuthenticatedSocket(), server, agentSocket);
        const call = (event : string, ...args : unknown[]) => new Promise<Record<string, unknown>>((resolve) => agentSocket.call(event, ...args, resolve));

        const inspected = await call("inspectContainer", WEB);
        assert.equal(inspected.ok, true);
        assert.equal((inspected.container as { source : string }).source, "external-compose");

        assert.deepEqual(await call("controlContainer", WEB, "stop"), { ok: false,
            type: ERROR_TYPE_VALIDATION,
            msg: "containerControlOff",
            msgi18n: true });
        assert.equal(commands.length, 0);

        await Settings.set(CONTAINER_CONTROL_SETTING, true, "security");
        assert.deepEqual(await call("controlContainer", WEB, "stop"), { ok: true,
            msg: "containerActionDone",
            msgi18n: true });
        assert.deepEqual(commands, [[ "stop", WEB ]]);

        const refused = await call("controlContainer", APP, "stop");
        assert.equal(refused.msg, "containerNotControllable");
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(listsSent >= 2, "the list is sent again after an attempt, whatever came of it");
    });
});
