import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import { convertDockerRun } from "../../backend/socket-handlers/main-socket-handler";
import { loadDockerRunCorpus } from "../helpers/docker-run-corpus";

const enabled = process.env.DOCKGE_DOCKER_INTEGRATION === "1";
const skip = enabled ? false : "set DOCKGE_DOCKER_INTEGRATION=1 and provide a working Docker Compose to run this test";

/**
 * Environment of the check: only what finds Docker, so that no variable of the
 * machine fills a `$` of the corpus and hides an interpolation
 * @returns Environment for docker compose
 */
function composeEnvironment() : NodeJS.ProcessEnv {
    const names = [ "PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY" ];
    return Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [ name, process.env[name] ]));
}

/**
 * Run `docker compose config --quiet` on a compose file. It reads and validates
 * the file and never creates, starts or stops anything.
 * @param directory Directory holding the compose file
 * @returns Exit code and error output
 */
async function composeConfig(directory : string) : Promise<{ code : number | null, stderr : string }> {
    const args = [ "compose", "--project-directory", directory, "-p", `dockge-corpus-${process.pid}`,
        "-f", path.join(directory, "compose.yaml"), "config", "--quiet" ];

    try {
        const result = await spawn("docker", args, { encoding: "utf8",
            env: composeEnvironment(),
            timeoutMs: 60_000 });
        return { code: result.code,
            stderr: String(result.stderr ?? "") };
    } catch (error) {
        const failure = error as Error & { code? : number | null, stderr? : string | Buffer };
        if (typeof failure.code !== "number") {
            throw error;
        }
        return { code: failure.code,
            stderr: String(failure.stderr ?? "") };
    }
}

for (const fixture of loadDockerRunCorpus()) {
    test(`docker compose config on the converted ${fixture.name}`, { skip }, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "dockge-corpus-"));

        try {
            await writeFile(path.join(directory, "compose.yaml"), convertDockerRun(fixture.command).compose);

            for (const [ name, content ] of Object.entries(fixture.composeConfig.files ?? {})) {
                await writeFile(path.join(directory, name), content);
            }

            const { code, stderr } = await composeConfig(directory);

            assert.equal(code === 0, fixture.composeConfig.valid, `exit code ${code}: ${stderr}`);

            if (fixture.composeConfig.stderr) {
                assert.match(stderr, new RegExp(fixture.composeConfig.stderr));
            }
        } finally {
            await rm(directory, { recursive: true,
                force: true });
        }
    });
}
