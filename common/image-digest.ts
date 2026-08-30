/**
 * Reading image digests out of Docker output.
 *
 * The question "is there a newer image in the registry" is answered by comparing the
 * digest the local image was pulled by with the digest the registry serves for the same
 * reference. Both sides have to be the same kind of digest, and that is the catch:
 * `docker image inspect --format {{.Id}}` means different things in the two image
 * stores Docker ships (the classic one answers with the config digest, the containerd
 * one with the manifest digest), so the local side is read from `RepoDigests`, which
 * always holds what the registry served.
 */

/**
 * Digest the local image was pulled by.
 *
 * `RepoDigests` can hold entries for several repositories when the same image was
 * tagged twice, so the entry of the asked repository is taken.
 * @param raw Output of `docker image inspect --format {{json .RepoDigests}}`
 * @param image Image reference from the compose file
 * @returns Digest, or null when the image was never pulled from a registry
 */
export function parseLocalRepoDigest(raw : string, image : string) : string | null {
    let parsed : unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
        return null;
    }

    const repository = repositoryOf(image);
    const entries = parsed.filter((entry) : entry is string => typeof entry === "string");
    const own = entries.find((entry) => repositoryOf(entry) === repository) ?? entries[0];
    const digest = own?.split("@")[1] ?? "";

    return digest.startsWith("sha256:") ? digest : null;
}

/**
 * Repository part of a reference, without the tag and without the digest
 * @param reference Image reference
 * @returns Repository
 */
function repositoryOf(reference : string) : string {
    const withoutDigest = reference.split("@")[0] ?? "";
    const lastSlash = withoutDigest.lastIndexOf("/");
    const lastColon = withoutDigest.lastIndexOf(":");

    // A colon before the last slash belongs to a registry port, not to a tag
    return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

/**
 * Digest the registry serves, as `docker buildx imagetools inspect` reports it.
 * @param raw Output of `--format {{json .Manifest.Digest}}`
 * @returns Digest, or null when the answer carries none
 */
export function parseRemoteDigest(raw : string) : string | null {
    const value = raw.trim().replace(/^"|"$/g, "");
    return value.startsWith("sha256:") ? value : null;
}

/**
 * Digest of a single platform manifest, used when buildx is not available.
 *
 * Only an answer with exactly one manifest can be compared: for a multi platform image
 * the local side holds the digest of the index, and a platform digest would never match
 * it - reporting "newer" for every such image would be a lie.
 * @param raw Output of `docker manifest inspect -v`
 * @returns Digest, or null when the image has several manifests or cannot be read
 */
export function parseSingleManifestDigest(raw : string) : string | null {
    let parsed : unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    const entries = Array.isArray(parsed) ? parsed : [ parsed ];

    if (entries.length !== 1) {
        return null;
    }

    const descriptor = (entries[0] as Record<string, unknown>)?.Descriptor as Record<string, unknown> | undefined;
    const digest = descriptor?.digest;

    return typeof digest === "string" && digest.startsWith("sha256:") ? digest : null;
}

/**
 * Verdict about one image
 * @param local Digest the local image was pulled by, null when it is not pulled
 * @param remote Digest the registry serves, null when it could not be read
 * @returns True when the registry has another image, false when they match, null when unknown
 */
export function isNewerImage(local : string | null, remote : string | null) : boolean | null {
    if (!local || !remote) {
        return null;
    }

    return local !== remote;
}
