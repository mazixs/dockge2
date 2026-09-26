import { log } from "./log";
import { readPanelIdentity } from "./own-container";
import { spawn } from "./child-process";
import {
    type ComposePsEntry,
    type ContainerInstanceStatus,
    type DockerPsRaw,
    fromDockerPs,
    parseDockerLabels,
    readComposeServices,
    readOneShotServices,
    resolveComposePsStatus,
    type StackStatusResult,
} from "../common/compose-status";
import { CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../common/util-common";
import { classifyContainerSource } from "./container-source";
import type { StandaloneContainer } from "../common/types/container";

/** State of a container Docker listed without saying what it is doing */
const UNKNOWN_STATE = "unknown";

/** One project as `docker compose ls` describes it */
export interface ComposeLsEntry {
    Name : string;
    Status : string;
    ConfigFiles? : string;
}

/**
 * What reading a status needs to know about a stack the panel manages.
 *
 * Only these three things are asked of it, so the state of the host can be read
 * without the stack object and everything it can do.
 */
export interface ProjectStack {
    readonly isManagedByDockge : boolean;
    readonly path : string;
    readonly composeYAML : string;
}

/**
 * Find the compose project of the panel's own container.
 *
 * The panel asks the daemon about the container it runs in, found by id, and reads the
 * label Compose put there. This is asked rather than assumed, because the project name
 * is the user's to change - through `name:` in the compose file, `COMPOSE_PROJECT_NAME`
 * or `-p`.
 * @returns The project name, or "" when the panel does not run in a compose project
 */
export async function readOwnProjectName() : Promise<string> {
    return (await readPanelIdentity())?.project ?? "";
}

/** What one reading of every container of the host gives */
export interface HostContainers {
    /** Compose containers by project and by working directory */
    instances : Map<string, ComposePsEntry[]>;
    /** Containers outside every compose project */
    standalone : StandaloneContainer[];
}

/**
 * Read every container of the host in a single Docker call.
 * One call keeps the 10 second status cron cheap even with many stacks; the containers
 * outside every compose project come from the same reading instead of a second one.
 * @param now Moment of the reading, what "last seen" of a standalone container records
 * @returns Compose entries and standalone containers, or null when Docker output cannot be trusted
 */
export async function readHostContainers(now = Date.now()) : Promise<HostContainers | null> {
    try {
        const res = await spawn("docker", [
            "ps",
            "--all",
            "--no-trunc",
            "--format",
            "json",
        ], {
            encoding: "utf-8",
            maxBuffer: 16 * 1024 * 1024,
            timeoutMs: 15_000,
        });

        const instances = new Map<string, ComposePsEntry[]>();
        const standalone : StandaloneContainer[] = [];

        // Docker returns JSON Lines, one container per line
        for (const line of (res.stdout?.toString() ?? "").split("\n")) {
            if (line.trim() === "") {
                continue;
            }

            const raw = JSON.parse(line) as DockerPsRaw;
            const entry = fromDockerPs(raw);

            if (!entry.project) {
                const row = toStandaloneRow(raw, now);
                if (row) {
                    standalone.push(row);
                }
                continue;
            }

            // Indexed by project and by working directory: a stack whose `.env` renames
            // the compose project is still found through its directory
            for (const key of [ entry.project, entry.workingDir ]) {
                if (!key) {
                    continue;
                }

                const list = instances.get(key) ?? [];
                list.push(entry);
                instances.set(key, list);
            }
        }

        return { instances,
            standalone };
    } catch (e) {
        if (e instanceof Error) {
            log.warn("readHostContainers", `Failed to read containers: ${e.message}`);
        }
        return null;
    }
}

/**
 * Describe a container outside every compose project for the list
 * @param raw One line of `docker ps`
 * @param now Moment of the reading
 * @returns The row, or null for a line without a full id, which nothing could be asked about
 */
function toStandaloneRow(raw : DockerPsRaw, now : number) : StandaloneContainer | null {
    if (typeof raw.ID !== "string" || !/^[a-f0-9]{64}$/.test(raw.ID)) {
        return null;
    }

    const source = classifyContainerSource(parseDockerLabels(raw.Labels), "");
    const exited = /exited\s+\((-?\d+)\)/i.exec(raw.Status ?? "")?.[1];
    const health = (raw.HealthStatus ?? "").toLowerCase();
    return {
        id: raw.ID,
        name: raw.Names ?? raw.Name ?? "",
        image: raw.Image ?? "",
        state: (raw.State ?? "").toLowerCase() || UNKNOWN_STATE,
        status: raw.Status ?? "",
        health: health === "none" ? "" : health,
        exitCode: exited === undefined ? null : Number.parseInt(exited, 10),
        source: source === "standalone" ? "standalone" : "unknown",
        lastSeen: now,
    };
}

/**
 * Read the compose projects of the host
 * @returns Projects as `docker compose ls` describes them, empty when Docker cannot be read
 */
export async function readComposeProjects() : Promise<ComposeLsEntry[]> {
    const res = await spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
        timeoutMs: 30_000,
    });

    if (!res.stdout) {
        return [];
    }

    return JSON.parse(res.stdout.toString()) as ComposeLsEntry[];
}

/**
 * Resolve the status of one compose project from the host wide container list
 * @param composeStack Entry of `docker compose ls`
 * @param instanceMap Containers grouped by project, null when Docker could not be read
 * @param stack Stack of the project, used to read its one-shot markings
 * @returns Status and issues of the project
 */
export function resolveProjectStatus(
    composeStack : ComposeLsEntry,
    instanceMap : Map<string, ComposePsEntry[]> | null,
    stack? : ProjectStack,
) : StackStatusResult & { instances : ContainerInstanceStatus[] } {
    if (!instanceMap) {
        // Docker output could not be trusted, do not claim the stack is stopped
        return { status: UNKNOWN,
            issues: [],
            instances: [] };
    }

    // The directory wins when it is known, because the project name can be overridden
    const entries = (stack?.isManagedByDockge ? instanceMap.get(stack.path) : undefined)
        ?? instanceMap.get(composeStack.Name)
        ?? [];
    const composeYAML = stack?.isManagedByDockge ? stack.composeYAML : "";

    return resolveComposePsStatus(entries, readComposeServices(composeYAML), readOneShotServices(composeYAML));
}

/**
 * Read the status of every compose project of the host.
 * Only the projects Docker knows about are answered: a stack that exists as files and
 * was never deployed is not in this list.
 * @returns Status per project name
 */
export async function readStatusList() : Promise<Map<string, number>> {
    const statusList = new Map<string, number>();
    let composeList : ComposeLsEntry[];

    try {
        composeList = await readComposeProjects();
    } catch (e) {
        if (e instanceof Error) {
            log.warn("readStatusList", "Cannot read the compose project list: " + e.message);
        }
        return statusList;
    }

    const instanceMap = (await readHostContainers())?.instances ?? null;

    for (const composeStack of composeList) {
        statusList.set(composeStack.Name, resolveProjectStatus(composeStack, instanceMap).status);
    }

    return statusList;
}

/**
 * Convert the status string from `docker compose ls` to the status number
 * Input Example: "exited(1), running(1)"
 * @param status Status column of one project
 * @returns The status the panel shows
 */
export function statusConvert(status : string) : number {
    if (status.startsWith("created")) {
        return CREATED_STACK;
    } else if (status.includes("exited")) {
        // If one of the service is exited, we consider the stack is exited
        return EXITED;
    } else if (status.startsWith("running")) {
        // If there is no exited services, there should be only running services
        return RUNNING;
    } else {
        return UNKNOWN;
    }
}
