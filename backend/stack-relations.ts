import { spawn } from "./child-process";
import { log } from "./log";
import { ValidationError } from "./util-server";
import { parseDockerLabels } from "../common/compose-status";
import type { RelationPort, RelationVolume, ServiceRelations, StackRelations } from "../common/types/relations";

const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
const COMPOSE_DEPENDS_ON_LABEL = "com.docker.compose.depends_on";
const SECRETS_DIR = "/run/secrets/";

/** How Docker is asked for relations; `cwd` matters to `compose config` only. Replaced in tests */
export type RelationsDocker = (args : string[], cwd? : string) => Promise<string>;

const relationsDocker : RelationsDocker = async (args, cwd) => (await spawn("docker", args, {
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
    timeoutMs: 30_000,
    ...(cwd ? { cwd } : {}),
})).stdout?.toString() ?? "";

/** What the relations of one stack are read from */
export interface RelationsTarget {
    /** Stack name, for the log */
    project : string;
    /**
     * Label that picks exactly the containers of the stack: the project directory for a
     * stack of this panel, whose file may rename the project, the project name otherwise
     */
    containerLabel : string;
    /**
     * Arguments that make Compose print the resolved model of the stack's own files, null
     * for a project the panel does not manage: its files are not read
     */
    composeConfigArgs : string[] | null;
    cwd : string;
}

type Json = Record<string, unknown>;

/**
 * @param value Anything parsed from JSON
 * @returns The value when it is a plain object, otherwise an empty one
 */
function objectOf(value : unknown) : Json {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

/**
 * @param value Anything parsed from JSON
 * @returns The value as text, empty for anything but a string or a number
 */
function textOf(value : unknown) : string {
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/**
 * Items of a list without repeats, in first-seen order
 * @param items Items that may repeat
 * @returns Unique items
 */
function unique<T>(items : readonly T[]) : T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const key = JSON.stringify(item);
        return seen.has(key) ? false : (seen.add(key), true);
    });
}

/**
 * Relations of one service in the resolved model `docker compose config --format json`
 * prints: long syntax everywhere, so each field has one shape
 * @param name Service name
 * @param service Service of the model
 * @returns Its relations, without containers
 */
export function relationsFromCompose(name : string, service : Json) : ServiceRelations {
    const dependsOn = Array.isArray(service.depends_on)
        ? service.depends_on.map((item) => ({ service: textOf(item),
            condition: "service_started" }))
        : Object.entries(objectOf(service.depends_on)).map(([ dependency, options ]) => ({ service: dependency,
            condition: textOf(objectOf(options).condition) || "service_started" }));

    const networks = Array.isArray(service.networks) ? service.networks.map(textOf) : Object.keys(objectOf(service.networks));

    const ports : RelationPort[] = (Array.isArray(service.ports) ? service.ports : []).map((raw) => {
        const port = objectOf(raw);
        return { published: textOf(port.published),
            target: textOf(port.target),
            protocol: textOf(port.protocol) || "tcp",
            hostIp: textOf(port.host_ip) };
    });

    const volumes : RelationVolume[] = (Array.isArray(service.volumes) ? service.volumes : []).map((raw) => {
        const volume = objectOf(raw);
        return { type: textOf(volume.type),
            source: textOf(volume.source),
            target: textOf(volume.target),
            readOnly: volume.read_only === true };
    });

    const secrets = (Array.isArray(service.secrets) ? service.secrets : []).map((raw) => textOf(typeof raw === "string" ? raw : objectOf(raw).source));

    return { name,
        dependsOn: dependsOn.filter((item) => item.service !== ""),
        networks: networks.filter((network) => network !== ""),
        ports,
        volumes,
        secrets: secrets.filter((secret) => secret !== ""),
        containers: [] };
}

/**
 * Relations of one container as Docker reports it. Compose records what a service waits
 * for in a label, and a secret arrives as a mount under /run/secrets
 * @param container One item of `docker inspect`
 * @returns Its service name and relations, without containers
 */
export function relationsFromContainer(container : Json) : ServiceRelations {
    const labels = objectOf(objectOf(container.Config).Labels);
    const settings = objectOf(container.NetworkSettings);

    const dependsOn = textOf(labels[COMPOSE_DEPENDS_ON_LABEL]).split(",").filter((item) => item !== "").map((item) => {
        const [ service = "", condition = "" ] = item.split(":");
        return { service,
            condition: condition || "service_started" };
    });

    const ports : RelationPort[] = Object.entries(objectOf(settings.Ports)).flatMap(([ key, bindings ]) => {
        const [ target = key, protocol = "tcp" ] = key.split("/");
        const list = Array.isArray(bindings) ? bindings.map(objectOf) : [];
        return list.length === 0
            ? [{ published: "",
                target,
                protocol,
                hostIp: "" }]
            : list.map((binding) => ({ published: textOf(binding.HostPort),
                target,
                protocol,
                hostIp: textOf(binding.HostIp) }));
    });

    const mounts = (Array.isArray(container.Mounts) ? container.Mounts : []).map(objectOf);
    const secrets = mounts.map((mount) => textOf(mount.Destination)).filter((target) => target.startsWith(SECRETS_DIR)).map((target) => target.slice(SECRETS_DIR.length));
    const volumes : RelationVolume[] = mounts.filter((mount) => !textOf(mount.Destination).startsWith(SECRETS_DIR)).map((mount) => ({
        type: textOf(mount.Type),
        source: textOf(mount.Name) || textOf(mount.Source),
        target: textOf(mount.Destination),
        readOnly: mount.RW === false,
    }));

    return { name: textOf(labels[COMPOSE_SERVICE_LABEL]),
        dependsOn,
        networks: Object.keys(objectOf(settings.Networks)).sort(),
        ports,
        volumes,
        secrets,
        containers: [] };
}

/**
 * Parse Docker's JSON output, one document or one per line
 * @param output What Docker printed
 * @returns The parsed items
 */
function parseJsonOutput(output : string) : unknown[] {
    const text = output.trim();
    if (text === "") {
        return [];
    }
    if (text.startsWith("[")) {
        return JSON.parse(text) as unknown[];
    }
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
}

/**
 * Read how the services of a stack are tied together.
 *
 * A stack of this panel is read from the model Compose resolves from its own files, so a
 * stopped service and an override file count. A project the panel does not manage is
 * read from its containers only: its files are somebody else's. Nothing here writes a
 * file, and nothing of the environment leaves the server.
 * @param target What to read
 * @param docker How Docker is asked
 * @returns Relations per service
 */
export async function readStackRelations(target : RelationsTarget, docker : RelationsDocker = relationsDocker) : Promise<StackRelations> {
    let rows : Json[];
    try {
        rows = parseJsonOutput(await docker([ "ps", "--all", "--no-trunc", "--filter", `label=${target.containerLabel}`, "--format", "json" ])).map(objectOf);
    } catch (error) {
        log.warn("stackRelations", `Cannot list the containers of ${target.project}: ${error instanceof Error ? error.message : String(error)}`);
        throw new ValidationError("relationsUnavailable");
    }
    const containers = rows.map((row) => ({ id: textOf(row.ID),
        name: textOf(row.Names),
        service: parseDockerLabels(textOf(row.Labels))[COMPOSE_SERVICE_LABEL] ?? "" }))
        .filter((row) => /^[a-f0-9]{64}$/.test(row.id))
        .sort((a, b) => a.name.localeCompare(b.name));

    let services : ServiceRelations[];
    if (target.composeConfigArgs) {
        let model : Json;
        try {
            model = objectOf(JSON.parse(await docker(target.composeConfigArgs, target.cwd)));
        } catch (error) {
            // Compose may quote interpolated values in its complaint, so only the fact is logged
            log.warn("stackRelations", `Compose did not resolve the model of ${target.project}`);
            throw new ValidationError("relationsUnavailable");
        }
        services = Object.entries(objectOf(model.services)).map(([ name, service ]) => relationsFromCompose(name, objectOf(service)));
    } else {
        const inspected = containers.length === 0 ? [] : parseJsonOutput(await docker([ "inspect", "--type", "container", ...containers.map((row) => row.id) ]).catch(() => "[]")).map(objectOf);
        const byService = new Map<string, ServiceRelations>();
        for (const item of inspected.map(relationsFromContainer)) {
            const known = byService.get(item.name);
            byService.set(item.name, known
                ? { ...known,
                    dependsOn: unique([ ...known.dependsOn, ...item.dependsOn ]),
                    networks: unique([ ...known.networks, ...item.networks ]),
                    ports: unique([ ...known.ports, ...item.ports ]),
                    volumes: unique([ ...known.volumes, ...item.volumes ]),
                    secrets: unique([ ...known.secrets, ...item.secrets ]) }
                : item);
        }
        services = [ ...byService.values() ].filter((service) => service.name !== "").sort((a, b) => a.name.localeCompare(b.name));
    }

    for (const service of services) {
        service.containers = containers.filter((row) => row.service === service.name).map(({ id, name }) => ({ id,
            name }));
    }

    return { source: target.composeConfigArgs ? "compose" : "docker",
        services };
}
