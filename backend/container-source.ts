import path from "node:path";
import { spawn } from "./child-process";
import { log } from "./log";
import { readPanelIdentity } from "./own-container";
import { ValidationError } from "./util-server";
import { COMPOSE_PROJECT_LABEL, COMPOSE_WORKING_DIR_LABEL } from "../common/compose-status";
import {
    CONTAINER_ACTIONS,
    type ContainerAction,
    type ContainerDetails,
    type ContainerSource,
    type StandaloneContainer,
} from "../common/types/container";

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const COMPOSE_LABEL_PREFIX = "com.docker.compose.";
const CONTAINER_ID = /^[a-f0-9]{64}$/;

/** How the panel asks Docker here; replaced in tests */
export type DockerCall = (args : string[]) => Promise<string>;

const dockerCall : DockerCall = async (args) => (await spawn("docker", args, {
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
    timeoutMs: 120_000,
})).stdout?.toString() ?? "";

/**
 * Tell where a container comes from by the labels Compose writes.
 *
 * A name tells nothing: anybody can call a container `web-1`. A project counts as managed
 * only when Compose recorded a directory that lies directly in the stacks directory,
 * which is what makes it a stack of this panel.
 * @param labels Labels of the container, null when they could not be read
 * @param stacksDir Stacks directory of this panel
 * @returns The source
 */
export function classifyContainerSource(labels : Record<string, string> | null, stacksDir : string) : ContainerSource {
    if (!labels) {
        return "unknown";
    }
    if (!Object.keys(labels).some((key) => key.startsWith(COMPOSE_LABEL_PREFIX))) {
        return "standalone";
    }

    const workingDir = labels[COMPOSE_WORKING_DIR_LABEL] ?? "";
    if (!labels[COMPOSE_PROJECT_LABEL] || !labels[COMPOSE_SERVICE_LABEL] || !path.isAbsolute(workingDir)) {
        return "unknown";
    }

    return stacksDir !== "" && path.dirname(path.resolve(workingDir)) === path.resolve(stacksDir) ? "managed" : "external-compose";
}

/**
 * The containers outside every compose project, as the last Docker reading saw them.
 *
 * Kept by the server between readings, so that a Docker that stops answering turns the
 * rows unknown instead of making them disappear, and "last seen" stays true.
 */
export class StandaloneInventory {
    private rows : StandaloneContainer[] = [];

    /**
     * Take what Docker just said; a container that is gone from it was removed
     * @param rows Containers of a successful reading
     */
    observe(rows : readonly StandaloneContainer[]) : void {
        this.rows = [ ...rows ].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Docker did not answer: keep what was seen, but stop claiming its state */
    lose() : void {
        this.rows = this.rows.map((row) => ({ ...row,
            state: "unknown",
            status: "",
            health: "",
            exitCode: null }));
    }

    /**
     * The rows to send
     * @returns Containers in order of their names
     */
    list() : StandaloneContainer[] {
        return this.rows;
    }
}

/** The part of `docker inspect` the container page reads */
interface InspectedContainer {
    Id? : string;
    Name? : string;
    RestartCount? : number;
    Config? : { Image? : string; Labels? : Record<string, string> | null };
    State? : { Status? : string; StartedAt? : string; FinishedAt? : string; ExitCode? : number; Health? : { Status? : string } };
    Mounts? : { Type? : string; Source? : string; Destination? : string; RW? : boolean }[];
    NetworkSettings? : {
        Ports? : Record<string, { HostIp? : string; HostPort? : string }[] | null> | null;
        Networks? : Record<string, unknown> | null;
    };
}

/**
 * The ports of a container, published or only exposed
 * @param ports `NetworkSettings.Ports` of `docker inspect`
 * @returns One row per host binding, and one with an empty host for an exposed port
 */
function readPorts(ports : NonNullable<InspectedContainer["NetworkSettings"]>["Ports"]) : ContainerDetails["ports"] {
    return Object.entries(ports ?? {}).flatMap(([ container, bindings ]) => bindings?.length
        ? bindings.map((binding) => ({ container,
            host: `${binding.HostIp ?? ""}:${binding.HostPort ?? ""}` }))
        : [{ container,
            host: "" }]);
}

/**
 * Read one container for its page.
 *
 * Asked only when the page opens: the list lives on `docker ps`, and inspecting every
 * container of a host every ten seconds is what the list must not cost.
 * @param id Full container id
 * @param stacksDir Stacks directory of this panel
 * @param docker How Docker is asked
 * @returns What the page shows
 * @throws {ValidationError} If the id is not a full id or Docker knows no such container
 */
export async function inspectContainer(id : unknown, stacksDir : string, docker : DockerCall = dockerCall) : Promise<ContainerDetails> {
    if (typeof id !== "string" || !CONTAINER_ID.test(id)) {
        throw new ValidationError("containerNotFound");
    }

    let container : InspectedContainer | undefined;
    try {
        container = (JSON.parse(await docker([ "inspect", "--type", "container", id ])) as InspectedContainer[])[0];
    } catch {
        container = undefined;
    }
    if (!container || container.Id !== id) {
        throw new ValidationError("containerNotFound");
    }

    return {
        ...describeInspected(container, stacksDir),
        id,
        panel: (await readPanelIdentity())?.id === id,
    };
}

/**
 * @param state `State` of `docker inspect`
 * @returns How the container runs, and how it last ended
 */
function readState(state : NonNullable<InspectedContainer["State"]>) : Pick<ContainerDetails, "state" | "health" | "startedAt" | "finishedAt" | "exitCode"> {
    return {
        state: state.Status ?? "",
        health: state.Health?.Status ?? "",
        startedAt: state.StartedAt ?? "",
        finishedAt: state.FinishedAt ?? "",
        exitCode: state.ExitCode ?? null,
    };
}

/**
 * What the page shows of one container, read from `docker inspect`
 * @param container The container as Docker described it
 * @param stacksDir Stacks directory of this panel
 * @returns Everything but the id and whether it is the panel itself
 */
function describeInspected(container : InspectedContainer, stacksDir : string) : Omit<ContainerDetails, "id" | "panel"> {
    const labels = container.Config?.Labels ?? {};

    return {
        name: (container.Name ?? "").replace(/^\//, ""),
        image: container.Config?.Image ?? "",
        source: classifyContainerSource(labels, stacksDir),
        project: labels[COMPOSE_PROJECT_LABEL] ?? "",
        service: labels[COMPOSE_SERVICE_LABEL] ?? "",
        workingDir: labels[COMPOSE_WORKING_DIR_LABEL] ?? "",
        ...readState(container.State ?? {}),
        restartCount: container.RestartCount ?? null,
        ports: readPorts(container.NetworkSettings?.Ports),
        mounts: (container.Mounts ?? []).map((mount) => ({
            type: mount.Type ?? "",
            source: mount.Source ?? "",
            destination: mount.Destination ?? "",
            readOnly: mount.RW === false,
        })),
        networks: Object.keys(container.NetworkSettings?.Networks ?? {}).sort(),
    };
}

/**
 * Whether an action is one the container page may run
 * @param action What the caller asked for
 * @returns True for start, stop and restart
 */
export function isContainerAction(action : unknown) : action is ContainerAction {
    return typeof action === "string" && (CONTAINER_ACTIONS as readonly string[]).includes(action);
}

/**
 * Start, stop or restart a container the panel does not manage.
 *
 * The container is read again right before the command, so the decision is made on its
 * labels as they are now. A managed container belongs to its stack and goes through the
 * stack's own actions; a container whose labels cannot be read is refused rather than
 * guessed at; the panel's own container is never touched from here.
 * @param id Full container id
 * @param action What to do
 * @param stacksDir Stacks directory of this panel
 * @param docker How Docker is asked
 * @returns The container as it was read before the command
 * @throws {ValidationError} If the action or the container is not one this may touch
 */
export async function controlContainer(id : unknown, action : unknown, stacksDir : string, docker : DockerCall = dockerCall) : Promise<ContainerDetails> {
    if (!isContainerAction(action)) {
        throw new ValidationError("containerActionInvalid");
    }

    const container = await inspectContainer(id, stacksDir, docker);
    if (container.panel) {
        throw new ValidationError("stackIsPanel");
    }
    if (container.source !== "external-compose" && container.source !== "standalone") {
        throw new ValidationError("containerNotControllable");
    }

    try {
        await docker([ action, container.id ]);
    } catch (e) {
        // What Docker said stays in the server log: the page names the action that failed
        log.warn("controlContainer", `docker ${action} ${container.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        throw new Error("containerActionFailed", { cause: e });
    }
    return container;
}
