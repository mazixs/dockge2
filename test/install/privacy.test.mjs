import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// This guard covers accidental documentation leaks, not every possible secret format.
test("published documentation does not embed personal home paths or non-example email addresses", () => {
    const files = [...new Set(execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0"))].filter(file => file.endsWith(".md"));
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        assert.doesNotMatch(text, /\/(?:home|Users)\/[^\s<>`]+/, `${file}: personal home path`);
        for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
            assert.match(match[1], /(?:^|\.)(?:example\.(?:com|org|net|invalid)|example|invalid)$/, `${file}: use an example email domain`);
        }
    }
});

test("local browser sessions and environment variants are excluded from Git and image context", () => {
    for (const file of [".gitignore", ".dockerignore"]) {
        const rules = readFileSync(file, "utf8").split(/\r?\n/);
        for (const pattern of [".env.*", ".playwright-cli/"]) assert.ok(rules.includes(pattern), `${file} is missing ${pattern}`);
    }
    assert.equal(execFileSync("git", ["check-ignore", "--no-index", ".env.production", ".playwright-cli/session.json"], { encoding: "utf8" }), ".env.production\n.playwright-cli/session.json\n");
});
