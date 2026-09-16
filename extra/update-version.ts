import pkg from "../package.json";
import childProcess from "child_process";
import fs from "fs";

const newVersion = process.env.VERSION;

console.log("New Version: " + newVersion);

if (! newVersion) {
    console.error("invalid version");
    process.exit(1);
}

const exists = tagExists(newVersion);

if (! exists) {
    // Process package.json
    pkg.version = newVersion;
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 4) + "\n");
    commit(newVersion);
    tag(newVersion);
} else {
    console.log("version exists");
}

/**
 * Commit the new version.
 * Only package.json goes in: `commit -a` swept in whatever else was open in the
 * working copy, and the tag below would then name a commit nobody reviewed
 * @param version Version to update to
 */
function commit(version : string) : void {
    let msg = "Update to " + version;

    let res = childProcess.spawnSync("git", [ "commit", "-m", msg, "package.json" ]);
    console.log(res.stdout.toString().trim());

    // Git says why on stderr and answers with a status, and the old check read
    // neither: a failed commit passed for a good one and got tagged
    if (res.status !== 0) {
        console.error(res.stderr.toString().trim());
        throw new Error("commit error");
    }
}

/**
 * Create the tag of a release
 * @param version Version to tag
 */
function tag(version : string) : void {
    let res = childProcess.spawnSync("git", [ "tag", "-a", tagName(version), "-m", tagName(version) ]);
    console.log(res.stdout.toString().trim());

    if (res.status !== 0) {
        console.error(res.stderr.toString().trim());
        throw new Error("tag error");
    }
}

/**
 * Whether the release is already tagged
 * @param version Version to check
 * @returns Does the tag already exist
 */
function tagExists(version : string) : boolean {
    if (! version) {
        throw new Error("invalid version");
    }

    let res = childProcess.spawnSync("git", [ "tag", "-l", tagName(version) ]);

    return res.stdout.toString().trim() === tagName(version);
}

/**
 * Tag of a version.
 * Releases are read back from their tags, `v` and all - by the update check here
 * and by anyone reading the list, so the tag is written the same way every time
 * @param version Version to name
 * @returns Tag name
 */
function tagName(version : string) : string {
    return version.startsWith("v") ? version : `v${version}`;
}
