import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "./child-process";
import { log } from "./log";
import {
    COMPOSE_PROJECT_LABEL,
    COMPOSE_WORKING_DIR_LABEL,
} from "../common/compose-status";
import type { PanelContainer, PanelMount } from "../common/types/panel-container";

/** Compose puts these on every container it creates */
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const COMPOSE_CONFIG_FILES_LABEL = "com.docker.compose.project.config_files";

/** Who the panel is, as far as a guard needs to know: fixed while the process lives */
export interface PanelIdentity {
    id : string;
    project : string;
    service : string;
    workingDir : string;
}

/** The part of `docker inspect` the panel reads about itself */
interface InspectedContainer {
    Id? : string;
    Name? : string;
    Image? : string;
    RestartCount? : number;
    Config? : { Image? : string; Labels? : Record<string, string> | null };
    State? : { Status? : string; StartedAt? : string; Health? : { Status? : string } };
    Mounts? : { Type? : string; Source? : string; Destination? : string; RW? : boolean }[];
}

/** How the panel asks Docker; replaced in tests */
export interface OwnContainerReader {
    mountinfo : () => Promise<string>;
    hostname : () => string;
    inspect : (id : string) => Promise<string>;
    imageDigests : (imageId : string) => Promise<string>;
}

const dockerReader : OwnContainerReader = {
    mountinfo: () => readFile("/proc/self/mountinfo", "utf8"),
    hostname: () => os.hostname(),
    inspect: async (id) => (await spawn("docker", [ "inspect", "--type", "container", id ], {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeoutMs: 15_000,
    })).stdout?.toString() ?? "",
    imageDigests: async (imageId) => (await spawn("docker", [ "image", "inspect", "--format", "{{json .RepoDigests}}", imageId ], {
        encoding: "utf-8",
        maxBuffer: 256 * 1024,
        timeoutMs: 15_000,
    })).stdout?.toString() ?? "",
};

let reader = dockerReader;
let identity : Promise<PanelIdentity | null> | undefined;

/**
 * Find the id of the container this process runs in.
 *
 * The runtime bind-mounts `hostname`, `hosts` and `resolv.conf` from the container's own
 * directory, and that directory is named by the full id - which holds when `hostname:`
 * is set in the compose file, where the host name tells nothing. The short id in the
 * host name is the fallback, for a runtime that mounts those files differently.
 * @param mountinfo Contents of `/proc/self/mountinfo`, empty when it cannot be read
 * @param hostname Host name of this process
 * @returns The full id, a twelve character prefix, or "" outside a container
 */
export function findOwnContainerId(mountinfo : string, hostname : string) : string {
    const mounted = /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)\s/.exec(mountinfo)
        ?? /\/overlay-containers\/([0-9a-f]{64})\/userdata\//.exec(mountinfo);

    if (mounted?.[1]) {
        return mounted[1];
    }

    return /^[0-9a-f]{12}$/.test(hostname) ? hostname : "";
}

/**
 * Read `docker inspect` of one container
 * @param id Container id
 * @returns The container, or null when Docker does not answer with one
 */
async function inspectContainer(id : string) : Promise<InspectedContainer | null> {
    const parsed = JSON.parse(await reader.inspect(id)) as InspectedContainer[];
    return parsed[0] ?? null;
}

/**
 * Who the panel is: its container and the compose project around it.
 *
 * Remembered once known. A Docker that did not answer is asked again next time, since
 * the panel may start before the daemon does. The answer is never guessed from a name:
 * a stack that happens to be called like the panel is not the panel.
 * @returns The identity, or null outside a container or when Docker does not answer
 */
export function readPanelIdentity() : Promise<PanelIdentity | null> {
    identity ??= (async () => {
        const id = findOwnContainerId(await reader.mountinfo().catch(() => ""), reader.hostname());

        if (!id) {
            return null;
        }

        try {
            const container = await inspectContainer(id);
            const labels = container?.Config?.Labels ?? {};

            return container?.Id ? { id: container.Id,
                project: labels[COMPOSE_PROJECT_LABEL] ?? "",
                service: labels[COMPOSE_SERVICE_LABEL] ?? "",
                workingDir: labels[COMPOSE_WORKING_DIR_LABEL] ?? "" } : null;
        } catch (e) {
            // Not fatal: until Docker answers, every stack is treated as a stack, as it always was
            log.debug("panelIdentity", `Cannot tell which container this panel runs in: ${e instanceof Error ? e.message : String(e)}`);
            identity = undefined;
            return null;
        }
    })();

    return identity;
}

/**
 * Whether a stack directory holds the compose project of the panel itself.
 *
 * Only the working directory Compose recorded decides: the project name can be changed
 * with `name:`, `-p` or `COMPOSE_PROJECT_NAME`, and a directory cannot be two stacks.
 * @param own Identity of the panel, null when unknown
 * @param stackPath Directory of the stack
 * @returns True when stopping this stack stops the panel
 */
export function isPanelStack(own : PanelIdentity | null, stackPath : string) : boolean {
    return own !== null && own.workingDir !== "" && path.resolve(own.workingDir) === path.resolve(stackPath);
}

/**
 * Tell the Docker socket apart from other mounts: whoever reaches it controls the host
 * @param mount One mount of the panel
 * @returns True for the Docker socket
 */
function isDockerSocket(mount : PanelMount) : boolean {
    return mount.destination === "/var/run/docker.sock" || mount.source.endsWith("/docker.sock");
}

/**
 * The registry digest of the image a container runs
 * @param imageId Image id from `docker inspect`
 * @returns The digest, or "" for a local build, which has none, and when Docker did not say
 */
async function readImageDigest(imageId : string) : Promise<string> {
    try {
        const digests = JSON.parse(await reader.imageDigests(imageId)) as string[] | null;
        return digests?.[0]?.split("@")[1] ?? "";
    } catch {
        return "";
    }
}

/**
 * The mounts of a container, with every field Docker left out empty
 * @param container Container from `docker inspect`
 * @returns Mounts
 */
function readMounts(container : InspectedContainer) : PanelMount[] {
    return (container.Mounts ?? []).map((mount) => ({
        type: mount.Type ?? "",
        source: mount.Source ?? "",
        destination: mount.Destination ?? "",
        readOnly: mount.RW === false,
    }));
}

/**
 * Describe the panel's own container for the card in "About".
 *
 * Read fresh on every request, because health, uptime and restarts change; what cannot
 * be read is reported as unknown, never as a healthy default.
 * @returns The description, or null when the panel does not run in a container Docker knows
 */
export async function describePanelContainer() : Promise<PanelContainer | null> {
    const own = await readPanelIdentity();

    if (!own) {
        return null;
    }

    const container = await inspectContainer(own.id);

    if (!container) {
        return null;
    }

    const mounts = readMounts(container);

    return {
        id: own.id,
        name: (container.Name ?? "").replace(/^\//, ""),
        project: own.project,
        service: own.service,
        workingDir: own.workingDir,
        configFiles: container.Config?.Labels?.[COMPOSE_CONFIG_FILES_LABEL] ?? "",
        image: container.Config?.Image ?? "",
        digest: await readImageDigest(container.Image ?? ""),
        state: container.State?.Status ?? "",
        health: container.State?.Health?.Status ?? "",
        startedAt: container.State?.StartedAt ?? "",
        restartCount: container.RestartCount ?? null,
        mounts,
        dockerSocket: mounts.some(isDockerSocket),
    };
}

/**
 * Replace how the panel asks Docker, and forget what it learned
 * @param replacement Reader for a test, or nothing to go back to Docker
 */
export function setOwnContainerReader(replacement? : OwnContainerReader) : void {
    reader = replacement ?? dockerReader;
    identity = undefined;
}
