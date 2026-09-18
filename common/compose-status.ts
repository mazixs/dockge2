import yaml from "yaml";
import { ATTENTION, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "./util-common";

/**
 * Raw entry of `docker compose ps --all --format json`.
 * Every field is optional because Docker versions differ and output can be truncated.
 */
export interface ComposePsEntry {
    Service? : string;
    Name? : string;
    State? : string;
    Health? : string;
    ExitCode? : number | string;
    Status? : string;
    Labels? : string;
}

export interface ContainerInstanceStatus {
    service : string;
    name : string;
    /** Normalised lowercase Docker state, empty when it could not be read */
    state : string;
    /** Normalised lowercase health, empty when the container has no health check */
    health : string;
    exitCode : number | null;
    statusText : string;
    isOneShot : boolean;
    /** Reason why this instance needs attention, null when it is fine */
    issue : string | null;
}

export interface StackStatusIssue {
    service : string;
    name : string;
    reason : string;
    detail? : string;
}

export interface StackStatusResult {
    status : number;
    issues : StackStatusIssue[];
}

/**
 * Raw entry of `docker ps --all --format json`, which is used for the whole host at once.
 * It has no Service, Health or ExitCode field, so those are derived from labels and the status text.
 */
export interface DockerPsRaw {
    State? : string;
    Status? : string;
    HealthStatus? : string;
    Labels? : string;
    Name? : string;
    Names? : string;
}

/**
 * Compose extension that marks a service as a one-shot worker or init container.
 * Written as `x-dockge: { lifecycle: one-shot }` or `x-dockge.lifecycle: one-shot` in the service.
 */
export const ONE_SHOT_EXTENSION = "x-dockge";
export const ONE_SHOT_VALUE = "one-shot";

/** Container label with the same meaning, for stacks that were not created by Dockge */
export const ONE_SHOT_LABEL = "dockge.lifecycle";

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
export const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

/** Directory the compose project was started from, stable even when the project is renamed */
export const COMPOSE_WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

const KNOWN_STATES = [ "running", "exited", "created", "restarting", "paused", "dead", "removing" ];

/**
 * Reasons that mean the stack is degraded rather than simply stopped
 */
const ATTENTION_REASONS = new Set([
    "unhealthy",
    "restarting",
    "paused",
    "dead",
    "removing",
    "unknownState",
    "missingInstance",
    "notStarted",
    // A failed or unreadable exit is reported as an issue, but a stack whose services are
    // all gone stays EXITED: that is what the requirements ask for, and EXITED is not a
    // calmer state than ATTENTION, it is the red one.
]);

/**
 * Parse the `Labels` field of Docker output, which is a comma separated `key=value` list
 * @param labels Raw labels
 * @returns Parsed labels
 */
export function parseDockerLabels(labels : string | undefined) : Record<string, string> {
    const result : Record<string, string> = {};

    if (!labels) {
        return result;
    }

    for (const pair of labels.split(",")) {
        const index = pair.indexOf("=");
        if (index <= 0) {
            continue;
        }
        result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }

    return result;
}

/**
 * Read the exit code of a container, preferring the explicit field over the status text
 * @param entry Compose ps entry
 * @returns Exit code, or null when the container exited and the code is unreadable
 */
function readExitCode(entry : ComposePsEntry) : number | null {
    if (typeof entry.ExitCode === "number" && Number.isInteger(entry.ExitCode)) {
        return entry.ExitCode;
    }

    if (typeof entry.ExitCode === "string" && /^-?\d+$/.test(entry.ExitCode.trim())) {
        return Number.parseInt(entry.ExitCode, 10);
    }

    const match = /exited\s+\((-?\d+)\)/i.exec(entry.Status ?? "");
    if (match?.[1] !== undefined) {
        return Number.parseInt(match[1], 10);
    }

    return null;
}

/**
 * Normalise the health field, which is empty in Compose output and "none" in `docker ps` output
 * @param health Raw health value
 * @returns Normalised health, empty when the container has no health check
 */
function normaliseHealth(health : string | undefined) : string {
    const value = (health ?? "").trim().toLowerCase();
    return value === "none" ? "" : value;
}

/**
 * Convert a `docker ps` entry into the Compose shaped entry used by the aggregator
 * @param raw Entry of `docker ps --all --format json`
 * @returns Compose shaped entry plus the compose project it belongs to
 */
export function fromDockerPs(raw : DockerPsRaw) : ComposePsEntry & { project : string, workingDir : string } {
    const labels = parseDockerLabels(raw.Labels);

    const entry : ComposePsEntry & { project : string, workingDir : string } = {
        project: labels[COMPOSE_PROJECT_LABEL] ?? "",
        workingDir: labels[COMPOSE_WORKING_DIR_LABEL] ?? "",
        Service: labels[COMPOSE_SERVICE_LABEL] ?? "",
        Name: raw.Name ?? raw.Names ?? "",
        Labels: raw.Labels ?? "",
    };

    if (raw.State !== undefined) {
        entry.State = raw.State;
    }
    if (raw.Status !== undefined) {
        entry.Status = raw.Status;
    }
    const health = normaliseHealth(raw.HealthStatus);
    if (health !== "") {
        entry.Health = health;
    }

    return entry;
}

/**
 * Read the services of a compose file that finish rather than keep running.
 *
 * Besides the explicit markings, one thing in a compose file says so on its own:
 * `depends_on` with `condition: service_completed_successfully`. A service is only
 * ever waited on that way because it is expected to do its work and exit, which is
 * exactly what a migration or a seeding job does. Without reading it, such a job
 * showed up as a stopped service the moment it succeeded, and the panel offered to
 * restart the thing that had just done its job correctly.
 * @param composeYAML Compose file content
 * @returns Service names that are not expected to keep running
 */
export function readOneShotServices(composeYAML : string) : Set<string> {
    const oneShot = new Set<string>();

    let parsed : unknown;
    try {
        parsed = yaml.parse(composeYAML);
    } catch (e) {
        return oneShot;
    }

    const services = (parsed as { services? : Record<string, unknown> } | null)?.services;
    if (!services || typeof services !== "object") {
        return oneShot;
    }

    for (const [ name, rawService ] of Object.entries(services)) {
        const service = rawService as Record<string, unknown> | null;
        if (!service || typeof service !== "object") {
            continue;
        }

        // x-dockge: { lifecycle: one-shot }
        const extension = service[ONE_SHOT_EXTENSION] as { lifecycle? : unknown } | undefined;
        if (extension && typeof extension === "object" && extension.lifecycle === ONE_SHOT_VALUE) {
            oneShot.add(name);
            continue;
        }

        // x-dockge.lifecycle: one-shot written as a flat key
        if (service[`${ONE_SHOT_EXTENSION}.lifecycle`] === ONE_SHOT_VALUE) {
            oneShot.add(name);
            continue;
        }

        // dockge.lifecycle: one-shot as a container label
        const labels = service["labels"];
        if (labels && typeof labels === "object" && !Array.isArray(labels)) {
            if ((labels as Record<string, unknown>)[ONE_SHOT_LABEL] === ONE_SHOT_VALUE) {
                oneShot.add(name);
            }
        } else if (Array.isArray(labels) && labels.includes(`${ONE_SHOT_LABEL}=${ONE_SHOT_VALUE}`)) {
            oneShot.add(name);
        }
    }

    // Whatever anything waits on with `service_completed_successfully` is a job by
    // definition: nothing waits that way for a service meant to stay up
    for (const rawService of Object.values(services)) {
        const dependsOn = (rawService as { depends_on? : unknown } | null)?.depends_on;

        if (!dependsOn || typeof dependsOn !== "object" || Array.isArray(dependsOn)) {
            continue;
        }

        for (const [ name, rawCondition ] of Object.entries(dependsOn as Record<string, unknown>)) {
            const condition = (rawCondition as { condition? : unknown } | null)?.condition;

            if (condition === "service_completed_successfully" && name in services) {
                oneShot.add(name);
            }
        }
    }

    return oneShot;
}

/**
 * Read the service names declared in a compose file
 * @param composeYAML Compose file content
 * @returns Declared service names
 */
export function readComposeServices(composeYAML : string) : string[] {
    try {
        const parsed = yaml.parse(composeYAML) as { services? : Record<string, unknown> } | null;
        const services = parsed?.services;
        if (!services || typeof services !== "object") {
            return [];
        }
        return Object.keys(services);
    } catch (e) {
        return [];
    }
}

/**
 * Normalise one `docker compose ps` entry into a typed instance status.
 * Unknown values are never promoted to a healthy state.
 * @param entry Compose ps entry
 * @param oneShotServices Services marked as one-shot in the compose file
 * @returns Typed instance status
 */
export function normaliseInstance(entry : ComposePsEntry, oneShotServices : ReadonlySet<string> = new Set()) : ContainerInstanceStatus {
    const labels = parseDockerLabels(entry.Labels);
    const state = (entry.State ?? "").trim().toLowerCase();
    const health = normaliseHealth(entry.Health);
    const exitCode = readExitCode(entry);
    const service = entry.Service ?? labels[COMPOSE_SERVICE_LABEL] ?? "";
    const isOneShot = labels[ONE_SHOT_LABEL] === ONE_SHOT_VALUE || oneShotServices.has(service);

    const instance : ContainerInstanceStatus = {
        service,
        name: entry.Name ?? "",
        state,
        health,
        exitCode,
        statusText: entry.Status ?? "",
        isOneShot,
        issue: null,
    };

    instance.issue = resolveInstanceIssue(instance);

    return instance;
}

/**
 * Decide whether a single instance is a problem, and why
 * @param instance Normalised instance
 * @returns Issue reason, or null when the instance is fine
 */
export function resolveInstanceIssue(instance : ContainerInstanceStatus) : string | null {
    if (!KNOWN_STATES.includes(instance.state)) {
        return "unknownState";
    }

    switch (instance.state) {
        case "running":
            return instance.health === "unhealthy" ? "unhealthy" : null;

        case "restarting":
            return "restarting";

        case "paused":
            return "paused";

        case "dead":
            return "dead";

        case "removing":
            return "removing";

        case "exited":
            if (instance.exitCode === null) {
                return "unknownExitCode";
            }
            if (instance.exitCode !== 0) {
                return instance.isOneShot ? "workerFailed" : "serviceFailed";
            }
            // A clean one-shot exit is the expected end of a worker or init container
            return instance.isOneShot ? null : "serviceStopped";

        case "created":
            // Created but never started. Alone it means the stack is only created,
            // next to a running service it is a service that failed to come up.
            return "notStarted";

        default:
            return null;
    }
}

/**
 * Aggregate instances into a stack status with the reasons behind it.
 * RUNNING means at least one service of the stack is up and nothing about the stack
 * is degraded: every issue found on any instance turns the stack into ATTENTION.
 * @param instances Normalised instances of the stack
 * @param expectedServices Services declared in the compose file, used to detect missing instances
 * @returns Stack status and the list of issues explaining it
 */
export function resolveStackStatus(
    instances : readonly ContainerInstanceStatus[],
    expectedServices : readonly string[] = [],
) : StackStatusResult {
    const issues : StackStatusIssue[] = [];

    // A stack that was never started has no containers at all, so a missing instance is
    // only worth reporting when the rest of the stack is up
    const stackIsUp = instances.some((instance) => instance.state === "running");

    if (stackIsUp) {
        for (const service of expectedServices) {
            if (!instances.some((instance) => instance.service === service)) {
                issues.push({ service,
                    name: "",
                    reason: "missingInstance" });
            }
        }
    }

    if (instances.length === 0) {
        // Nothing to judge, do not claim the stack is stopped
        return { status: UNKNOWN,
            issues };
    }

    let hasRunningLongLived = false;
    let hasRunningOneShot = false;
    let allCreated = true;

    for (const instance of instances) {
        if (instance.state !== "created") {
            allCreated = false;
        }

        if (instance.state === "running" && instance.health !== "unhealthy") {
            if (instance.isOneShot) {
                hasRunningOneShot = true;
            } else {
                hasRunningLongLived = true;
            }
        }

        if (instance.issue) {
            const issue : StackStatusIssue = {
                service: instance.service,
                name: instance.name,
                reason: instance.issue,
            };

            if (instance.exitCode !== null && (instance.issue === "workerFailed" || instance.issue === "serviceFailed")) {
                issue.detail = String(instance.exitCode);
            }

            issues.push(issue);
        }
    }

    if (allCreated) {
        // Nothing was started yet, that is the created state and not a problem on its own
        return { status: CREATED_STACK,
            issues: issues.filter((issue) => issue.reason !== "notStarted") };
    }

    if (hasRunningLongLived) {
        return { status: issues.length > 0 ? ATTENTION : RUNNING,
            issues };
    }

    // A stack whose only services are one-shot jobs is running while a job runs
    if (hasRunningOneShot) {
        return { status: issues.length > 0 ? ATTENTION : RUNNING,
            issues };
    }

    if (issues.some((issue) => ATTENTION_REASONS.has(issue.reason))) {
        return { status: ATTENTION,
            issues };
    }

    return { status: EXITED,
        issues };
}

/**
 * Normalise and aggregate raw Docker output in one step
 * @param entries Raw compose ps entries
 * @param expectedServices Services declared in the compose file
 * @param oneShotServices Services marked as one-shot in the compose file
 * @returns Instances and the resulting stack status
 */
export function resolveComposePsStatus(
    entries : readonly ComposePsEntry[],
    expectedServices : readonly string[] = [],
    oneShotServices : ReadonlySet<string> = new Set(),
) : StackStatusResult & { instances : ContainerInstanceStatus[] } {
    const instances = entries.map((entry) => normaliseInstance(entry, oneShotServices));
    const result = resolveStackStatus(instances, expectedServices);

    return { ...result,
        instances };
}

/** One service of a stack as the list row shows it */
export interface ServiceSummary {
    name : string;
    /** running | attention | stopped | unknown */
    state : string;
    isOneShot : boolean;
}

/**
 * Summarise every service of a stack for the list row.
 *
 * The row shows one chip per service, so the state has to be judged per service and
 * fail closed: an unreadable or missing container never counts as running. Services
 * keep the order of the compose file, and containers of services the file does not
 * declare are appended - hiding them would misrepresent what runs on the host.
 * @param instances Containers of this stack, already normalised
 * @param expectedServices Services declared in the compose file, in file order
 * @param oneShotServices Services marked as one-shot jobs
 * @returns One entry per service
 */
export function summariseServices(
    instances : readonly ContainerInstanceStatus[],
    expectedServices : readonly string[] = [],
    oneShotServices : ReadonlySet<string> = new Set(),
) : ServiceSummary[] {
    const extra = instances
        .map((instance) => instance.service)
        .filter((service) => service && !expectedServices.includes(service));

    const names = [ ...expectedServices, ...new Set(extra) ];

    return names.map((name) => {
        const own = instances.filter((instance) => instance.service === name);
        const isOneShot = oneShotServices.has(name) || own.some((instance) => instance.isOneShot);

        // Nothing to judge: a stack without containers was never started, and a service
        // without containers inside a running stack is stopped, not healthy
        if (own.length === 0) {
            return { name,
                state: instances.length === 0 ? "unknown" : "stopped",
                isOneShot };
        }

        // Output that cannot be read is unknown, not broken: the stack chip says the
        // same, and calling it attention would invent a problem nobody can act on
        if (own.every((instance) => instance.issue === "unknownState")) {
            return { name,
                state: "unknown",
                isOneShot };
        }

        if (own.some((instance) => instance.issue)) {
            return { name,
                state: "attention",
                isOneShot };
        }

        if (own.some((instance) => instance.state === "running" && instance.health !== "unhealthy")) {
            return { name,
                state: "running",
                isOneShot };
        }

        return { name,
            state: "stopped",
            isOneShot };
    });
}

/**
 * Read the image references a compose file declares.
 *
 * Only images that are written in the file are returned: a service built from a
 * Dockerfile has no registry answer to give, and inventing one would be a lie.
 * @param composeYAML Compose file content
 * @returns Image references in file order, without duplicates
 */
export function readComposeImages(composeYAML : string) : string[] {
    try {
        const parsed = yaml.parse(composeYAML) as { services? : Record<string, { image? : unknown }> } | null;
        const services = parsed?.services;

        if (!services || typeof services !== "object") {
            return [];
        }

        const images = Object.values(services)
            .map((service) => (typeof service?.image === "string" ? service.image.trim() : ""))
            .filter((image) => image !== "");

        return [ ...new Set(images) ];
    } catch (e) {
        return [];
    }
}

/**
 * Whether the stack builds any of its images itself.
 *
 * A built image is not a registry answer but a local artefact, and `compose up`
 * reuses it as long as it exists: an edited Dockerfile or source tree changes
 * nothing until the build is asked for. Knowing this about a stack is what lets
 * deployment ask for it.
 * @param composeYAML Compose file content
 * @returns True when at least one service declares `build`
 */
export function hasBuildServices(composeYAML : string) : boolean {
    try {
        const parsed = yaml.parse(composeYAML) as { services? : Record<string, { build? : unknown }> } | null;
        const services = parsed?.services;

        if (!services || typeof services !== "object") {
            return false;
        }

        return Object.values(services).some((service) => {
            const build = service?.build;
            return typeof build === "string" ? build.trim() !== "" : build !== null && typeof build === "object";
        });
    } catch (e) {
        return false;
    }
}
