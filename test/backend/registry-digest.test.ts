import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseImageReference, readRegistryDigest } from "../../backend/registry-digest";

const INDEX = "sha256:1bf2daa3ccb93775da778335a17dc9792284b1ef18e6fc38fe1ee598c978c855";

interface Call {
    url : string;
    method : string;
    headers : Record<string, string>;
}

/**
 * A registry the test scripts. No request leaves the process.
 * @param answer Response for each request, by method and URL
 * @returns fetch stand-in and the calls it received
 */
function registry(answer : (call : Call) => Response) {
    const calls : Call[] = [];
    const fetcher = (async (input : string | URL, init? : RequestInit) => {
        const call = { url: String(input),
            method: init?.method ?? "GET",
            headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([ key, value ]) => [ key.toLowerCase(), String(value) ])) };
        calls.push(call);
        return answer(call);
    }) as typeof fetch;
    return { fetcher,
        calls };
}

/**
 * Point the docker config at a temporary directory for the duration of a test
 * @param config Contents of config.json, or null for none
 * @returns Function that restores the environment
 */
function dockerConfig(config : object | null) : () => void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-docker-config-"));
    const previous = process.env.DOCKER_CONFIG;
    if (config) {
        fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
    }
    process.env.DOCKER_CONFIG = dir;
    return () => {
        if (previous === undefined) {
            delete process.env.DOCKER_CONFIG;
        } else {
            process.env.DOCKER_CONFIG = previous;
        }
        fs.rmSync(dir, { recursive: true,
            force: true });
    };
}

test("image references split the way Docker resolves them", () => {
    assert.deepEqual(parseImageReference("nginx"), { host: "registry-1.docker.io",
        repository: "library/nginx",
        reference: "latest",
        registry: "docker.io" });
    assert.deepEqual(parseImageReference("louislam/uptime-kuma:2"), { host: "registry-1.docker.io",
        repository: "louislam/uptime-kuma",
        reference: "2",
        registry: "docker.io" });
    assert.deepEqual(parseImageReference("ghcr.io/example/app:latest"), { host: "ghcr.io",
        repository: "example/app",
        reference: "latest",
        registry: "ghcr.io" });
    assert.deepEqual(parseImageReference("registry.example.com:5000/team/app"), { host: "registry.example.com:5000",
        repository: "team/app",
        reference: "latest",
        registry: "registry.example.com:5000" });
    assert.equal(parseImageReference(`ghcr.io/example/app:1@${INDEX}`)?.reference, INDEX, "a pinned digest wins over the tag");
    assert.equal(parseImageReference("docker.io/redis:7")?.repository, "library/redis");

    for (const invalid of [ "", "${IMAGE}", "Nginx", "ghcr.io/example/app:bad tag", "app@sha256:short" ]) {
        assert.equal(parseImageReference(invalid), null, invalid);
    }
});

test("a public multi platform image is read with an anonymous token, accepting the index", async () => {
    const restore = dockerConfig(null);
    const { fetcher, calls } = registry((call) => {
        if (call.url.startsWith("https://ghcr.io/token")) {
            return Response.json({ token: "anonymous-token" });
        }
        if (!call.headers.authorization) {
            return new Response(null, { status: 401,
                headers: { "WWW-Authenticate": "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:example/app:pull\"" } });
        }
        return new Response(null, { status: 200,
            headers: { "Docker-Content-Digest": INDEX } });
    });

    try {
        assert.deepEqual(await readRegistryDigest("ghcr.io/example/app:latest", fetcher), { digest: INDEX,
            reason: "" });
        assert.equal(calls.length, 3);
        assert.equal(calls[0]?.method, "HEAD");
        assert.equal(calls[0]?.url, "https://ghcr.io/v2/example/app/manifests/latest");
        assert.match(calls[0]?.headers.accept ?? "", /application\/vnd\.oci\.image\.index\.v1\+json/);
        assert.match(calls[0]?.headers.accept ?? "", /manifest\.list\.v2\+json/);
        const token = new URL(calls[1]?.url ?? "");
        assert.equal(token.searchParams.get("service"), "ghcr.io");
        assert.equal(token.searchParams.get("scope"), "repository:example/app:pull");
        assert.equal(calls[1]?.headers.authorization, undefined, "no credentials were stored");
        assert.equal(calls[2]?.headers.authorization, "Bearer anonymous-token");
    } finally {
        restore();
    }
});

test("an official Docker Hub image is asked for under library/", async () => {
    const { fetcher, calls } = registry(() => new Response(null, { status: 200,
        headers: { "Docker-Content-Digest": INDEX } }));

    assert.equal((await readRegistryDigest("redis:7", fetcher)).digest, INDEX);
    assert.equal(calls[0]?.url, "https://registry-1.docker.io/v2/library/redis/manifests/7");
});

test("a refusal, a missing tag and a dead registry are told apart", async () => {
    const restore = dockerConfig(null);

    try {
        const denied = registry((call) => call.url.includes("/token")
            ? Response.json({ token: "anonymous-token" })
            : new Response(null, { status: call.headers.authorization ? 403 : 401,
                headers: { "WWW-Authenticate": "Bearer realm=\"https://auth.example.com/token\",service=\"registry.example.com\"" } }));
        assert.deepEqual(await readRegistryDigest("registry.example.com/team/private:1", denied.fetcher), { digest: "",
            reason: "registryDenied" });

        const noToken = registry((call) => call.url.includes("/token")
            ? new Response(null, { status: 401 })
            : new Response(null, { status: 401,
                headers: { "WWW-Authenticate": "Bearer realm=\"https://auth.example.com/token\"" } }));
        assert.equal((await readRegistryDigest("registry.example.com/team/private:1", noToken.fetcher)).reason, "registryDenied");

        const missing = registry(() => new Response(null, { status: 404 }));
        assert.equal((await readRegistryDigest("registry.example.com/team/app:gone", missing.fetcher)).reason, "registryMissing");

        const failing = registry(() => new Response(null, { status: 502 }));
        assert.equal((await readRegistryDigest("registry.example.com/team/app:1", failing.fetcher)).reason, "registryUnreachable");

        const offline = (async () => {
            throw new TypeError("fetch failed");
        }) as typeof fetch;
        assert.equal((await readRegistryDigest("registry.example.com/team/app:1", offline)).reason, "registryUnreachable");

        const invalid = registry(() => new Response(null, { status: 200 }));
        assert.equal((await readRegistryDigest("${IMAGE}", invalid.fetcher)).reason, "registryUnreachable");
        assert.equal(invalid.calls.length, 0, "an invalid reference is never sent anywhere");
    } finally {
        restore();
    }
});

test("stored credentials go to an HTTPS token service only", async () => {
    const auth = Buffer.from("robot:not-a-real-password").toString("base64");
    const restore = dockerConfig({ auths: { "https://index.docker.io/v1/": { auth },
        "registry.example.com": { auth } } });

    try {
        const hub = registry((call) => {
            if (call.url.startsWith("https://auth.docker.io/")) {
                return Response.json({ access_token: "user-token" });
            }
            return call.headers.authorization
                ? new Response(null, { status: 200,
                    headers: { "Docker-Content-Digest": INDEX } })
                : new Response(null, { status: 401,
                    headers: { "WWW-Authenticate": "Bearer realm=\"https://auth.docker.io/token\",service=\"registry.docker.io\"" } });
        });
        assert.equal((await readRegistryDigest("team/private:1", hub.fetcher)).digest, INDEX);
        assert.equal(hub.calls[1]?.headers.authorization, `Basic ${auth}`, "the Docker Hub login is found under its legacy key");
        assert.equal(hub.calls[2]?.headers.authorization, "Bearer user-token");

        const plain = registry(() => new Response(null, { status: 401,
            headers: { "WWW-Authenticate": "Bearer realm=\"http://auth.example.com/token\"" } }));
        assert.equal((await readRegistryDigest("registry.example.com/team/app:1", plain.fetcher)).reason, "registryDenied");
        assert.equal(plain.calls.length, 1, "no request goes to a plain HTTP realm");

        const basic = registry((call) => call.headers.authorization === `Basic ${auth}`
            ? new Response(null, { status: 200,
                headers: { "Docker-Content-Digest": INDEX } })
            : new Response(null, { status: 401,
                headers: { "WWW-Authenticate": "Basic realm=\"Registry\"" } }));
        assert.equal((await readRegistryDigest("registry.example.com/team/app:1", basic.fetcher)).digest, INDEX);
    } finally {
        restore();
    }
});

test("without a digest header the digest is the hash of the manifest body", async () => {
    const manifest = JSON.stringify({ schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [] });
    const { fetcher, calls } = registry((call) => call.method === "HEAD"
        ? new Response(null, { status: 200 })
        : new Response(manifest, { status: 200 }));

    const answer = await readRegistryDigest("registry.example.com/team/app:1", fetcher);
    assert.equal(answer.digest, `sha256:${createHash("sha256").update(manifest).digest("hex")}`);
    assert.equal(calls[1]?.method, "GET");
});
