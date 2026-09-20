import { strict as assert } from "node:assert";
import test from "node:test";
import checkVersion from "../../backend/check-version";
import { Settings } from "../../backend/settings";
import { withDatabase } from "../helpers/database";

test("the highest release wins, and what is not a release is ignored", () => {
    const found = checkVersion.parseReleases([
        { tag_name: "v0.0.2" },
        { tag_name: "v0.1.0" },
        { tag_name: "v0.0.9" },
        { tag_name: "v9.9.9",
            draft: true },
        { tag_name: "nightly" },
        { tag_name: 5 },
        null,
        { tag_name: "v0.2.0-beta.1",
            prerelease: true },
        { tag_name: "v0.1.5-beta.1",
            prerelease: true },
    ]);

    assert.equal(found.stable, "0.1.0");
    assert.equal(found.beta, "0.2.0-beta.1");
});

test("an answer that is not a list of releases leaves the version unknown", () => {
    assert.deepEqual(checkVersion.parseReleases(null), {});
    assert.deepEqual(checkVersion.parseReleases({ message: "rate limit exceeded" }), {});
    assert.deepEqual(checkVersion.parseReleases([]), {});
});

test("nothing is asked of GitHub until the owner turns the check on", async (context) => {
    await withDatabase(async () => {
        const asked : string[] = [];
        context.mock.method(globalThis, "fetch", async (url : unknown) => {
            asked.push(String(url));
            return { json: async () => [{ tag_name: "v0.4.0" }] } as Response;
        });

        // The default is off: an installation says nothing about itself to anybody
        await checkVersion.startInterval();
        checkVersion.stopInterval();
        assert.deepEqual(asked, []);
        assert.equal(checkVersion.latestVersion, undefined);

        await Settings.set("checkUpdate", true, "general");
        await checkVersion.startInterval();
        checkVersion.stopInterval();

        assert.equal(asked.length, 1);
        assert.match(asked[0] ?? "", /mazixs\/dockge2/);
        assert.equal(checkVersion.latestVersion, "0.4.0");
    });
});

test("a beta is only offered to someone who asked for betas", async (context) => {
    await withDatabase(async () => {
        context.mock.method(globalThis, "fetch", async () => ({ json: async () => [
            { tag_name: "v0.4.0" },
            { tag_name: "v0.5.0-beta.1",
                prerelease: true },
        ] } as Response));
        await Settings.set("checkUpdate", true, "general");

        await checkVersion.startInterval();
        checkVersion.stopInterval();
        assert.equal(checkVersion.latestVersion, "0.4.0");

        await Settings.set("checkBeta", true, "general");
        await checkVersion.startInterval();
        checkVersion.stopInterval();
        assert.equal(checkVersion.latestVersion, "0.5.0-beta.1");
    });
});

test("a registry that cannot be reached leaves the known version alone", async (context) => {
    await withDatabase(async () => {
        await Settings.set("checkUpdate", true, "general");
        context.mock.method(globalThis, "fetch", async () => {
            throw new Error("getaddrinfo ENOTFOUND api.github.com");
        });

        await checkVersion.startInterval();
        checkVersion.stopInterval();

        // Whatever was known before stays: a failed check is not news about a version
        assert.equal(typeof checkVersion.version, "string");
    });
});
