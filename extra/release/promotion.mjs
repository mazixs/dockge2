import semver from "semver";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Refuse a channel rewind even when GitHub's latest marker has been moved. */
export function shouldPromote(version, published, current) {
    if (!semver.valid(version) || semver.prerelease(version)) {
        return false;
    }
    return [ ...published, current ].filter(Boolean).every(value => {
        if (!semver.valid(value)) {
            throw new Error("Cannot establish the current stable channel version");
        }
        return semver.prerelease(value) || semver.gte(version, value);
    });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const manifest = JSON.parse(readFileSync(process.argv[2]));
    const gh = args => execFileSync("gh", args, { encoding: "utf8" }).trim();
    const docker = args => execFileSync("docker", args, { encoding: "utf8" }).trim();
    const releases = JSON.parse(gh([ "api", "--paginate", "--slurp", "repos/mazixs/dockge2/releases?per_page=100" ])).flat();
    const published = releases.filter(r => !r.draft && !r.prerelease).map(r => r.tag_name.replace(/^v/, ""));
    // A failed lookup must never be interpreted as permission to rewind a channel.
    docker([ "pull", `${manifest.image}:latest` ]);
    const current = docker([ "image", "inspect", `${manifest.image}:latest`, "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}' ]);
    if (!shouldPromote(manifest.version, published, current)) {
        console.log("Kept the newer stable channel (or this is a prerelease).");
        process.exit(0);
    }
    docker([ "buildx", "imagetools", "create", "--prefer-index=false", "--tag", `${manifest.image}:latest`, `${manifest.image}@${manifest.digest}` ]);
    const promoted = JSON.parse(docker([ "buildx", "imagetools", "inspect", `${manifest.image}:latest`, "--format", "{{json .Manifest}}" ]));
    if (promoted.digest !== manifest.digest) {
        throw new Error("Promotion changed the tested digest");
    }
    gh([ "release", "edit", `v${manifest.version}`, "--latest" ]);
}
