import { readFileSync } from "node:fs";
import semver from "semver";
const releases = JSON.parse(readFileSync(process.argv[2])).flat();
const version = process.argv[3];
const required = [ "release.json", "release.json.sigstore.json", "docker-compose.yml", "install.sh", "dockge2-update-linux-amd64", "dockge2-update-linux-arm64", "dockge2-update-linux-amd64.sigstore.json", "dockge2-update-linux-arm64.sigstore.json" ];
const previous = releases.filter(r => !r.draft && !r.prerelease && semver.valid(r.tag_name)
    && semver.lt(r.tag_name, version) && required.every(name => r.assets?.some(a => a.name === name && a.state === "uploaded")))
    .sort((a, b) => semver.rcompare(a.tag_name, b.tag_name))[0];
if (previous) {
    console.log(previous.tag_name);
}
