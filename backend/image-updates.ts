import { spawn } from "./child-process";
import { log } from "./log";
import { isNewerImage, parseLocalRepoDigest, parseRemoteDigest, parseSingleManifestDigest } from "../common/image-digest";

/**
 * Asking the registry whether a newer image exists.
 *
 * This is the only place in the panel that talks to a registry, and it happens on
 * demand: the answer is a preview the owner asked for, not something the list polls.
 * Nothing is pulled and nothing is started - only manifests are read.
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

/** One registry call must not hold the panel */
const TIMEOUT_MS = 20_000;

/** Answers are reused for this long, so repeated presses do not hammer the registry */
const CACHE_MS = 10 * 60_000;

interface CacheEntry {
    update : ImageUpdate;
    readAt : number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Digest the local image was pulled by
 * @param image Image reference from the compose file
 * @returns Digest, or empty when the image is not pulled
 */
async function localDigest(image : string) : Promise<string> {
    try {
        const res = await spawn("docker", [ "image", "inspect", image, "--format", "{{json .RepoDigests}}" ], {
            encoding: "utf-8",
            timeoutMs: 10_000,
        });

        return parseLocalRepoDigest(res.stdout?.toString() ?? "", image) ?? "";
    } catch {
        // Not pulled yet is a normal answer, not an error worth logging
        return "";
    }
}

/**
 * Digest the registry serves for the same reference.
 *
 * `buildx imagetools` answers with the digest of the index, which is exactly what the
 * local side holds. Without buildx there is a fallback that only works for an image with
 * a single manifest: for a multi platform image the two sides are not comparable, and
 * the answer stays unknown instead of wrong.
 * @param image Image reference from the compose file
 * @returns Digest, or empty when the registry could not be read
 */
async function remoteDigest(image : string) : Promise<string> {
    try {
        const res = await spawn("docker", [ "buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest.Digest}}" ], {
            encoding: "utf-8",
            maxBuffer: 1024 * 1024,
            timeoutMs: TIMEOUT_MS,
        });

        const digest = parseRemoteDigest(res.stdout?.toString() ?? "");

        if (digest) {
            return digest;
        }
    } catch (e) {
        if (e instanceof Error) {
            log.debug("imageUpdates", `buildx cannot read ${image}: ${e.message}`);
        }
    }

    try {
        const res = await spawn("docker", [ "manifest", "inspect", "-v", image ], {
            encoding: "utf-8",
            maxBuffer: 4 * 1024 * 1024,
            timeoutMs: TIMEOUT_MS,
        });

        return parseSingleManifestDigest(res.stdout?.toString() ?? "") ?? "";
    } catch (e) {
        // A private registry without credentials or no network: the answer stays unknown
        if (e instanceof Error) {
            log.debug("imageUpdates", `Cannot read the manifest of ${image}: ${e.message}`);
        }
        return "";
    }
}

/**
 * Ask the registry about every image of a stack.
 *
 * Images come from the compose file the server parsed itself, never from a client,
 * so nothing a browser sends can reach the command line here.
 * @param images Image references, duplicates are answered once
 * @param now Current time, injectable for tests
 * @returns One answer per image, in the order they were given
 */
export async function readImageUpdates(images : readonly string[], now = Date.now()) : Promise<ImageUpdate[]> {
    const unique = [ ...new Set(images.filter((image) => image.trim() !== "")) ];
    const answers = new Map<string, ImageUpdate>();

    for (const image of unique) {
        const cached = cache.get(image);

        if (cached && now - cached.readAt < CACHE_MS) {
            answers.set(image, cached.update);
            continue;
        }

        const [ local, remote ] = await Promise.all([ localDigest(image), remoteDigest(image) ]);
        const newer = isNewerImage(local || null, remote || null);

        let reason = "";
        if (newer === null) {
            reason = local ? "registryUnreachable" : "notPulled";
        }

        const update : ImageUpdate = { image,
            local,
            remote,
            newer,
            reason };

        cache.set(image, { update,
            readAt: now });
        answers.set(image, update);
    }

    return unique.map((image) => answers.get(image) as ImageUpdate);
}

/**
 * Forget cached answers, used after an update actually pulled new images
 * @returns void
 */
export function clearImageUpdateCache() : void {
    cache.clear();
}
