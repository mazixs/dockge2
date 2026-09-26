import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setOwnContainerReader } from "../../backend/own-container";
import { Stack } from "../../backend/stack";
import type { DockgeServer } from "../../backend/dockge-server";
import { CREATED_FILE, RUNNING } from "../../common/util-common";

/**
 * A `docker` on PATH that answers `compose ls` and `ps` from files the test rewrites
 * @param dir Directory of the script and its answers
 * @returns Paths of the two answers
 */
async function installFakeDocker(dir : string) : Promise<{ ls : string, ps : string }> {
    const ls = path.join(dir, "ls.json");
    const ps = path.join(dir, "ps.jsonl");
    const script = [
        "#!/bin/sh",
        `if [ "$1" = "compose" ] && [ "$2" = "ls" ]; then cat "${ls}"; exit 0; fi`,
        `if [ "$1" = "ps" ]; then cat "${ps}"; exit 0; fi`,
        "exit 1",
    ].join("\n") + "\n";
    await writeFile(path.join(dir, "docker"), script);
    await chmod(path.join(dir, "docker"), 0o755);
    return { ls,
        ps };
}

/**
 * One running container of a compose project, as `docker ps --format json` prints it
 * @param project Compose project
 * @param workingDir Directory Compose recorded
 * @returns One line
 */
function psLine(project : string, workingDir : string) : string {
    return JSON.stringify({
        ID: project.padEnd(64, "0").replace(/[^a-f0-9]/g, "a"),
        Names: `${project}-app-1`,
        Labels: `com.docker.compose.project=${project},com.docker.compose.service=app,com.docker.compose.project.working_dir=${workingDir}`,
        State: "running",
        Status: "Up 5 minutes",
    });
}

test("the ten second round does not keep a stack running after it left Docker", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dockge-stack-cache-"));
    const stacksDir = path.join(root, "stacks");
    const bin = path.join(root, "bin");
    const previousPath = process.env.PATH;
    t.after(async () => {
        process.env.PATH = previousPath;
        await rm(root, { recursive: true,
            force: true });
    });

    await mkdir(path.join(stacksDir, "web"), { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(stacksDir, "web", "compose.yaml"), "services:\n  app:\n    image: nginx\n");
    const answers = await installFakeDocker(bin);
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    setOwnContainerReader({ mountinfo: async () => "",
        hostname: () => "",
        inspect: async () => "[]",
        imageDigests: async () => "[]" });

    const server = {
        stacksDir,
        standaloneContainers: { observe: () => undefined,
            lose: () => undefined },
    } as unknown as DockgeServer;

    await writeFile(answers.ls, JSON.stringify([
        { Name: "web",
            Status: "running(1)",
            ConfigFiles: path.join(stacksDir, "web", "compose.yaml") },
        { Name: "outside",
            Status: "running(1)",
            ConfigFiles: "/srv/outside/compose.yaml" },
    ]));
    await writeFile(answers.ps, [ psLine("web", path.join(stacksDir, "web")), psLine("outside", "/srv/outside") ].join("\n") + "\n");

    const first = await Stack.getStackList(server);
    assert.equal(first.get("web")?.status, RUNNING);
    assert.equal(first.get("outside")?.status, RUNNING);

    // Both were brought down from a shell: the panel did nothing that would drop its cache
    await writeFile(answers.ls, "[]");
    await writeFile(answers.ps, "");

    const round = await Stack.getStackList(server, true);
    assert.equal(round.get("web")?.status, CREATED_FILE, "a managed stack whose project is gone is no longer running");
    assert.equal(round.has("outside"), false, "a project the panel does not manage is listed only while Docker has it");
});
