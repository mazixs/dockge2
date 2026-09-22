import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";

export const sha256 = data => createHash("sha256").update(data).digest("hex");
export function schemaFileHash(name, data) {
    if (name === "package-lock.json") {
        const packages = JSON.parse(data).packages;
        return sha256(Object.keys(packages).filter(key => key !== "").sort().map(key => {
            const p = packages[key];
            return `${key}:${p.version ?? ""}:${p.integrity ?? ""}:${p.resolved ?? ""}\n`;
        }).join(""));
    }
    return sha256(data);
}
export function schemaHash(root) {
    const files = readdirSync(resolve(root, "backend/migrations")).filter(name => name.endsWith(".ts")).map(name => `backend/migrations/${name}`);
    // Auth owns migrations too; dependency changes conservatively require data restore.
    files.push("backend/auth.ts", "backend/auth-runtime.ts", "backend/auth-access.ts", "package-lock.json");
    return sha256(files.sort().map(name => `${name}:${schemaFileHash(name, readFileSync(resolve(root, name)))}\n`).join(""));
}
export function createManifest(root, assets, image, digest, index, commit, tag) {
    const version = JSON.parse(readFileSync(resolve(root, "package.json"))).version;
    const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json")));
    if (!semver.valid(version) || tag !== `v${version}` || lock.version !== version || lock.packages[""].version !== version) {
        throw new Error("Tag, package and lockfile versions must agree");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error("Invalid immutable image/source identity");
    }
    const platforms = {};
    for (const manifest of index.manifests ?? []) {
        const platform = `${manifest.platform?.os}/${manifest.platform?.architecture}`;
        if ([ "linux/amd64", "linux/arm64" ].includes(platform)) {
            if (platforms[platform] || !/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) {
                throw new Error("Duplicate or invalid platform manifest");
            }
            platforms[platform] = manifest.digest;
        }
    }
    if (Object.keys(platforms).length !== 2) {
        throw new Error("Both release platforms are required");
    }
    const files = Object.fromEntries([ "docker-compose.yml", "install.sh", "dockge2-update-linux-amd64", "dockge2-update-linux-arm64" ].map(name => {
        const data = readFileSync(resolve(assets, name));
        if (!data.length || data.length > 64 * 1024 * 1024) {
            throw new Error(`Invalid asset size: ${name}`);
        }
        return [ name, { sha256: sha256(data), size: data.length } ];
    }));
    return { format: 1, version, commit, channel: semver.prerelease(version) ? "prerelease" : "stable",
        image, digest, platforms, assets: files, minUpdater: 1, minCompose: "2.20.0", minEngine: "24.0.0",
        minVersion: "0.0.8", schema: schemaHash(root), legacy: JSON.parse(readFileSync(resolve(root, "extra/release/legacy.json"))) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [ assets, image, digest, indexFile, tag ] = process.argv.slice(2);
    const commit = execFileSync("git", [ "rev-parse", "HEAD" ], { encoding: "utf8" }).trim();
    writeFileSync(resolve(assets, "release.json"), JSON.stringify(createManifest(process.cwd(), assets, image, digest,
        JSON.parse(readFileSync(indexFile)), commit, tag), null, 2) + "\n", { mode: 0o600 });
}
