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
        checkVersion.resume();
        await checkVersion.startInterval();
        checkVersion.stopInterval();
        assert.deepEqual(asked, []);
        assert.equal(checkVersion.latestVersion, undefined);

        await Settings.set("checkUpdate", true, "general");
        checkVersion.resume();
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

        checkVersion.resume();
        await checkVersion.startInterval();
        checkVersion.stopInterval();
        assert.equal(checkVersion.latestVersion, "0.4.0");

        await Settings.set("checkBeta", true, "general");
        checkVersion.resume();
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

        checkVersion.resume();
        await checkVersion.startInterval();
        checkVersion.stopInterval();

        // Whatever was known before stays: a failed check is not news about a version
        assert.equal(typeof checkVersion.version, "string");
    });
});

test("only a release newer than the running one counts as an update", async () => {
    await withDatabase(async () => {
        const running = checkVersion.version;

        checkVersion.latestVersion = undefined;
        assert.equal(checkVersion.updateAvailable, false, "nothing was asked, so there is no news");

        // The registry answers with the newest release there is, which is this one on a
        // panel that is up to date: showing it would say "update" for ever
        checkVersion.latestVersion = running;
        assert.equal(checkVersion.updateAvailable, false);

        // A deployment that was rolled back on purpose runs ahead of nothing and behind
        // the registry only in the direction the owner chose
        checkVersion.latestVersion = "0.0.1";
        assert.equal(checkVersion.updateAvailable, false);

        checkVersion.latestVersion = "9999.0.0";
        assert.equal(checkVersion.updateAvailable, true);

        // A tag that is not a version at all answers nothing rather than crashing the
        // screen that reads this
        checkVersion.latestVersion = "nightly";
        assert.equal(checkVersion.updateAvailable, false);

        checkVersion.latestVersion = undefined;
    });
});

test("turning the check on asks the registry at once, not in two days", async (context) => {
    await withDatabase(async () => {
        const asked : string[] = [];
        context.mock.method(globalThis, "fetch", async (url : unknown) => {
            asked.push(String(url));
            return { json: async () => [{ tag_name: "v9999.0.0" }] } as Response;
        });

        // `check` is what the settings handler calls the moment the switch is saved. The
        // interval is 48 hours long, so without this the switch would show nothing until
        // the panel is restarted, which is what made it look broken
        checkVersion.resume();
        await checkVersion.check();
        assert.deepEqual(asked, [], "the switch is still off");

        await Settings.set("checkUpdate", true, "general");
        await checkVersion.check();

        assert.equal(asked.length, 1);
        assert.equal(checkVersion.latestVersion, "9999.0.0");
        assert.equal(checkVersion.updateAvailable, true);

        checkVersion.latestVersion = undefined;
    });
});

test("a check still in flight when the panel stops leaves neither a timer nor a request", async (context) => {
    await withDatabase(async () => {
        await Settings.set("checkUpdate", true, "general");

        let reached = () => {};
        const asked = new Promise<void>((resolve) => {
            reached = resolve;
        });

        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        // The request the shutdown catches in the middle: GitHub has been asked and has
        // not answered, which is exactly where `startInterval` used to be waiting
        let signal : AbortSignal | undefined;
        context.mock.method(globalThis, "fetch", async (_url : unknown, init : RequestInit) => {
            signal = init.signal ?? undefined;
            reached();
            await held;
            return { json: async () => [{ tag_name: "v9999.0.0" }] } as Response;
        });

        checkVersion.resume();
        const starting = checkVersion.startInterval();
        await asked;

        checkVersion.stopInterval();
        assert.equal(signal?.aborted, true, "the request was left running after the stop");

        // The answer arrives anyway, because a stop does not unmake a promise. What it
        // must not do is give the stopped panel a timer to fire in two days
        release();
        await starting;

        assert.equal(checkVersion.interval, undefined, "a stopped checker registered an interval");
    });
});

test("a stop during the settings read leaves the registry unasked", async (context) => {
    await withDatabase(async () => {
        await Settings.set("checkUpdate", true, "general");

        let reached = () => {};
        const reading = new Promise<void>((resolve) => {
            reached = resolve;
        });

        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Reading the setting is a wait of its own, and this one is caught in the middle
        // of it: at that moment there is no request to abort, because it has not been
        // created yet
        const realGet = Settings.get.bind(Settings);
        context.mock.method(Settings, "get", async (key : string) => {
            if (key !== "checkUpdate") {
                return realGet(key);
            }

            reached();
            await held;
            return realGet(key);
        });

        const asked : string[] = [];
        context.mock.method(globalThis, "fetch", async (url : unknown) => {
            asked.push(String(url));
            return { json: async () => [{ tag_name: "v9999.0.0" }] } as Response;
        });

        checkVersion.resume();
        const checking = checkVersion.check();
        await reading;

        checkVersion.stopInterval();
        release();
        await checking;

        assert.deepEqual(asked, [], "a stopped checker asked the registry anyway");
    });
});
