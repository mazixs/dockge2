import { parseDockerPort } from "../../common/util-common";

/** A published port of a service, as the inspector shows it */
export interface ServicePort {
    /** Address the port is opened with */
    url : string;
    /** What is written next to the service */
    display : string;
}

/** One container of a service, as the server answered for it */
export interface ServiceInstance {
    name : string;
    state? : string;
    health? : string;
    statusText? : string;
    issue? : string | null;
}

/** What the stack list knows about a service without reading the compose file */
export interface ServiceSummary {
    name : string;
    state? : string;
    isOneShot? : boolean;
}

/** A service of the inspector: what the file declares and what Docker answers */
export interface InspectedService {
    name : string;
    image : string;
    ports : ServicePort[];
    isOneShot : boolean;
    /** State of the stack list, used while no container answers */
    summaryState : string;
    instances : ServiceInstance[];
    running : boolean;
    attention : boolean;
}

/**
 * A request from the service table to open a shell in the terminal tab.
 *
 * The moment is part of it: picking the same service twice has to count twice, and a
 * request that is equal to the last one would otherwise change nothing.
 */
export interface ShellRequest {
    serviceName : string;
    /** Shell to run, so sh and bash never share one session */
    shell : string;
    /** When the request was made */
    at : number;
}

/** A link declared through `x-dockge.urls` */
export interface DeclaredUrl {
    url : string;
    display : string;
}

/**
 * Read one port of a compose file.
 *
 * Compose writes a port in two ways: the short string form and the long map form.
 * Anything else, including a map without a target, is not a port and is dropped
 * rather than shown as an address that leads nowhere.
 * @param port Port as the compose file declares it
 * @param hostname Host the stack is reached through
 * @returns The port, or null when the declaration cannot be read
 */
export function parseServicePort(port : unknown, hostname : string) : ServicePort | null {
    let text = port;

    if (text && typeof text === "object") {
        const long = text as { target? : unknown, published? : unknown, host_ip? : unknown, protocol? : unknown };

        if (long.target === undefined) {
            return null;
        }

        const published = long.published === undefined
            ? ""
            : `${long.host_ip ? `${long.host_ip}:` : ""}${long.published}:`;

        text = `${published}${long.target}/${long.protocol || "tcp"}`;
    }

    if (typeof text !== "string" && typeof text !== "number") {
        return null;
    }

    return parseDockerPort(String(text), hostname);
}

/**
 * Describe the services of a stack.
 *
 * The compose file and Docker each know a part: the file declares services that may
 * have no container yet, and Docker answers about containers of services the file no
 * longer declares. Both are listed, because either one alone hides something the owner
 * needs to see.
 * @param config Parsed compose file, or nothing when it could not be read
 * @param statusList Containers per service, as the server answered
 * @param summary Services of the stack list, with their one-shot markings
 * @param hostname Host the stack is reached through
 * @returns One row per service, in the order the file declares them
 */
export function describeServices(
    config : { services? : Record<string, { image? : string, ports? : unknown[] }> } | null | undefined,
    statusList : Record<string, ServiceInstance[]>,
    summary : readonly ServiceSummary[],
    hostname : string,
) : InspectedService[] {
    const declared = config?.services ?? {};
    const names = [ ...new Set([ ...Object.keys(declared), ...Object.keys(statusList), ...summary.map((service) => service.name) ]) ];

    return names.map((name) => {
        const service = declared[name] ?? {};
        const known = summary.find((item) => item.name === name);
        const instances = Array.isArray(statusList[name]) ? statusList[name] : [];

        return {
            name,
            image: service.image ?? "",
            ports: (service.ports ?? []).map((port) => parseServicePort(port, hostname)).filter((port) => port !== null),
            isOneShot: known?.isOneShot ?? false,
            summaryState: known?.state ?? "unknown",
            instances,
            running: instances.some((instance) => instance.state === "running"),
            attention: instances.some((instance) => !!instance.issue),
        };
    });
}

/**
 * Read the links a stack declares through `x-dockge.urls`.
 *
 * Only http and https are shown: the panel opens these in a browser tab, and anything
 * else would either do nothing or hand the address to whatever the system registered
 * for that scheme.
 * @param config Parsed compose file, or nothing when it could not be read
 * @returns Links the interface may open, in the declared order
 */
export function readDeclaredUrls(config : { "x-dockge"? : { urls? : unknown } } | null | undefined) : DeclaredUrl[] {
    const declared = config?.["x-dockge"]?.urls;

    if (!Array.isArray(declared)) {
        return [];
    }

    return declared.flatMap((url) => {
        try {
            const parsed = new URL(String(url));

            if (![ "http:", "https:" ].includes(parsed.protocol)) {
                return [];
            }

            const pathname = parsed.pathname === "/" ? "" : parsed.pathname;

            return [{ url: String(url),
                display: parsed.host + pathname + parsed.search }];
        } catch {
            return [];
        }
    });
}
