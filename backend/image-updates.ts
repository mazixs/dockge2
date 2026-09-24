import { spawn } from "./child-process";
import { log } from "./log";
import { isNewerImage, parseLocalRepoDigest, parseRemoteDigest, parseSingleManifestDigest } from "../common/image-digest";
import type { ImageUpdate } from "../common/image-source";
import { readRegistryDigest, type RegistryAnswer } from "./registry-digest";

/**
 * Asking the registry whether a newer image exists.
 *
 * This is the only place in the panel that talks to a registry, and it happens on
 * demand: the answer is a preview the owner asked for, not something the list polls.
 * Nothing is pulled and nothing is started - only manifests are read.
 */

/** One registry call must not hold the panel */
const TIMEOUT_MS = 8_000;

/**
 * How many images are asked about at once.
 *
 * Serially the wait was the sum of every image: a stack of six unreachable images
 * spent minutes before the preview said anything. In parallel it is roughly the
 * slowest one, and the limit keeps a large stack from spawning a docker process per
 * service at the same moment.
 */
const CONCURRENCY = 4;

/** Registry answers are reused for this long, so repeated presses do not hammer it */
const CACHE_MS = 10 * 60_000;

/** A failed answer is kept only briefly: a network blip must not hide an update for ten minutes */
const FAILURE_CACHE_MS = 60_000;

/**
 * How many images the cache remembers.
 *
 * The time to live decides whether an entry may be used, not whether it is still kept.
 * On a machine with many stacks the map would otherwise only ever grow, so the oldest
 * entries make way once this many images are known.
 */
const MAX_CACHE_ENTRIES = 500;

interface RemoteEntry extends RegistryAnswer {
    readAt : number;
}

/**
 * What the registry answered, and nothing else.
 *
 * Only the remote side is worth caching: it needs the network and does not change
 * between two presses. The local digest is read every time, because an update changes
 * exactly that - a cached "newer" would keep announcing the update the owner just
 * installed until the entry expired.
 */
const remoteCache = new Map<string, RemoteEntry>();

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
 * local side holds, and uses every credential helper the host has. The panel image has
 * no buildx, so the registry API is asked directly next. `docker manifest inspect` is
 * the last resort and only works for an image with a single manifest: for a multi
 * platform image the two sides are not comparable, and the answer stays unknown
 * instead of wrong.
 * @param image Image reference from the compose file
 * @param fetcher fetch implementation for the registry API
 * @returns Digest, or why there is none
 */
async function remoteDigest(image : string, fetcher : typeof fetch) : Promise<RegistryAnswer> {
    try {
        const res = await spawn("docker", [ "buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest.Digest}}" ], {
            encoding: "utf-8",
            maxBuffer: 1024 * 1024,
            timeoutMs: TIMEOUT_MS,
        });

        const digest = parseRemoteDigest(res.stdout?.toString() ?? "");

        if (digest) {
            return { digest,
                reason: "" };
        }
    } catch (e) {
        if (e instanceof Error) {
            log.debug("imageUpdates", `buildx cannot read ${image}: ${e.message}`);
        }
    }

    const answer = await readRegistryDigest(image, fetcher, TIMEOUT_MS);

    if (answer.digest) {
        return answer;
    }

    try {
        const res = await spawn("docker", [ "manifest", "inspect", "-v", image ], {
            encoding: "utf-8",
            maxBuffer: 4 * 1024 * 1024,
            timeoutMs: TIMEOUT_MS,
        });

        const digest = parseSingleManifestDigest(res.stdout?.toString() ?? "");

        if (digest) {
            return { digest,
                reason: "" };
        }
    } catch (e) {
        // A private registry without credentials or no network: the answer stays unknown
        if (e instanceof Error) {
            log.debug("imageUpdates", `Cannot read the manifest of ${image}: ${e.message}`);
        }
    }

    return { digest: "",
        reason: answer.reason || "registryUnreachable" };
}

/**
 * Ask the registry about every image of a stack.
 *
 * Images come from the compose file the server parsed itself, never from a client,
 * so nothing a browser sends can reach the command line here.
 * @param images Image references, duplicates are answered once
 * @param now Current time, injectable for tests
 * @param fetcher fetch implementation for the registry API, injectable for tests
 * @returns One answer per image, in the order they were given
 */
export type { ImageUpdate };

export async function readImageUpdates(images : readonly string[], now = Date.now(), fetcher : typeof fetch = fetch) : Promise<ImageUpdate[]> {
    const unique = [ ...new Set(images.filter((image) => image.trim() !== "")) ];
    const answers = new Map<string, ImageUpdate>();
    const queue = [ ...unique ];

    dropExpired(now);

    /**
     * Take images off the queue one by one until it is empty
     * @returns Nothing: the answers go into the shared map
     */
    const worker = async () : Promise<void> => {
        for (let image = queue.shift(); image !== undefined; image = queue.shift()) {
            const cached = remoteCache.get(image);
            const fresh = cached && now - cached.readAt < (cached.digest ? CACHE_MS : FAILURE_CACHE_MS);

            // The local digest is always read again: it is a local call, and it is the
            // side an update changes
            const [ local, remote ] = await Promise.all([
                localDigest(image),
                fresh ? Promise.resolve(cached) : remoteDigest(image, fetcher),
            ]);

            if (!fresh) {
                remember(image, remote, now);
            }

            const newer = isNewerImage(local || null, remote.digest || null);

            let reason = "";
            if (newer === null) {
                reason = local ? remote.reason || "registryUnreachable" : "notPulled";
            }

            answers.set(image, { image,
                local,
                remote: remote.digest,
                newer,
                reason });
        }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));

    return unique.map((image) => answers.get(image) as ImageUpdate);
}

/**
 * Keep what the registry answered, without letting the map grow without end
 * @param image Image reference
 * @param answer Digest the registry served, or why there is none
 * @param now Current time
 */
function remember(image : string, answer : RegistryAnswer, now : number) : void {
    remoteCache.set(image, { digest: answer.digest,
        reason: answer.reason,
        readAt: now });

    while (remoteCache.size > MAX_CACHE_ENTRIES) {
        const oldest = remoteCache.keys().next();

        if (oldest.done) {
            break;
        }

        remoteCache.delete(oldest.value);
    }
}

/**
 * Remove entries nobody may use any more, so an expired answer does not occupy memory
 * until the same image is asked about again
 * @param now Current time
 */
function dropExpired(now : number) : void {
    for (const [ image, entry ] of remoteCache) {
        if (now - entry.readAt >= CACHE_MS) {
            remoteCache.delete(image);
        }
    }
}

/**
 * Forget what the registry answered.
 *
 * Called after an operation that changed the local images: a pull brings the local side
 * up to the digest the registry served, and the cached answer from before the pull would
 * describe a comparison that no longer exists.
 * @param images Images to forget, or nothing to forget them all
 * @returns void
 */
export function clearImageUpdateCache(images? : readonly string[]) : void {
    if (!images) {
        remoteCache.clear();
        return;
    }

    for (const image of images) {
        remoteCache.delete(image);
    }
}
