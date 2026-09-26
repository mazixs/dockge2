import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    describePanelContainer,
    findOwnContainerId,
    isPanelStack,
    readPanelIdentity,
    setOwnContainerReader,
    type OwnContainerReader,
} from "../../backend/own-container";
import { Stack } from "../../backend/stack";
import { ValidationError, type DockgeSocket } from "../../backend/util-server";

const ID = "3f".repeat(32);
const DOCKER_MOUNTINFO = [
    "1146 1122 0:62 / / rw,relatime master:540 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC",
    `1170 1146 259:2 /var/lib/docker/containers/${ID}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/nvme0n1p2 rw`,
    `1171 1146 259:2 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/nvme0n1p2 rw`,
].join("\n") + "\n";

/**
 * A Docker that knows one container, the panel
 * @param labels Compose labels of the panel's container
 * @param extra Fields of `docker inspect` beyond the labels
 * @returns Reader to install and the calls it received
 */
function fakeDocker(labels : Record<string, string>, extra : Record<string, unknown> = {}) : { reader : OwnContainerReader; calls : string[] } {
    const calls : string[] = [];
    return {
        calls,
        reader: {
            mountinfo: async () => DOCKER_MOUNTINFO,
            hostname: () => "dockge",
            inspect: async (id) => {
                calls.push(`inspect ${id}`);
                return JSON.stringify([{ Id: ID,
                    Name: "/dockge-dockge-1",
                    Image: "sha256:feed",
                    Config: { Image: "ghcr.io/example/dockge2:0.0.14",
                        Labels: labels },
                    ...extra }]);
            },
            imageDigests: async (image) => {
                calls.push(`image ${image}`);
                return JSON.stringify([ "ghcr.io/example/dockge2@sha256:" + "ab".repeat(32) ]);
            },
        },
    };
}

/**
 * Compose labels of a panel whose compose file lives in a directory
 * @param workingDir Directory Compose recorded
 * @returns Labels
 */
function composeLabels(workingDir : string) : Record<string, string> {
    return {
        "com.docker.compose.project": "dockge",
        "com.docker.compose.service": "dockge",
        "com.docker.compose.project.working_dir": workingDir,
        "com.docker.compose.project.config_files": path.join(workingDir, "compose.yaml"),
    };
}

test("the panel finds its own container by the files the runtime mounted, not by its host name", () => {
    assert.equal(findOwnContainerId(DOCKER_MOUNTINFO, "custom-hostname"), ID);
    assert.equal(findOwnContainerId(`812 790 0:48 /userdata/hosts /etc/hosts rw - tmpfs tmpfs rw\n901 790 0:48 /var/lib/containers/storage/overlay-containers/${ID}/userdata/hostname /etc/hostname rw - tmpfs tmpfs rw\n`, "podman"), ID);
    assert.equal(findOwnContainerId("", "0123456789ab"), "0123456789ab", "the short id in the host name is the fallback");
    assert.equal(findOwnContainerId("", "my-laptop"), "");
    // The host sees the shm mounts of every container, which are not its own
    assert.equal(findOwnContainerId(`500 29 0:70 / /var/lib/docker/containers/${ID}/mounts/shm rw - tmpfs shm rw\n`, "my-laptop"), "");
});

test("only the directory Compose recorded makes a stack the panel's own", () => {
    const own = { id: ID,
        project: "dockge",
        service: "dockge",
        workingDir: "/opt/stacks/dockge" };

    assert.equal(isPanelStack(own, "/opt/stacks/dockge"), true);
    assert.equal(isPanelStack(own, "/opt/stacks/dockge/"), true);
    assert.equal(isPanelStack(own, "/opt/stacks/dockge2"), false, "a similar name is another stack");
    assert.equal(isPanelStack({ ...own,
        workingDir: "" }, "/opt/stacks/dockge"), false, "started without Compose, the panel has no stack");
    assert.equal(isPanelStack(null, "/opt/stacks/dockge"), false);
});

test("the identity is read once, and asked again after Docker did not answer", async (t) => {
    t.after(() => setOwnContainerReader());
    const docker = fakeDocker(composeLabels("/opt/dockge"));
    let failures = 1;
    const inspect = docker.reader.inspect;
    docker.reader.inspect = async (id) => {
        if (failures-- > 0) {
            throw new Error("Cannot connect to the Docker daemon");
        }
        return inspect(id);
    };
    setOwnContainerReader(docker.reader);

    assert.equal(await readPanelIdentity(), null, "a Docker that is not up yet is not an answer");
    const identity = await readPanelIdentity();
    assert.deepEqual(identity, { id: ID,
        project: "dockge",
        service: "dockge",
        workingDir: "/opt/dockge" });
    assert.equal(await readPanelIdentity(), identity);
    assert.deepEqual(docker.calls, [ `inspect ${ID}` ], "a known identity is not asked for again");

    setOwnContainerReader({ ...docker.reader,
        mountinfo: async () => "",
        hostname: () => "my-laptop" });
    assert.equal(await readPanelIdentity(), null, "outside a container nobody is asked");
    assert.equal(await describePanelContainer(), null);
});

test("the card reports what Docker said and leaves the rest unknown", async (t) => {
    t.after(() => setOwnContainerReader());
    const docker = fakeDocker(composeLabels("/opt/dockge"), {
        RestartCount: 2,
        State: { Status: "running",
            StartedAt: "2026-09-26T08:00:00.000000000Z",
            Health: { Status: "healthy" } },
        Mounts: [
            { Type: "bind",
                Source: "/var/run/docker.sock",
                Destination: "/var/run/docker.sock",
                RW: true },
            { Type: "bind",
                Source: "/opt/dockge/data",
                Destination: "/app/data",
                RW: true },
            { Type: "bind",
                Source: "/opt/stacks",
                Destination: "/opt/stacks",
                RW: false },
        ],
    });
    setOwnContainerReader(docker.reader);

    const card = await describePanelContainer();
    assert.deepEqual(card, {
        id: ID,
        name: "dockge-dockge-1",
        project: "dockge",
        service: "dockge",
        workingDir: "/opt/dockge",
        configFiles: "/opt/dockge/compose.yaml",
        image: "ghcr.io/example/dockge2:0.0.14",
        digest: "sha256:" + "ab".repeat(32),
        state: "running",
        health: "healthy",
        startedAt: "2026-09-26T08:00:00.000000000Z",
        restartCount: 2,
        mounts: [
            { type: "bind",
                source: "/var/run/docker.sock",
                destination: "/var/run/docker.sock",
                readOnly: false },
            { type: "bind",
                source: "/opt/dockge/data",
                destination: "/app/data",
                readOnly: false },
            { type: "bind",
                source: "/opt/stacks",
                destination: "/opt/stacks",
                readOnly: true },
        ],
        dockerSocket: true,
    });
    assert.ok(docker.calls.includes("image sha256:feed"), "the digest is read from the image the container runs");

    // A local build has no registry digest and an image without a healthcheck no health
    const bare = fakeDocker({});
    bare.reader.imageDigests = async () => "[]";
    setOwnContainerReader(bare.reader);
    const unknown = await describePanelContainer();
    assert.equal(unknown?.digest, "");
    assert.equal(unknown?.health, "");
    assert.equal(unknown?.restartCount, null);
    assert.equal(unknown?.project, "");
    assert.equal(unknown?.dockerSocket, false);
});

for (const placement of [ "inside", "outside" ] as const) {
    test(`a panel whose compose file is ${placement} the stacks directory cannot be removed or recreated from it`, async (t) => {
        const root = await mkdtemp(path.join(os.tmpdir(), "dockge-own-container-"));
        const stacksDir = path.join(root, "stacks");
        const panelDir = placement === "inside" ? path.join(stacksDir, "dockge") : path.join(root, "dockge");
        const compose = "services:\n  dockge:\n    image: ghcr.io/example/dockge2:0.0.14\n  backup:\n    image: alpine\n";
        t.after(async () => {
            setOwnContainerReader();
            await rm(root, { recursive: true,
                force: true });
        });
        await mkdir(panelDir, { recursive: true });
        await mkdir(path.join(stacksDir, "app"), { recursive: true });
        await writeFile(path.join(panelDir, "compose.yaml"), compose);
        await writeFile(path.join(stacksDir, "app", "compose.yaml"), "services:\n  web:\n    image: nginx\n");
        setOwnContainerReader(fakeDocker(composeLabels(panelDir)).reader);
        t.mock.method(Stack.prototype, "validateComposeConfig", async () => {});
        const server = { stacksDir,
            config: { dataDir: root } } as never;
        const socket = { endpoint: "" } as DockgeSocket;
        const commands : string[][] = [];
        const execute = async (args : string[]) => {
            commands.push(args);
            return 0;
        };

        const app = await Stack.getStack(server, "app");
        assert.equal(app.toSimpleJSON("").panelService, "");
        await app.control("restart", execute);
        assert.equal(commands.length, 1, "any other stack keeps every command");

        if (placement === "outside") {
            return;
        }

        const panel = await Stack.getStack(server, "dockge");
        assert.equal(panel.toSimpleJSON("").panelService, "dockge");
        for (const action of [ "start", "restart", "deploy", "update" ] as const) {
            await assert.rejects(panel.control(action, execute), (e : Error) => e instanceof ValidationError && e.message === "stackIsPanel", action);
        }
        await assert.rejects(panel.down(socket), /stackIsPanel/);
        await assert.rejects(panel.delete(socket), /stackIsPanel/);
        await assert.rejects(panel.restartService(socket, "dockge"), /stackIsPanel/);
        await assert.rejects(panel.updateService(socket, "dockge"), /stackIsPanel/);
        await assert.rejects(panel.startService(socket, "dockge"), /stackIsPanel/);
        assert.equal(commands.length, 1, "nothing reached Docker");

        await panel.control("stop", execute);
        assert.deepEqual(commands[1]?.slice(-1), [ "stop" ], "stopping does what it says, and the page warns about it");
    });
}
