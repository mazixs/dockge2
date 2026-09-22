import test from "node:test";
import assert from "node:assert/strict";
import { shouldPromote } from "../../extra/release/promotion.mjs";
import { createManifest } from "../../extra/release/manifest.mjs";

test("an older/concurrent release or prerelease cannot rewind stable", () => {
    assert.equal(shouldPromote("1.2.3", [ "1.2.2", "1.3.0" ], "1.2.2"), false);
    assert.equal(shouldPromote("1.2.3", [ "1.2.2" ], "1.3.0"), false);
    assert.equal(shouldPromote("1.2.3-rc.1", [], "1.2.2"), false);
    assert.equal(shouldPromote("1.2.3", [ "1.2.3" ], "1.2.3"), true);
    assert.throws(() => shouldPromote("1.2.3", [], "unknown"));
});
test("a mismatched tag cannot create a release descriptor", () => {
    assert.throws(() => createManifest(process.cwd(), ".", "ghcr.io/mazixs/dockge2", "", {}, "", "v99.0.0"), /versions must agree/);
});

test("schema dependency identity ignores the package's release number", async () => {
    const { schemaFileHash } = await import("../../extra/release/manifest.mjs");
    const a = { version: "1.0.0", packages: { "": { version: "1.0.0" }, "node_modules/auth": { version: "1.2.3", integrity: "sha512-abc" } } };
    const b = structuredClone(a);
    b.version = b.packages[""].version = "1.0.1";
    assert.equal(schemaFileHash("package-lock.json", JSON.stringify(a)), schemaFileHash("package-lock.json", JSON.stringify(b)));
    b.packages["node_modules/auth"].integrity = "sha512-changed";
    assert.notEqual(schemaFileHash("package-lock.json", JSON.stringify(a)), schemaFileHash("package-lock.json", JSON.stringify(b)));
});
