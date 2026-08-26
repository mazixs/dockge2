import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import { Stack } from "../../backend/stack";
import { withDatabase } from "../helpers/database";

const enabled = process.env.DOCKGE_DOCKER_INTEGRATION === "1";
const skip = enabled ? false : "set DOCKGE_DOCKER_INTEGRATION=1 and provide a working Docker Compose to run this test";

/**
 * Run docker in the stack directory with the argument array the stack itself builds
 * @param stack Stack under test
 * @param args Compose arguments
 * @returns stdout of the command
 */
async function dockerInStack(stack : Stack, args : readonly string[]) : Promise<string> {
    const res = await spawn("docker", args, {
        cwd: stack.path,
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
        timeoutMs: 180_000,
    });
    return res.stdout?.toString() ?? "";
}

test("a bound secret reaches the container through /run/secrets", { skip }, async () => {
    await withDatabase(async () => {
        const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-it-secret-"));
        // The directory name is the compose project name, so it has to be unique on the machine
        const stackName = `dockge-it-secret-${process.pid}`;
        const stackDir = path.join(stacksDir, stackName);
        await mkdir(stackDir);

        // The container prints only the hash of the secret, so neither the compose file
        // nor the logs ever contain the value itself
        await writeFile(path.join(stackDir, "compose.yaml"), `services:
  app:
    image: alpine:3.20
    command: ["sh", "-c", "sha256sum /run/secrets/db_password | cut -d' ' -f1"]
`);

        const stack = await Stack.getStack({ stacksDir } as never, stackName);
        const secretValue = "s3cr3t-value";
        const expectedHash = createHash("sha256").update(secretValue).digest("hex");

        try {
            await stack.writeSecretFile(".secret.db", secretValue);
            await stack.bindSecret("db_password", ".secret.db", [ "app" ]);

            // The compose file now declares the secret and the service reference
            assert.match(stack.composeYAML, /secrets:\n {2}db_password:\n {4}file: \.\/\.secret\.db/);

            await dockerInStack(stack, stack.getComposeOptions("up", "-d"));
            await dockerInStack(stack, stack.getComposeOptions("wait", "app"));

            const logs = await dockerInStack(stack, stack.getComposeOptions("logs", "app"));
            assert.match(logs, new RegExp(expectedHash));

            // The secret value is not part of what Dockge reports about the stack
            const json = JSON.stringify(await stack.toJSON(""));
            assert.equal(json.includes(secretValue), false);
            assert.equal(json.includes(".secret.db"), true);
        } finally {
            await dockerInStack(stack, stack.getComposeOptions("down", "-v")).catch(() => undefined);
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("the env file order decides which value compose interpolates", { skip }, async () => {
    await withDatabase(async () => {
        const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-it-env-"));
        const stackName = `dockge-it-env-${process.pid}`;
        const stackDir = path.join(stacksDir, stackName);
        await mkdir(stackDir);

        await writeFile(path.join(stackDir, "compose.yaml"), `services:
  app:
    image: alpine:3.20
    command: ["sh", "-c", "echo RESULT=\${STAGE}"]
`);
        await writeFile(path.join(stackDir, ".env"), "STAGE=base\n");
        await writeFile(path.join(stackDir, ".env.override"), "STAGE=override\n");

        const stack = await Stack.getStack({ stacksDir } as never, stackName);

        try {
            await stack.setFileConfig({
                composeFileName: "compose.yaml",
                envFileNames: [ ".env", ".env.override" ],
                activeEnvFileName: ".env.override",
                secretBindings: [],
            });

            await dockerInStack(stack, stack.getComposeOptions("up", "-d"));
            await dockerInStack(stack, stack.getComposeOptions("wait", "app"));

            const logs = await dockerInStack(stack, stack.getComposeOptions("logs", "app"));
            assert.match(logs, /RESULT=override/);

            // Reversing the order reverses which file wins
            await dockerInStack(stack, stack.getComposeOptions("down", "-v"));
            await stack.setFileConfig({
                composeFileName: "compose.yaml",
                envFileNames: [ ".env.override", ".env" ],
                activeEnvFileName: ".env",
                secretBindings: [],
            });

            await dockerInStack(stack, stack.getComposeOptions("up", "-d"));
            await dockerInStack(stack, stack.getComposeOptions("wait", "app"));

            const reversed = await dockerInStack(stack, stack.getComposeOptions("logs", "app"));
            assert.match(reversed, /RESULT=base/);
        } finally {
            await dockerInStack(stack, stack.getComposeOptions("down", "-v")).catch(() => undefined);
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("a compose file that Docker refuses is never deployed", { skip }, async () => {
    await withDatabase(async () => {
        const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-it-invalid-"));
        const stackName = `dockge-it-invalid-${process.pid}`;
        const stackDir = path.join(stacksDir, stackName);
        await mkdir(stackDir);

        // A service without image or build is a project Compose rejects
        await writeFile(path.join(stackDir, "compose.yaml"), `services:
  app:
    restart: always
`);

        const stack = await Stack.getStack({ stacksDir } as never, stackName);

        try {
            await assert.rejects(stack.validateComposeConfig(), (error : unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Invalid compose configuration/);
                assert.match(error.message, /neither an image nor a build context/);
                return true;
            });

            // Nothing was started, so Compose knows no container of this project
            const containers = await spawn("docker", [
                "ps", "--all", "--filter", `label=com.docker.compose.project=${stackName}`, "--format", "json",
            ], {
                encoding: "utf-8",
                timeoutMs: 60_000,
            });
            assert.equal(containers.stdout?.toString().trim(), "");
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});
