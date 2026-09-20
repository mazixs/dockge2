import { strict as assert } from "node:assert";
import test from "node:test";
import { checkBudget, readEntryAssets } from "../../extra/check-bundle";

test("the first load is read from the built page, not guessed", () => {
    const html = `<!doctype html><html><head>
  <script type="module" crossorigin src="/assets/index-abc.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/runtime-def.js">
  <link rel="modulepreload" crossorigin href="/assets/shared-ghi.js">
  <link rel="stylesheet" crossorigin href="/assets/index-jkl.css">
  <link rel="prefetch" href="/assets/later-mno.js">
</head><body></body></html>`;

    // The stylesheet is not JavaScript, and a prefetched chunk is not part of the
    // first load: neither belongs in a budget for the entry script
    assert.deepEqual(readEntryAssets(html), [ "/assets/index-abc.js", "/assets/runtime-def.js", "/assets/shared-ghi.js" ]);
});

test("a first load over the budget fails the check", () => {
    const under = checkBudget([{ name: "index.js",
        raw: 600 * 1024,
        gzip: 190 * 1024 }]);
    assert.equal(under.ok, true);
    assert.match(under.report.at(-1) ?? "", /^ok {3}first load: 600\.00 kB of 780 kB/);

    const over = checkBudget([
        { name: "index.js",
            raw: 700 * 1024,
            gzip: 200 * 1024 },
        { name: "shared.js",
            raw: 200 * 1024,
            gzip: 40 * 1024 },
    ]);
    assert.equal(over.ok, false);
    assert.match(over.report.at(-1) ?? "", /^FAIL first load: 900\.00 kB of 780 kB/);

    // Compressed size is its own limit: a chunk that compresses well must not be able
    // to hide behind the raw budget
    const compressible = checkBudget([{ name: "index.js",
        raw: 700 * 1024,
        gzip: 260 * 1024 }]);
    assert.equal(compressible.ok, false);
});

test("a page without an entry script is a broken build, not an empty budget", () => {
    const { ok, report } = checkBudget([]);

    assert.equal(ok, false);
    assert.match(report[0] ?? "", /No entry asset/);
});
