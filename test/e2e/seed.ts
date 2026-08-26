import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "../../backend/child-process";
import { Database } from "../../backend/database";
import { generatePasswordHash } from "../../backend/password-hash";
import { Settings } from "../../backend/settings";

import { E2E_ADMIN_PASSWORD, E2E_ATTENTION_STACK, E2E_FILES_STACK, E2E_STACK_NAME } from "./constants";

const dataDir = process.env.DOCKGE_E2E_DATA_DIR ?? "/tmp/dockge-e2e/data";
const stacksDir = process.env.DOCKGE_E2E_STACKS_DIR ?? "/tmp/dockge-e2e/stacks";

/**
 * Prepare a clean data directory, a logged in session and a running container.
 *
 * Authentication is disabled for the run instead of typing a password into the UI:
 * the tests are about the terminal, and the admin password never has to be known.
 */
async function seed() : Promise<void> {
    await rm(dataDir, { recursive: true,
        force: true });
    await rm(stacksDir, { recursive: true,
        force: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(path.join(stacksDir, E2E_STACK_NAME), { recursive: true });
    await mkdir(path.join(stacksDir, E2E_ATTENTION_STACK), { recursive: true });
    await mkdir(path.join(stacksDir, E2E_FILES_STACK), { recursive: true });

    // A long running container with both sh and bash available
    await writeFile(path.join(stacksDir, E2E_STACK_NAME, "compose.yaml"), `services:
  shellbox:
    image: bash:5.2
    command: ["bash", "-c", "sleep 900"]
`);

    // A running service next to an unmarked container that exits cleanly
    await writeFile(path.join(stacksDir, E2E_ATTENTION_STACK, "compose.yaml"), `services:
  app:
    image: bash:5.2
    command: ["bash", "-c", "sleep 900"]
  init:
    image: bash:5.2
    command: ["bash", "-c", "exit 0"]
`);

    // Several compose files, several env files and a secret, all with comments to preserve
    await writeFile(path.join(stacksDir, E2E_FILES_STACK, "compose.yaml"), `# default file
services:
  app:
    image: bash:5.2 # keep me
    command: ["bash", "-c", "sleep 900"]
    tmpfs:
      mode: 01777
`);
    await writeFile(path.join(stacksDir, E2E_FILES_STACK, "staging.yml"), `# staging file
services:
  app:
    image: bash:5.2
    command: ["bash", "-c", "sleep 900"]
`);
    await writeFile(path.join(stacksDir, E2E_FILES_STACK, ".env"), "STAGE=base\n");
    await writeFile(path.join(stacksDir, E2E_FILES_STACK, ".env.dev"), "STAGE=dev\n");
    await writeFile(path.join(stacksDir, E2E_FILES_STACK, ".secret.db"), "seeded-secret-value\n");

    await Database.init({
        config: {
            dataDir,
            stacksDir,
        },
    } as never);

    const knex = Database.getKnex();

    if (!await knex("user").first()) {
        await knex("user").insert({
            username: "e2e-admin",
            // Known password: revealing a secret is guarded by a password check
            password: generatePasswordHash(E2E_ADMIN_PASSWORD),
            active: 1,
            twofa_status: 0,
        });
    }

    await Settings.set("disableAuth", true);
    Settings.stopCacheCleaner();
    await Database.close();

    await spawn("docker", [
        "compose", "-p", E2E_STACK_NAME, "-f", path.join(stacksDir, E2E_STACK_NAME, "compose.yaml"), "up", "-d", "--wait",
    ], {
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
        timeoutMs: 300_000,
    });

    // The attention stack needs its one-shot container to have exited before the test looks
    await spawn("docker", [
        "compose", "-p", E2E_ATTENTION_STACK, "-f", path.join(stacksDir, E2E_ATTENTION_STACK, "compose.yaml"), "up", "-d",
    ], {
        encoding: "utf-8",
        maxBuffer: 4 * 1024 * 1024,
        timeoutMs: 300_000,
    });
    await spawn("docker", [
        "compose", "-p", E2E_ATTENTION_STACK, "-f", path.join(stacksDir, E2E_ATTENTION_STACK, "compose.yaml"), "wait", "init",
    ], {
        encoding: "utf-8",
        timeoutMs: 300_000,
    });
}

await seed();
console.log("e2e environment ready");
