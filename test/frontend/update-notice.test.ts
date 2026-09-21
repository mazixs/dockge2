import { strict as assert } from "node:assert";
import test from "node:test";
import { updateNotice } from "../../frontend/src/update-notice";

test("nothing is said about updates until the owner asked for the check", () => {
    // The switch is off by default, and an installation that was never asked to look
    // has nothing to report - not even that it is up to date
    assert.equal(updateNotice({ latestVersion: "9.9.9",
        updateAvailable: true }, undefined), "off");
    assert.equal(updateNotice({ latestVersion: "9.9.9",
        updateAvailable: true }, false), "off");

    // The setting comes from the database through the client, where a stored "1" or
    // "true" would otherwise turn the check on without the owner touching it
    assert.equal(updateNotice({}, "true"), "off");
    assert.equal(updateNotice({}, 1), "off");
});

test("being switched on is not the same as having an answer", () => {
    // This is what the screen used to hide: the check was on, the registry had not
    // answered, and the panel looked exactly as it did when everything was current
    assert.equal(updateNotice({}, true), "pending");
    assert.equal(updateNotice({ latestVersion: "" }, true), "pending");
    assert.equal(updateNotice(undefined, true), "pending");
});

test("the newest release is only news when it is newer than this one", () => {
    // The server compares, and its answer decides: the version found is the newest
    // that exists, which on a panel that is up to date is the one already running
    assert.equal(updateNotice({ latestVersion: "0.0.5",
        updateAvailable: false }, true), "current");
    assert.equal(updateNotice({ latestVersion: "0.0.5" }, true), "current");

    assert.equal(updateNotice({ latestVersion: "0.0.6",
        updateAvailable: true }, true), "available");
});
