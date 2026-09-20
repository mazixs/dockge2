/**
 * Where an image comes from, as far as its name can tell.
 *
 * The registry is part of the image reference, so this is reading and not guessing:
 * a name without a registry belongs to Docker Hub by Docker's own rule, and anything
 * before the first slash that looks like a host is the registry.
 */

/** What is known about one image of a stack */
export interface ImageUpdate {
    image : string;
    /** Digest the local image was pulled by, empty when it is not pulled */
    local : string;
    /** Digest the registry serves, empty when it could not be read */
    remote : string;
    /** True when the registry has another image, null when it cannot be told */
    newer : boolean | null;
    /** Why the answer is unknown: notPulled, registryUnreachable or empty */
    reason : string;
}

/** Registry of one image with a human readable name */
export interface RegistryCount {
    /** Display name: "Docker Hub", "ghcr.io", "registry.gitlab.com" */
    registry : string;
    count : number;
}

/** Hosts that deserve a name instead of their address */
const KNOWN_HOSTS : Record<string, string> = {
    "docker.io": "Docker Hub",
    "index.docker.io": "Docker Hub",
    "registry-1.docker.io": "Docker Hub",
};

/**
 * Registry of one image reference
 * @param image Image reference, for example ghcr.io/immich-app/immich-server:v1.120.1
 * @returns Display name of the registry, empty when the reference is empty
 */
export function registryOfImage(image : string) : string {
    const reference = image.trim();

    if (!reference) {
        return "";
    }

    const firstSegment = reference.split("/")[0] ?? "";
    const looksLikeHost = firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost";

    // No host in front means Docker Hub, that is how Docker itself resolves the name
    if (!reference.includes("/") || !looksLikeHost) {
        return KNOWN_HOSTS["docker.io"] as string;
    }

    const host = firstSegment.toLowerCase();
    return KNOWN_HOSTS[host] ?? host;
}

/**
 * Count how many images come from each registry, most used first.
 *
 * The stack header shows this as one chip ("ghcr.io ×2 · Docker Hub ×2"), which answers
 * "where does this stack pull from" without opening the compose file.
 * @param images Image references of the stack
 * @returns Registries with their counts
 */
export function summariseRegistries(images : readonly string[]) : RegistryCount[] {
    const counts = new Map<string, number>();

    for (const image of images) {
        const registry = registryOfImage(image);

        if (!registry) {
            continue;
        }

        counts.set(registry, (counts.get(registry) ?? 0) + 1);
    }

    return [ ...counts.entries() ]
        .map(([ registry, count ]) => ({ registry,
            count }))
        .sort((a, b) => b.count - a.count || a.registry.localeCompare(b.registry));
}
