import { strict as assert } from "node:assert";
import test from "node:test";
import checkVersion from "../../backend/check-version";
import type { DockgeServer } from "../../backend/dockge-server";
import { Settings } from "../../backend/settings";
import { withDatabase } from "../helpers/database";

/** The payloads a socket was sent under the "info" event */
function collector() : { sent : Record<string, unknown>[], socket : { emit : (event : string, payload : Record<string, unknown>) => void } } {
    const sent : Record<string, unknown>[] = [];

    return { sent,
        socket: { emit: (event : string, payload : Record<string, unknown>) => {
            if (event === "info") {
                sent.push(payload);
            }
        } } };
}

test("the browser is told whether the newest release is newer than the one running", async () => {
    await withDatabase(async () => {
        const { DockgeServer } = await import("../../backend/dockge-server");
        // The method reads the version and the settings, not the state of one server,
        // so the prototype is enough and no port is opened by this test
        const server = Object.create(DockgeServer.prototype) as DockgeServer;
        const { sent, socket } = collector();

        await Settings.set("checkUpdate", true, "general");
        checkVersion.latestVersion = "9999.0.0";
        await server.sendInfo(socket as never);

        assert.equal(sent[0]?.latestVersion, "9999.0.0");
        assert.equal(sent[0]?.updateAvailable, true,
            "the screen cannot compare versions itself: the server has to say so");

        // The same answer means "you are up to date", and only the comparison separates
        // the two: without it the panel would announce an update to itself for ever
        checkVersion.latestVersion = checkVersion.version;
        await server.sendInfo(socket as never);

        assert.equal(sent[1]?.latestVersion, checkVersion.version);
        assert.equal(sent[1]?.updateAvailable, false);

        checkVersion.latestVersion = undefined;
    });
});

test("switching the notice off takes the news off every screen", async () => {
    await withDatabase(async () => {
        const { DockgeServer } = await import("../../backend/dockge-server");
        const server = Object.create(DockgeServer.prototype) as DockgeServer;
        const { sent, socket } = collector();

        await Settings.set("checkUpdate", true, "general");
        checkVersion.latestVersion = "9999.0.0";
        await server.sendInfo(socket as never);
        assert.equal(sent[0]?.updateAvailable, true);

        // The release that was found stays in memory, and the next check returns early
        // rather than forgetting it. The answer the browser gets has to follow the switch
        // all the same, or the account button keeps a badge the About screen denies
        await Settings.set("checkUpdate", false, "general");
        await server.sendInfo(socket as never);

        assert.equal(sent[1]?.updateAvailable, false);
        assert.equal(sent[1]?.latestVersion, undefined);
        assert.equal(sent[1]?.version, checkVersion.version, "the version itself is not a notice");

        checkVersion.latestVersion = undefined;
    });
});

test("nothing about the version leaves the server before someone signed in", async () => {
    await withDatabase(async () => {
        const { DockgeServer } = await import("../../backend/dockge-server");
        const server = Object.create(DockgeServer.prototype) as DockgeServer;
        const { sent, socket } = collector();

        await Settings.set("checkUpdate", true, "general");
        checkVersion.latestVersion = "9999.0.0";
        await server.sendInfo(socket as never, true);

        // A version is what an attacker matches against a list of known weaknesses, and
        // the answer to "is there an update" names one just as clearly
        assert.equal(sent[0]?.version, undefined);
        assert.equal(sent[0]?.latestVersion, undefined);
        assert.equal(sent[0]?.updateAvailable, undefined);

        checkVersion.latestVersion = undefined;
    });
});
