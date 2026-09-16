import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDockerRuntime } from "../../backend/stability";

interface DockerFixture {
    ids : string[];
    incomplete? : boolean;
    fail? : boolean;
}

/** A temporary Docker executable exercises parsing without connecting to the real daemon. */
async function withDockerFixture(fixture : DockerFixture, callback : (callsPath : string) => Promise<void>) : Promise<void> {
    const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "dockge-stability-docker-"));
    const previousPath = process.env.PATH;
    const callsPath = path.join(fixtureDir, "calls.jsonl");
    await writeFile(path.join(fixtureDir, "fixture.json"), JSON.stringify(fixture));
    await writeFile(path.join(fixtureDir, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture.json"), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(args) + "\\n");
if (fixture.fail) process.exit(1);
if (args[0] === "ps") {
    process.stdout.write(fixture.ids.join("\\n"));
} else if (args[0] === "inspect") {
    const ids = args.filter((value) => /^[a-f0-9]{64}$/.test(value));
    if (fixture.incomplete) ids.pop();
    process.stdout.write(ids.map((id) => JSON.stringify({ id, name: "/container-" + id, project: null, service: null, workingDir: null, state: "running", health: "", startedAt: "2026-09-09T10:00:00Z", restartCount: 0 })).join("\\n"));
} else {
    process.stderr.write("Unexpected Docker mutation");
    process.exit(2);
}
`, { mode: 0o755 });
    process.env.PATH = `${fixtureDir}${path.delimiter}${previousPath ?? ""}`;
    try {
        await callback(callsPath);
    } finally {
        if (previousPath === undefined) {
            delete process.env.PATH;
        } else {
            process.env.PATH = previousPath;
        }
        await rm(fixtureDir, { recursive: true,
            force: true });
    }
}

test("runtime collection batches more than one hundred containers and includes standalone containers", async () => {
    const ids = Array.from({ length: 105 }, (_, i) => i.toString(16).padStart(64, "0"));
    await withDockerFixture({ ids }, async (callsPath) => {
        const runtime = await readDockerRuntime();
        assert.equal(runtime.length, 105);
        assert.equal(runtime[0]?.project, "");
        assert.equal(runtime[0]?.restartCount, 0);
        const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
        assert.deepEqual(calls.map((args) => args[0]), [ "ps", "inspect", "inspect" ]);
    });
});

test("an empty successful Docker list is distinct from failed or incomplete output", async () => {
    await withDockerFixture({ ids: [] }, async () => {
        assert.deepEqual(await readDockerRuntime(), []);
    });
    await withDockerFixture({ ids: [ "a".repeat(64) ],
        incomplete: true }, async () => {
        await assert.rejects(readDockerRuntime(), /incomplete/);
    });
    await withDockerFixture({ ids: [ "invalid-id" ] }, async () => {
        await assert.rejects(readDockerRuntime(), /invalid container list/);
    });
    await withDockerFixture({ ids: [],
        fail: true }, async () => {
        await assert.rejects(readDockerRuntime(), /exited unsuccessfully|exited with code/i);
    });
});
