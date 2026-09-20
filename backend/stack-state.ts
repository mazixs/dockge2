import os from "os";
import { log } from "./log";
import { spawn } from "./child-process";
import {
    COMPOSE_PROJECT_LABEL,
    type ComposePsEntry,
    type ContainerInstanceStatus,
    type DockerPsRaw,
    fromDockerPs,
    readComposeServices,
    readOneShotServices,
    resolveComposePsStatus,
    type StackStatusResult,
} from "../common/compose-status";
import { CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../common/util-common";

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

/** Asked of Docker once, then remembered: the project name cannot change while the panel runs */
let ownProjectName : string | null = null;

/**
 * Tell a hostname Docker generated from one someone chose.
 *
 * A container whose `hostname:` was not set is named after its own short id, which is
 * exactly twelve hexadecimal characters. Anything else - a name from the compose file,
 * or the host's own name outside a container - must not be inspected: the daemon would
 * happily answer about whatever else goes by that name.
 * @param hostname Hostname of this process
 * @returns True when the name is a short container id
 */
export function looksLikeContainerId(hostname : string) : boolean {
    return /^[0-9a-f]{12}$/.test(hostname);
}

/**
 * Find the compose project of the panel's own container.
 *
 * Docker names a container's host after its short id, so the panel can ask the
 * daemon about itself and read the label Compose put there. This is asked rather
 * than assumed, because the project name is the user's to change - through
 * `name:` in the compose file, `COMPOSE_PROJECT_NAME` or `-p`.
 * @returns The project name, or "" when the panel does not run in a compose project
 */
export async function readOwnProjectName() : Promise<string> {
    if (ownProjectName !== null) {
        return ownProjectName;
    }

    ownProjectName = "";

    try {
        const hostname = os.hostname();

        if (!looksLikeContainerId(hostname)) {
            return ownProjectName;
        }

        const res = await spawn("docker", [
            "inspect",
            "--format",
            `{{index .Config.Labels "${COMPOSE_PROJECT_LABEL}"}}`,
            hostname,
        ], {
            encoding: "utf-8",
            maxBuffer: 64 * 1024,
            timeoutMs: 15_000,
        });

        ownProjectName = (res.stdout?.toString() ?? "").trim();
    } catch (e) {
        // Not fatal: without an answer the panel simply lists its own project, which
        // is what it did before this was asked at all
        if (e instanceof Error) {
            log.debug("readOwnProjectName", `Cannot tell which project this panel runs as: ${e.message}`);
        }
    }

    return ownProjectName;
}

/**
 * Read every compose managed container of the host in a single Docker call.
 * One call keeps the 10 second status cron cheap even with many stacks.
 * @returns Entries grouped by compose project, or null when Docker output cannot be trusted
 */
export async function readInstanceMap() : Promise<Map<string, ComposePsEntry[]> | null> {
    try {
        const res = await spawn("docker", [
            "ps",
            "--all",
            "--filter",
            `label=${COMPOSE_PROJECT_LABEL}`,
            "--format",
            "json",
        ], {
            encoding: "utf-8",
            maxBuffer: 4 * 1024 * 1024,
            timeoutMs: 15_000,
        });

        if (!res.stdout) {
            return new Map();
        }

        const map = new Map<string, ComposePsEntry[]>();

        // Docker returns JSON Lines, one container per line
        for (const line of res.stdout.toString().split("\n")) {
            if (line.trim() === "") {
                continue;
            }

            const entry = fromDockerPs(JSON.parse(line) as DockerPsRaw);

            // Indexed by project and by working directory: a stack whose `.env` renames
            // the compose project is still found through its directory
            for (const key of [ entry.project, entry.workingDir ]) {
                if (!key) {
                    continue;
                }

                const list = map.get(key) ?? [];
                list.push(entry);
                map.set(key, list);
            }
        }

        return map;
    } catch (e) {
        if (e instanceof Error) {
            log.warn("readInstanceMap", `Failed to read containers: ${e.message}`);
        }
        return null;
    }
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

    const instanceMap = await readInstanceMap();

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
