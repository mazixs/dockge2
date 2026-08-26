import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Stack } from "../../backend/stack";
import { StackConfig } from "../../backend/stack-config";
import { fileExists, ValidationError } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

const composeYAML = `services:
  app:
    image: nginx
  db:
    image: mariadb
`;

/**
 * Create a stacks directory holding one stack with the given files
 * @param files File name to content inside the stack directory
 * @returns Stacks directory and stack directory
 */
async function makeStack(files : Record<string, string>) : Promise<{ stacksDir : string, stackDir : string }> {
    const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-files-"));
    const stackDir = path.join(stacksDir, "files-stack");
    await mkdir(stackDir);

    for (const [ name, content ] of Object.entries(files)) {
        await writeFile(path.join(stackDir, name), content);
    }

    return { stacksDir,
        stackDir };
}

test("compose commands name the selected file and env files explicitly", async () => {
    await withDatabase(async () => {
        const { stacksDir, stackDir } = await makeStack({
            "compose.yaml": composeYAML,
            "staging.yml": composeYAML,
            ".env": "BASE=1\n",
            ".env.product": "STAGE=product\n",
        });

        try {
            const server = { stacksDir } as never;

            // Without metadata the historic behaviour is kept: compose.yaml plus .env
            const legacy = await Stack.getStack(server, "files-stack");
            assert.deepEqual(legacy.getComposeOptions("ps", "--format", "json"), [
                "compose", "--env-file", "./.env", "-f", "compose.yaml", "ps", "--format", "json",
            ]);

            // An explicit selection changes both the file and the env order
            await legacy.setFileConfig({
                composeFileName: "staging.yml",
                envFileNames: [ ".env", ".env.product" ],
                activeEnvFileName: ".env.product",
                secretBindings: [],
            });

            assert.deepEqual(legacy.getComposeOptions("up", "-d"), [
                "compose", "--env-file", "./.env", "--env-file", "./.env.product", "-f", "staging.yml", "up", "-d",
            ]);

            // The selection survives a reload and drives which env the UI shows
            const reloaded = await Stack.getStack(server, "files-stack");
            assert.equal(reloaded.composeFileName, "staging.yml");
            assert.equal(reloaded.activeEnvFileName, ".env.product");
            assert.equal(reloaded.composeENV, "STAGE=product\n");

            // The global env file stays the outermost source
            await writeFile(path.join(stacksDir, "global.env"), "GLOBAL=1\n");
            const withGlobal = await Stack.getStack(server, "files-stack");
            assert.deepEqual(withGlobal.getComposeOptions("ps"), [
                "compose", "--env-file", "../global.env", "--env-file", "./.env", "--env-file", "./.env.product", "-f", "staging.yml", "ps",
            ]);

            // A missing env file is not passed to compose, which would abort the command
            await rm(path.join(stackDir, ".env"));
            const missingEnv = await Stack.getStack(server, "files-stack");
            assert.deepEqual(missingEnv.getComposeOptions("ps"), [
                "compose", "--env-file", "../global.env", "--env-file", "./.env.product", "-f", "staging.yml", "ps",
            ]);
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("an invalid file selection is rejected", async () => {
    await withDatabase(async () => {
        const { stacksDir } = await makeStack({
            "compose.yaml": composeYAML,
            ".env": "BASE=1\n",
        });

        try {
            const stack = await Stack.getStack({ stacksDir } as never, "files-stack");

            for (const config of [
                { composeFileName: "../outside.yaml",
                    envFileNames: [],
                    activeEnvFileName: "",
                    secretBindings: [] },
                { composeFileName: "missing.yaml",
                    envFileNames: [],
                    activeEnvFileName: "",
                    secretBindings: [] },
                { composeFileName: "compose.yaml",
                    envFileNames: [ ".secret" ],
                    activeEnvFileName: "",
                    secretBindings: [] },
            ]) {
                await assert.rejects(stack.setFileConfig(config), ValidationError);
            }

            // A rejected selection does not change the stack
            assert.equal(stack.composeFileName, "compose.yaml");
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("env files are written to the selected file only", async () => {
    await withDatabase(async () => {
        const { stacksDir, stackDir } = await makeStack({
            "compose.yaml": composeYAML,
            ".env": "BASE=1\n",
            ".env.dev": "STAGE=dev\n",
        });

        try {
            const stack = await Stack.getStack({ stacksDir } as never, "files-stack");
            await stack.writeEnvFile(".env.dev", "STAGE=dev2\n");

            assert.equal(await readFile(path.join(stackDir, ".env.dev"), "utf8"), "STAGE=dev2\n");
            assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "BASE=1\n");

            await assert.rejects(stack.writeEnvFile("../outside.env", "X=1\n"), ValidationError);
            await assert.rejects(stack.writeEnvFile(".secret", "X=1\n"), ValidationError);
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("secret files are stored with restricted permissions and never leak into the stack response", async () => {
    await withDatabase(async () => {
        const { stacksDir, stackDir } = await makeStack({
            "compose.yaml": composeYAML,
            ".env": "BASE=1\n",
        });

        try {
            const stack = await Stack.getStack({ stacksDir } as never, "files-stack");

            await stack.writeSecretFile(".secret.db", "db-password");

            const secretStat = await stat(path.join(stackDir, ".secret.db"));
            if (process.platform !== "win32") {
                assert.equal(secretStat.mode & 0o777, 0o600);
            }

            const meta = await stack.listSecretFiles();
            assert.deepEqual(meta.map((item) => item.fileName), [ ".secret.db" ]);
            assert.equal(meta[0]?.size, "db-password".length);
            assert.equal(meta[0]?.secretName, "");

            // The stack response carries metadata, never the secret itself
            const json = JSON.stringify(await stack.toJSON(""));
            assert.equal(json.includes("db-password"), false);
            assert.equal(json.includes(".secret.db"), true);

            // Reading the content is a separate, explicit call
            assert.equal(await stack.readSecretFile(".secret.db"), "db-password");
            await assert.rejects(stack.readSecretFile(".secret.missing"), ValidationError);
            await assert.rejects(stack.readSecretFile("../outside.secret"), ValidationError);
            await assert.rejects(stack.writeSecretFile(".env", "x"), ValidationError);
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("binding a secret edits the compose file only on that action", async () => {
    await withDatabase(async () => {
        const { stacksDir, stackDir } = await makeStack({
            "compose.yaml": "services:\n  app:\n    image: nginx # keep me\n  db:\n    image: mariadb\n",
            ".secret.db": "db-password",
        });

        try {
            const stack = await Stack.getStack({ stacksDir } as never, "files-stack");

            await stack.bindSecret("db_password", ".secret.db", [ "db" ]);

            const yamlText = await readFile(path.join(stackDir, "compose.yaml"), "utf8");
            assert.match(yamlText, /secrets:\n {2}db_password:\n {4}file: \.\/\.secret\.db/);
            assert.match(yamlText, /services:[\s\S]*db:[\s\S]*secrets:\n {6}- db_password/);

            // Unrelated content and comments stay untouched
            assert.match(yamlText, /image: nginx # keep me/);

            // The secret is not turned into environment variables
            assert.equal(yamlText.includes("environment"), false);
            assert.equal(yamlText.includes("db-password"), false);

            const meta = await stack.listSecretFiles();
            assert.equal(meta[0]?.secretName, "db_password");
            assert.deepEqual(meta[0]?.services, [ "db" ]);

            const stored = await StackConfig.get("files-stack");
            assert.deepEqual(stored?.secretBindings, [
                { name: "db_password",
                    fileName: ".secret.db",
                    services: [ "db" ] },
            ]);

            // An unknown service or a missing file is refused before touching YAML
            await assert.rejects(stack.bindSecret("other", ".secret.db", [ "nope" ]), ValidationError);
            await assert.rejects(stack.bindSecret("other", ".secret.missing", [ "db" ]), ValidationError);
            await assert.rejects(stack.bindSecret("bad name", ".secret.db", [ "db" ]), ValidationError);

            await stack.unbindSecret("db_password");

            const cleaned = await readFile(path.join(stackDir, "compose.yaml"), "utf8");
            assert.equal(cleaned.includes("db_password"), false);
            assert.equal(cleaned.includes("secrets:"), false);
            assert.match(cleaned, /image: nginx # keep me/);
            assert.deepEqual((await StackConfig.get("files-stack"))?.secretBindings, []);
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("deleting a secret file removes its binding too", async () => {
    await withDatabase(async () => {
        const { stacksDir, stackDir } = await makeStack({
            "compose.yaml": composeYAML,
            ".secret.db": "db-password",
        });

        try {
            const stack = await Stack.getStack({ stacksDir } as never, "files-stack");
            await stack.bindSecret("db_password", ".secret.db", [ "db" ]);

            await stack.deleteSecretFile(".secret.db");

            assert.deepEqual(await stack.listSecretFiles(), []);
            assert.deepEqual((await StackConfig.get("files-stack"))?.secretBindings, []);
            assert.equal((await readFile(path.join(stackDir, "compose.yaml"), "utf8")).includes("db_password"), false);
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("saving an existing stack writes the selected files, not the historic defaults", async () => {
    await withDatabase(async () => {
        const { stacksDir, stackDir } = await makeStack({
            "compose.yaml": composeYAML,
            "staging.yml": composeYAML,
            ".env": "STAGE=base\n",
            ".env.dev": "STAGE=dev\n",
        });

        try {
            const server = { stacksDir,
                sendStackList: () => undefined } as never;

            const stack = await Stack.getStack(server, "files-stack");
            await stack.setFileConfig({
                composeFileName: "staging.yml",
                envFileNames: [ ".env", ".env.dev" ],
                activeEnvFileName: ".env.dev",
                secretBindings: [],
            });

            // This is the production path: the socket handler builds the stack itself
            const edited = "services:\n  app:\n    image: nginx:1.27\n";
            const saved = new Stack(server, "files-stack", edited, "STAGE=dev2\n", false);
            await saved.save(false);

            // The edit lands in the selected files
            assert.equal(await readFile(path.join(stackDir, "staging.yml"), "utf8"), edited);
            assert.equal(await readFile(path.join(stackDir, ".env.dev"), "utf8"), "STAGE=dev2\n");

            // The historic defaults are left alone
            assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
            assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "STAGE=base\n");

            // And the deploy commands use the selected files too
            assert.deepEqual(saved.getComposeOptions("up", "-d"), [
                "compose", "--env-file", "./.env", "--env-file", "./.env.dev", "-f", "staging.yml", "up", "-d",
            ]);
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("a compose error never quotes a secret value", async () => {
    await withDatabase(async () => {
        const { stacksDir } = await makeStack({
            "compose.yaml": composeYAML,
            ".secret.db": "super-secret-token\n",
        });

        try {
            const stack = await Stack.getStack({ stacksDir } as never, "files-stack");
            await stack.bindSecret("db_password", ".secret.db", [ "db" ]);

            // A message that quotes the secret is redacted before it can reach a client
            const message = await stack.redactSecrets("failed to read super-secret-token from env");
            assert.equal(message.includes("super-secret-token"), false);
            assert.match(message, /\[secret\]/);

            // Unrelated text is untouched
            assert.equal(await stack.redactSecrets("services.app.image is required"), "services.app.image is required");
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("a stack directory that is a symlink cannot be written through", async () => {
    await withDatabase(async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "dockge-symlink-"));
        const stacksDir = path.join(root, "stacks");
        const outsideDir = path.join(root, "outside");
        await mkdir(stacksDir);
        await mkdir(outsideDir);
        await writeFile(path.join(outsideDir, "compose.yaml"), "services: {}\n");

        // Somebody with write access to the stacks directory points a stack at another place
        await symlink(outsideDir, path.join(stacksDir, "linked"), "dir");

        try {
            const server = { stacksDir } as never;

            // Reading is refused
            await assert.rejects(Stack.getStack(server, "linked"), ValidationError);

            // And so is the production save path, which builds the stack directly
            const stack = new Stack(server, "linked", "services:\n  app:\n    image: nginx\n", "KEY=value\n", true);
            await assert.rejects(stack.save(false), ValidationError);

            // The file behind the symlink is untouched
            assert.equal(await readFile(path.join(outsideDir, "compose.yaml"), "utf8"), "services: {}\n");
            assert.equal(await fileExists(path.join(outsideDir, ".env")), false);
        } finally {
            await rm(root, { recursive: true,
                force: true });
        }
    });
});

test("a file swapped for a symlink is not read or written", async () => {
    await withDatabase(async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "dockge-swap-"));
        const stacksDir = path.join(root, "stacks");
        const stackDir = path.join(stacksDir, "swap-stack");
        const outside = path.join(root, "outside.env");
        await mkdir(stackDir, { recursive: true });
        await writeFile(path.join(stackDir, "compose.yaml"), composeYAML);
        await writeFile(outside, "SECRET=outside\n");

        try {
            const server = { stacksDir } as never;
            const stack = await Stack.getStack(server, "swap-stack");

            // The env file passes validation as a regular file
            await writeFile(path.join(stackDir, ".env.swap"), "STAGE=ok\n");
            await stack.setFileConfig({
                composeFileName: "compose.yaml",
                envFileNames: [ ".env.swap" ],
                activeEnvFileName: ".env.swap",
                secretBindings: [],
            });
            assert.equal(stack.composeENV, "STAGE=ok\n");

            // Then it is swapped for a symlink pointing outside
            await rm(path.join(stackDir, ".env.swap"));
            await symlink(outside, path.join(stackDir, ".env.swap"), "file");

            const reloaded = await Stack.getStack(server, "swap-stack");

            // The content of the target is not exposed and the file is not offered to compose
            assert.equal(reloaded.composeENV, "");
            assert.equal(JSON.stringify(await reloaded.toJSON("")).includes("SECRET=outside"), false);
            assert.deepEqual(reloaded.getComposeOptions("ps"), [ "compose", "-f", "compose.yaml", "ps" ]);

            // Writing through the symlink is refused, the outside file keeps its content
            await assert.rejects(reloaded.writeEnvFile(".env.swap", "STAGE=hacked\n"), ValidationError);
            assert.equal(await readFile(outside, "utf8"), "SECRET=outside\n");
        } finally {
            await rm(root, { recursive: true,
                force: true });
        }
    });
});
