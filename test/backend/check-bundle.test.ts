import { strict as assert } from "node:assert";
import test from "node:test";
import { checkBudget, checkLazyBudget, readEntryAssets } from "../../extra/check-bundle";

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
    assert.match(under.report.at(-1) ?? "", /^ok {3}first load: 600\.00 KiB of 780 KiB/);

    const over = checkBudget([
        { name: "index.js",
            raw: 700 * 1024,
            gzip: 200 * 1024 },
        { name: "shared.js",
            raw: 200 * 1024,
            gzip: 40 * 1024 },
    ]);
    assert.equal(over.ok, false);
    assert.match(over.report.at(-1) ?? "", /^FAIL first load: 900\.00 KiB of 780 KiB/);

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

test("a chunk loaded on demand has a budget of its own", () => {
    const under = checkLazyBudget([
        { name: "Compose.js",
            raw: 400 * 1024,
            gzip: 130 * 1024 },
        { name: "Settings.js",
            raw: 40 * 1024,
            gzip: 12 * 1024 },
    ]);
    assert.equal(under.ok, true);
    assert.match(under.report.at(-1) ?? "", /^ok {3}on demand: 2 chunks, largest Compose\.js 400\.00 KiB/);

    // One chunk is enough to fail, and it is the one named
    const over = checkLazyBudget([
        { name: "Compose.js",
            raw: 400 * 1024,
            gzip: 130 * 1024 },
        { name: "Editor.js",
            raw: 300 * 1024,
            gzip: 170 * 1024 },
    ]);
    assert.equal(over.ok, false);
    assert.match(over.report[0] ?? "", /Editor\.js/);
    assert.equal(over.report.length, 2);
});
