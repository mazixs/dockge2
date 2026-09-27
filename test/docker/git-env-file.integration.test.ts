import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import { missingEnvFiles } from "../../backend/agent-socket-handlers/git-socket-handler";

test("Compose names a missing env_file or --env-file in the words the Git check reads", {
    skip: process.env.DOCKGE_DOCKER_INTEGRATION !== "1",
}, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dockge-it-env-file-"));
    try {
        await writeFile(path.join(directory, "compose.yaml"), "services:\n  app:\n    image: bash:5.2\n    env_file: .env\n");
        const failure = await spawn("docker", [ "compose", "-p", "dockge-git-validation", "-f", "compose.yaml", "config", "--quiet" ], {
            cwd: directory,
            encoding: "utf8",
            timeoutMs: 60_000,
        }).then(() => undefined, (error: unknown) => error);
        assert.ok(failure, "config accepted a missing env_file");
        assert.deepEqual(await missingEnvFiles(failure, directory), [ ".env" ]);

        await writeFile(path.join(directory, "compose.yaml"), "services:\n  app:\n    image: bash:5.2\n");
        const selected = await spawn("docker", [ "compose", "-p", "dockge-git-validation", "-f", "compose.yaml", "--env-file", path.join(directory, ".env"), "config", "--quiet" ], {
            cwd: directory,
            encoding: "utf8",
            timeoutMs: 60_000,
        }).then(() => undefined, (error: unknown) => error);
        assert.ok(selected, "config accepted a missing --env-file");
        assert.deepEqual(await missingEnvFiles(selected, directory), [ ".env" ]);
    } finally {
        await rm(directory, { recursive: true,
            force: true });
    }
});
