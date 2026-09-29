import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Exempt only the generic Git SSH account on the supported public hosts, followed
// by an actual repository path. A bare address or a personal SSH login is not exempt.
function emailDomains(text) {
    const withoutGitUrls = text.replace(/(?<![A-Za-z0-9._%+@/-])(?:ssh:\/\/git@(?:github\.com|gitlab\.com|bitbucket\.org)(?::\d+)?\/|git@(?:github\.com|gitlab\.com|bitbucket\.org):)[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+(?=$|[\s`<>)\],;])/g, "");
    return [...withoutGitUrls.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map(match => match[1]);
}

test("documentation privacy distinguishes Git SSH examples from contact addresses", () => {
    assert.deepEqual(emailDomains("`git@github.com:owner/repository.git` and ssh://git@gitlab.com/group/repository.git"), []);
    assert.deepEqual(emailDomains("git@bitbucket.org:team/repository.git"), []);
    assert.deepEqual(emailDomains("person@github.com git@github.com git@github.com: git@github.com:owner"), ["github.com", "github.com", "github.com", "github.com"]);
    assert.deepEqual(emailDomains("ssh://person@github.com/owner/repo.git git@private.example:owner/repo.git"), ["github.com", "private.example"]);
    assert.deepEqual(emailDomains("git@github.com:owner/repo.git contact@company.test"), ["company.test"]);
    assert.deepEqual(emailDomains("person-git@github.com:owner/repo.git"), ["github.com"]);
    assert.deepEqual(emailDomains("git@github.com:owner/contact@company.test"), ["github.com", "company.test"]);
});

// This guard covers accidental documentation leaks, not every possible secret format.
test("published documentation does not embed personal home paths or non-example email addresses", () => {
    const files = [...new Set(execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0"))].filter(file => file.endsWith(".md") && existsSync(file));
    for (const file of files) {
        const text = readFileSync(file, "utf8");
        assert.doesNotMatch(text, /\/(?:home|Users)\/[^\s<>`]+/, `${file}: personal home path`);
        for (const domain of emailDomains(text)) {
            assert.match(domain, /(?:^|\.)(?:example\.(?:com|org|net|invalid)|example|invalid)$/, `${file}: use an example email domain`);
        }
    }
});

test("local design reviews are excluded from Git and image context", () => {
    assert.equal(execFileSync("git", ["check-ignore", "--no-index", ".impeccable/critique/review.md"], { encoding: "utf8" }), ".impeccable/critique/review.md\n");
    assert.ok(readFileSync(".gitignore", "utf8").split(/\r?\n/).includes(".impeccable/"));
    assert.ok(readFileSync(".dockerignore", "utf8").split(/\r?\n/).includes(".impeccable"));
});

test("local browser sessions and environment variants are excluded from Git and image context", () => {
    for (const file of [".gitignore", ".dockerignore"]) {
        const rules = readFileSync(file, "utf8").split(/\r?\n/);
        for (const pattern of [".env.*", ".playwright-cli/"]) assert.ok(rules.includes(pattern), `${file} is missing ${pattern}`);
    }
    assert.equal(execFileSync("git", ["check-ignore", "--no-index", ".env.production", ".playwright-cli/session.json"], { encoding: "utf8" }), ".env.production\n.playwright-cli/session.json\n");
});
