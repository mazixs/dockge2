import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "../../backend/child-process";
import { Database } from "../../backend/database";
import { ATTENTION, RUNNING } from "../../common/util-common";
import { Settings } from "../../backend/settings";

import { countUsers, initAuth } from "../../backend/auth";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_ATTENTION_STACK, E2E_FILES_STACK, E2E_STACK_NAME } from "./constants";

const dataDir = process.env.DOCKGE_E2E_DATA_DIR ?? "/tmp/dockge-e2e/data";
const stacksDir = process.env.DOCKGE_E2E_STACKS_DIR ?? "/tmp/dockge-e2e/stacks";

/**
 * Prepare a clean data directory, the owner account and the running containers.
 *
 * Authentication stays on, so the suite runs against the same code path an installation
 * uses. The global setup signs in once and hands the session cookie to every spec.
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

    // The account is created through the auth endpoints, the same way the UI does it
    const auth = await initAuth({
        config: {
            dataDir,
            stacksDir,
            port: 5001,
        },
        isSSL: () => undefined,
        getBaseURL: () => "http://localhost:5001",
    } as never);

    if (await countUsers() === 0) {
        const response = await auth.handler(new Request("http://localhost:5001/api/auth/bootstrap", {
            method: "POST",
            headers: { "content-type": "application/json",
                origin: "http://localhost:5001" },
            body: JSON.stringify({
                token: process.env.DOCKGE_BOOTSTRAP_TOKEN || (await readFile(path.join(dataDir, "bootstrap-token"), "utf8")).trim(),
                username: "e2e.owner",
                email: E2E_ADMIN_EMAIL,
                // Known password: revealing a secret is guarded by a password check
                password: E2E_ADMIN_PASSWORD,
                name: "E2E owner",
            }),
        }));

        if (!response.ok) {
            throw new Error(`Could not create the e2e account: ${response.status}`);
        }
    }

    // История состояний: без нее доступность честно молчит, а спек не сможет проверить
    // ни "без сбоев", ни процент со сбоем. Значения кладутся как настоящие строки.
    const now = Date.now();
    const hour = 3_600_000;

    await Database.getKnex()("stack_observation").insert([
        // Работает третьи сутки без сбоев
        { stack_name: E2E_STACK_NAME,
            endpoint: "",
            status: RUNNING,
            observed_at: now - 72 * hour,
            observed_until: now },
        // Сутки работы с часовым сбоем: 95,8% и один случай
        { stack_name: E2E_ATTENTION_STACK,
            endpoint: "",
            status: RUNNING,
            observed_at: now - 48 * hour,
            observed_until: now - 3 * hour },
        { stack_name: E2E_ATTENTION_STACK,
            endpoint: "",
            status: ATTENTION,
            observed_at: now - 3 * hour,
            observed_until: now - 2 * hour },
        { stack_name: E2E_ATTENTION_STACK,
            endpoint: "",
            status: RUNNING,
            observed_at: now - 2 * hour,
            observed_until: now },
    ]);

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
    // Compose wait omits services that exited before it starts; Docker waits on retained IDs.
    const init = await spawn("docker", [
        "compose", "-p", E2E_ATTENTION_STACK, "-f", path.join(stacksDir, E2E_ATTENTION_STACK, "compose.yaml"), "ps", "--all", "--quiet", "init",
    ], { encoding: "utf-8",
        maxBuffer: 1024,
        timeoutMs: 30_000 });
    const containerId = init.stdout?.toString().trim() ?? "";
    if (!/^[a-f0-9]{64}$/.test(containerId)) {
        throw new Error("The isolated init container was not found");
    }
    const completed = await spawn("docker", [ "wait", containerId ], { encoding: "utf-8",
        maxBuffer: 1024,
        timeoutMs: 300_000 });
    if (completed.stdout?.toString().trim() !== "0") {
        throw new Error("The isolated init container did not exit successfully");
    }
}

await seed();
console.log("e2e environment ready");
