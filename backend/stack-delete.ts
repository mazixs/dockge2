import { spawn } from "./child-process";
import { COMPOSE_PROJECT_LABEL, COMPOSE_WORKING_DIR_LABEL } from "../common/compose-status";

/**
 * Find containers by the directory recorded at deployment, never by a possibly edited
 * project or container name. A failed Docker query must not look like an empty stack.
 * @param directory Absolute stack directory, identical on the host and in Dockge
 * @returns Full immutable container IDs, including stopped and partially created containers
 */
export async function readStackContainerIds(directory : string) : Promise<string[]> {
    const result = await spawn("docker", [ "ps", "--all", "--no-trunc", "--quiet",
        "--filter", `label=${COMPOSE_PROJECT_LABEL}`,
        "--filter", `label=${COMPOSE_WORKING_DIR_LABEL}=${directory}` ], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeoutMs: 30_000,
    }).catch((cause : unknown) => {
        throw new Error("stackDeleteInventoryFailed", { cause });
    });
    const output = String(result.stdout ?? "").trim();
    const ids = output ? output.split(/\s+/) : [];
    if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
        throw new Error("stackDeleteInventoryFailed");
    }
    return ids;
}

/**
 * Recover deletion when Compose cannot parse the stack. Docker labels survive broken
 * YAML, missing env files and changed project names. Named and anonymous volumes stay;
 * networks also stay because their labels do not establish directory ownership.
 * @param directory Stack directory
 * @param execute Visible Docker command runner
 */
export async function removeStackContainers(directory : string, execute : (args : string[]) => Promise<number>) : Promise<void> {
    const ids = await readStackContainerIds(directory);
    for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        for (const command of [ "stop", "rm" ]) {
            if (await execute([ command, ...batch ]) !== 0) {
                throw new Error("stackDeleteContainersFailed");
            }
        }
    }
    if ((await readStackContainerIds(directory)).length > 0) {
        throw new Error("stackDeleteContainersRemain");
    }
}
