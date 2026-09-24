import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The digest a registry serves for a tag, read over the registry HTTP API.
 *
 * `docker buildx imagetools inspect` answers the same question, but the panel image
 * ships without buildx, and `docker manifest inspect` rebuilds a multi platform index
 * instead of returning it, so its digest never matches the local one. Without this,
 * every multi platform image showed "the registry did not answer" although the registry
 * answered. One HEAD request with every manifest type accepted returns exactly the
 * digest `docker pull` records in `RepoDigests`.
 */

/** Why the registry gave no digest */
export type RegistryFailure = "registryDenied" | "registryMissing" | "registryUnreachable";

export interface RegistryAnswer {
    /** Digest the registry serves, empty when it gave none */
    digest : string;
    /** Why it gave none, empty on success */
    reason : "" | RegistryFailure;
}

export interface ImageReference {
    /** Host the registry API lives on */
    host : string;
    /** Repository path, with `library/` for official Docker Hub images */
    repository : string;
    /** Tag, or the digest of a pinned reference */
    reference : string;
    /** Registry name as `docker login` stores it: docker.io for Docker Hub */
    registry : string;
}

type Fetcher = typeof fetch;

const ACCEPT = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
].join(", ");

const COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const REPOSITORY = new RegExp(`^${COMPONENT}(?:/${COMPONENT})*$`);
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;
const DOCKER_HUB = new Set([ "docker.io", "index.docker.io", "registry-1.docker.io" ]);

/** A manifest is a few kilobytes; anything far larger is not a manifest */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * Split an image reference the way Docker does.
 * @param image Image reference from the compose file
 * @returns Its parts, or null when it is not a valid reference, for example an unresolved variable
 */
export function parseImageReference(image : string) : ImageReference | null {
    let name = image.trim();
    let reference = "latest";
    const at = name.indexOf("@");

    if (at !== -1) {
        reference = name.slice(at + 1);
        name = name.slice(0, at);

        if (!DIGEST.test(reference)) {
            return null;
        }
    }

    const slash = name.indexOf("/");
    const first = slash === -1 ? "" : name.slice(0, slash);
    const hasHost = first.includes(".") || first.includes(":") || first === "localhost";
    let registry = hasHost ? first.toLowerCase() : "docker.io";
    let repository = hasHost ? name.slice(slash + 1) : name;
    const colon = repository.lastIndexOf(":");

    if (colon !== -1) {
        const tag = repository.slice(colon + 1);
        repository = repository.slice(0, colon);

        if (!TAG.test(tag)) {
            return null;
        }

        // name:tag@digest pulls the digest, as docker pull does
        if (at === -1) {
            reference = tag;
        }
    }

    if (DOCKER_HUB.has(registry)) {
        registry = "docker.io";

        if (!repository.includes("/")) {
            repository = `library/${repository}`;
        }
    }

    if (!REPOSITORY.test(repository) || !HOST.test(registry)) {
        return null;
    }

    return { host: registry === "docker.io" ? "registry-1.docker.io" : registry,
        repository,
        reference,
        registry };
}

/**
 * Credentials `docker login` stored for a registry, from the config the docker CLI reads.
 *
 * Only the plain `auths` entry is read. Credential helpers need their own programs and
 * stay with the CLI fallback.
 * @param registry Registry name as `docker login` stores it
 * @returns Base64 `user:password`, or null
 */
async function storedCredentials(registry : string) : Promise<string | null> {
    const directory = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");

    try {
        const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")) as { auths? : Record<string, { auth? : unknown }> };

        for (const [ key, entry ] of Object.entries(config.auths ?? {})) {
            const host = key.replace(/^https?:\/\//, "").split("/")[0]?.toLowerCase() ?? "";
            const name = DOCKER_HUB.has(host) ? "docker.io" : host;

            if (name === registry && typeof entry?.auth === "string" && entry.auth) {
                return entry.auth;
            }
        }
    } catch {
        // No config or an unreadable one: ask anonymously
    }

    return null;
}

/**
 * Parameters of a `WWW-Authenticate: Bearer` challenge
 * @param header Header value
 * @returns Parameters, or null when it is not a usable Bearer challenge
 */
function parseChallenge(header : string) : Record<string, string> | null {
    if (!/^bearer\s/i.test(header)) {
        return null;
    }

    const parameters : Record<string, string> = {};

    for (const match of header.slice(7).matchAll(/([A-Za-z_]+)="([^"]*)"/g)) {
        parameters[(match[1] as string).toLowerCase()] = match[2] as string;
    }

    return parameters.realm ? parameters : null;
}

/**
 * A pull token from the registry's token service.
 *
 * Credentials go only to an HTTPS realm: the realm is named by the registry, and a
 * password must not travel in plain text because a registry said so.
 * @param challenge Parameters of the challenge
 * @param repository Repository to pull
 * @param credentials Stored credentials, or null for an anonymous token
 * @param fetcher fetch implementation
 * @param signal Deadline of the whole lookup
 * @returns Token, or null when none was issued
 */
async function bearerToken(challenge : Record<string, string>, repository : string, credentials : string | null, fetcher : Fetcher, signal : AbortSignal) : Promise<string | null> {
    let realm : URL;

    try {
        realm = new URL(challenge.realm as string);
    } catch {
        return null;
    }

    if (realm.protocol !== "https:") {
        return null;
    }

    if (challenge.service) {
        realm.searchParams.set("service", challenge.service);
    }
    realm.searchParams.set("scope", challenge.scope ?? `repository:${repository}:pull`);

    const response = await fetcher(realm, { headers: credentials ? { Authorization: `Basic ${credentials}` } : {},
        signal });

    if (!response.ok) {
        return null;
    }

    const body = await response.json() as { token? : unknown; access_token? : unknown };
    const token = typeof body.token === "string" ? body.token : body.access_token;

    return typeof token === "string" && token ? token : null;
}

/**
 * Hash of a manifest body, for a registry that leaves the digest header out
 * @param response GET response
 * @returns Digest, or empty when the body is too large to be a manifest
 */
async function bodyDigest(response : Response) : Promise<string> {
    const hash = createHash("sha256");
    let size = 0;

    for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;

        if (size > MAX_MANIFEST_BYTES) {
            return "";
        }
        hash.update(chunk);
    }

    return `sha256:${hash.digest("hex")}`;
}

/**
 * Ask the registry which digest a reference points to. Nothing is downloaded but the answer.
 * @param image Image reference from the compose file
 * @param fetcher fetch implementation, injectable for tests
 * @param timeoutMs Deadline of the whole lookup
 * @returns The digest, or why there is none
 */
export async function readRegistryDigest(image : string, fetcher : Fetcher = fetch, timeoutMs = 8_000) : Promise<RegistryAnswer> {
    const unreachable : RegistryAnswer = { digest: "",
        reason: "registryUnreachable" };
    const parsed = parseImageReference(image);

    if (!parsed) {
        return unreachable;
    }

    const signal = AbortSignal.timeout(timeoutMs);
    const url = `https://${parsed.host}/v2/${parsed.repository}/manifests/${parsed.reference}`;
    const ask = (method : string, authorization : string | null) => fetcher(url, { method,
        headers: authorization ? { Accept: ACCEPT,
            Authorization: authorization } : { Accept: ACCEPT },
        signal });

    try {
        let authorization : string | null = null;
        let response = await ask("HEAD", null);

        if (response.status === 401) {
            const header = response.headers.get("www-authenticate") ?? "";
            const credentials = await storedCredentials(parsed.registry);
            const challenge = parseChallenge(header);

            if (challenge) {
                const token = await bearerToken(challenge, parsed.repository, credentials, fetcher, signal);
                authorization = token ? `Bearer ${token}` : null;
            } else if (/^basic\b/i.test(header) && credentials) {
                authorization = `Basic ${credentials}`;
            }

            if (!authorization) {
                return { digest: "",
                    reason: "registryDenied" };
            }
            response = await ask("HEAD", authorization);
        }

        if (response.status === 401 || response.status === 403) {
            return { digest: "",
                reason: "registryDenied" };
        }

        if (response.status === 404) {
            return { digest: "",
                reason: "registryMissing" };
        }

        if (!response.ok) {
            return unreachable;
        }

        const digest = response.headers.get("docker-content-digest") ?? "";

        if (DIGEST.test(digest)) {
            return { digest,
                reason: "" };
        }

        // A registry may leave the header out of HEAD; the digest is then the hash of the body
        const full = await ask("GET", authorization);
        const hashed = full.ok ? await bodyDigest(full) : "";

        return hashed ? { digest: hashed,
            reason: "" } : unreachable;
    } catch {
        return unreachable;
    }
}
