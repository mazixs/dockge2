import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "../../backend/child-process";
import { Database } from "../../backend/database";
import { generatePasswordHash } from "../../backend/password-hash";
import { Settings } from "../../backend/settings";
import { genSecret } from "../../common/util-common";

import { E2E_STACK_NAME } from "./constants";

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

    // A long running container with both sh and bash available
    await writeFile(path.join(stacksDir, E2E_STACK_NAME, "compose.yaml"), `services:
  shellbox:
    image: bash:5.2
    command: ["bash", "-c", "sleep 900"]
`);

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
            // The password is random and never used, the UI logs in through disableAuth
            password: generatePasswordHash(genSecret(32)),
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
}

await seed();
console.log("e2e environment ready");
