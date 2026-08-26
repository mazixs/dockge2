import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveStackFilePath, StackConfig } from "../../backend/stack-config";
import { ValidationError } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

/**
 * Create a stack directory with the given files
 * @param files File name to content
 * @returns Path of the stack directory
 */
async function makeStackDir(files : Record<string, string>) : Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dockge-stack-files-"));

    for (const [ name, content ] of Object.entries(files)) {
        await writeFile(path.join(dir, name), content);
    }

    return dir;
}

test("stack file paths are resolved only inside the stack directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dockge-file-path-"));
    const stackDir = path.join(root, "stack");
    const outsideDir = path.join(root, "outside");
    await mkdir(stackDir);
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, ".env"), "SECRET=outside\n");
    await writeFile(path.join(stackDir, "compose.yaml"), "services: {}\n");
    await symlink(path.join(outsideDir, ".env"), path.join(stackDir, ".env.linked"), "file");
    await mkdir(path.join(stackDir, "sub.yaml"));

    try {
        assert.equal(await resolveStackFilePath(stackDir, "compose.yaml"), path.join(stackDir, "compose.yaml"));

        // A file that does not exist yet is still a valid target for writing
        assert.equal(await resolveStackFilePath(stackDir, ".env.new"), path.join(stackDir, ".env.new"));

        for (const unsafe of [ "../outside/.env", "/etc/passwd", "..", "sub/compose.yaml", "notes.txt" ]) {
            await assert.rejects(resolveStackFilePath(stackDir, unsafe), ValidationError, `${unsafe} must be rejected`);
        }

        // A symlink with an accepted name still points outside
        await assert.rejects(resolveStackFilePath(stackDir, ".env.linked"), ValidationError);

        // A directory is not a file
        await assert.rejects(resolveStackFilePath(stackDir, "sub.yaml"), ValidationError);
    } finally {
        await rm(root, { recursive: true,
            force: true });
    }
});

test("a stack without metadata keeps its historic files", async () => {
    await withDatabase(async () => {
        const stackDir = await makeStackDir({
            "compose.yaml": "services: {}\n",
            ".env": "KEY=value\n",
            "README.md": "notes\n",
        });

        try {
            const inventory = await StackConfig.inventory(stackDir, "legacy-stack");

            assert.equal(inventory.config.composeFileName, "compose.yaml");
            assert.deepEqual(inventory.config.envFileNames, [ ".env" ]);
            assert.equal(inventory.config.activeEnvFileName, ".env");
            assert.equal(inventory.needsComposeSelection, false);
            assert.deepEqual(inventory.composeFileNames, [ "compose.yaml" ]);

            // Files that are neither compose, env nor secret are ignored
            assert.deepEqual(inventory.envFileNames, [ ".env" ]);
            assert.deepEqual(inventory.secretFiles, []);
        } finally {
            await rm(stackDir, { recursive: true,
                force: true });
        }
    });
});

test("several compose files ask for a decision without switching silently", async () => {
    await withDatabase(async () => {
        const stackDir = await makeStackDir({
            "compose.yaml": "services: {}\n",
            "docker-compose.yml": "services: {}\n",
            "staging.yml": "services: {}\n",
        });

        try {
            const first = await StackConfig.inventory(stackDir, "multi-stack");
            assert.equal(first.needsComposeSelection, true);

            // The fallback is deterministic, repeated reads never change it
            assert.equal(first.config.composeFileName, "compose.yaml");
            const second = await StackConfig.inventory(stackDir, "multi-stack");
            assert.equal(second.config.composeFileName, "compose.yaml");

            // After an explicit choice the question is gone and the choice survives
            await StackConfig.set("multi-stack", {
                composeFileName: "staging.yml",
                envFileNames: [],
                activeEnvFileName: "",
                secretBindings: [],
            });

            const third = await StackConfig.inventory(stackDir, "multi-stack");
            assert.equal(third.config.composeFileName, "staging.yml");
            assert.equal(third.needsComposeSelection, false);
        } finally {
            await rm(stackDir, { recursive: true,
                force: true });
        }
    });
});

test("env files, secrets and their metadata are reported without content", async () => {
    await withDatabase(async () => {
        const stackDir = await makeStackDir({
            "compose.yaml": "services: {}\n",
            ".env": "BASE=1\n",
            ".env.product": "STAGE=product\n",
            ".env.dev": "STAGE=dev\n",
            ".secret": "top-secret\n",
            ".secret.db": "db-password\n",
        });
        await chmod(path.join(stackDir, ".secret"), 0o600);

        try {
            await StackConfig.set("files-stack", {
                composeFileName: "compose.yaml",
                envFileNames: [ ".env", ".env.product" ],
                activeEnvFileName: ".env.product",
                secretBindings: [
                    { name: "db_password",
                        fileName: ".secret.db",
                        services: [ "db" ] },
                ],
            });

            const inventory = await StackConfig.inventory(stackDir, "files-stack");

            assert.deepEqual(inventory.config.envFileNames, [ ".env", ".env.product" ]);
            assert.equal(inventory.config.activeEnvFileName, ".env.product");
            assert.deepEqual(inventory.envFileNames, [ ".env", ".env.dev", ".env.product" ]);

            const bound = inventory.secretFiles.find((item) => item.fileName === ".secret.db");
            assert.ok(bound);
            assert.equal(bound.secretName, "db_password");
            assert.deepEqual(bound.services, [ "db" ]);
            assert.equal(bound.size, "db-password\n".length);
            assert.match(bound.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);

            const unbound = inventory.secretFiles.find((item) => item.fileName === ".secret");
            assert.ok(unbound);
            assert.equal(unbound.secretName, "");

            // No secret content anywhere in the inventory
            assert.equal(JSON.stringify(inventory).includes("db-password"), false);
            assert.equal(JSON.stringify(inventory).includes("top-secret"), false);
        } finally {
            await rm(stackDir, { recursive: true,
                force: true });
        }
    });
});

test("a selection is validated against the files on disk", async () => {
    await withDatabase(async () => {
        const stackDir = await makeStackDir({
            "compose.yaml": "services: {}\n",
            ".env": "BASE=1\n",
            ".secret.db": "db-password\n",
        });

        try {
            const valid = await StackConfig.validate(stackDir, {
                composeFileName: "compose.yaml",
                envFileNames: [ ".env", ".env" ],
                activeEnvFileName: ".env",
                secretBindings: [
                    { name: "db_password",
                        fileName: ".secret.db",
                        services: [ "db" ] },
                ],
            });

            // Duplicates are dropped instead of being passed twice to compose
            assert.deepEqual(valid.envFileNames, [ ".env" ]);

            await assert.rejects(StackConfig.validate(stackDir, {
                composeFileName: "missing.yaml",
                envFileNames: [],
                activeEnvFileName: "",
                secretBindings: [],
            }), ValidationError);

            await assert.rejects(StackConfig.validate(stackDir, {
                composeFileName: ".env",
                envFileNames: [],
                activeEnvFileName: "",
                secretBindings: [],
            }), ValidationError);

            await assert.rejects(StackConfig.validate(stackDir, {
                composeFileName: "compose.yaml",
                envFileNames: [ "../outside/.env" ],
                activeEnvFileName: "",
                secretBindings: [],
            }), ValidationError);

            await assert.rejects(StackConfig.validate(stackDir, {
                composeFileName: "compose.yaml",
                envFileNames: [],
                activeEnvFileName: "",
                secretBindings: [
                    { name: "bad name",
                        fileName: ".secret.db",
                        services: [] },
                ],
            }), ValidationError);
        } finally {
            await rm(stackDir, { recursive: true,
                force: true });
        }
    });
});

test("the stored selection of a deleted stack is forgotten", async () => {
    await withDatabase(async () => {
        await StackConfig.set("temp-stack", {
            composeFileName: "compose.yaml",
            envFileNames: [],
            activeEnvFileName: "",
            secretBindings: [],
        });
        assert.ok(await StackConfig.get("temp-stack"));

        await StackConfig.remove("temp-stack");
        assert.equal(await StackConfig.get("temp-stack"), null);

        // Removing twice is not an error
        await StackConfig.remove("temp-stack");
    });
});
