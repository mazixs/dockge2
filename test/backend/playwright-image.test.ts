import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");

/**
 * Read a file of the repository
 * @param file Path from the root
 * @returns Its text
 */
function read(file : string) : Promise<string> {
    return readFile(path.join(root, file), "utf8");
}

test("the references are compared in the image of the Playwright the project installs", async () => {
    const packageJson = JSON.parse(await read("package.json")) as { devDependencies : Record<string, string> };
    const version = packageJson.devDependencies["@playwright/test"];
    const image = new RegExp(`mcr\\.microsoft\\.com/playwright:v${version?.replaceAll(".", "\\.")}-noble@sha256:([0-9a-f]{64})`);

    const local = image.exec(await read("test/visual/run.sh"));
    const ci = image.exec(await read(".github/workflows/ci.yml"));

    assert.ok(local, `test/visual/run.sh has to pin the image of Playwright ${version} by digest`);
    assert.ok(ci, `ci.yml has to pin the image of Playwright ${version} by digest`);
    assert.equal(local[1], ci[1], "the local run and CI have to use the same image");
});
