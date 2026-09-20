import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Stack } from "../../backend/stack";
import { DockerSocketHandler } from "../../backend/agent-socket-handlers/docker-socket-handler";
import { AgentSocket } from "../../common/agent-socket";
import { hashStackFileContent, recoverStackWrites, StackMetadataWriteError, StackSelectionConflictError, StackWriteConflictError, STACK_WRITE_JOURNAL_DIR, writeStackFiles } from "../../backend/stack-write";
import { StackConfig } from "../../backend/stack-config";
import { Settings } from "../../backend/settings";
import type { StackFileBaseline, StackFileConfig } from "../../common/types/stack";
import { withStackLock } from "../../backend/stack-lock";
import type { DockgeServer } from "../../backend/dockge-server";
import { withDatabase, makeAuthenticatedSocket } from "../helpers/database";

const composeYAML = "services:\n  app:\n    image: nginx:old\n";
const editedYAML = "services:\n  app:\n    image: nginx:new\n";

/**
 * A stack directory with the files a test needs
 * @param dataDir Data directory of the fake server
 * @param stacksDir Directory holding the stacks
 * @param files File names and their content
 * @returns Server-like object and the stack directory
 */
async function makeStack(dataDir : string, stacksDir : string, files : Record<string, string>) {
    const stackDir = path.join(stacksDir, "write-stack");
    await mkdir(stackDir, { recursive: true });

    for (const [ name, content ] of Object.entries(files)) {
        await writeFile(path.join(stackDir, name), content);
    }

    const server = { stacksDir,
        config: { dataDir },
        sendStackList: () => undefined } as unknown as DockgeServer;

    return { server,
        stackDir };
}

/**
 * Call an agent event and wait for its acknowledgement
 * @param agentSocket Socket the handler is registered on
 * @param event Event name
 * @param args Arguments before the acknowledgement
 * @returns The response the handler sent back
 */
function call(agentSocket : AgentSocket, event : string, ...args : unknown[]) : Promise<{ ok : boolean, msg? : unknown, fileHashes? : { compose? : string | null, env? : string | null } }> {
    return new Promise((resolve) => {
        agentSocket.call(event, ...args, resolve);
    });
}

test("a failed write leaves the other files of the same save untouched", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n" });
        const stack = new Stack(server, "write-stack", editedYAML, "VALUE=new\n", true);

        // The env file cannot be written: the compose file must not keep the new text
        await assert.rejects(writeStackFiles(stackDir, [
            { name: "compose.yaml",
                content: editedYAML },
            { name: ".env",
                content: "VALUE=new\n" },
        ], { journalRoot: dataDir,
            beforeWrite: async (fileName) => {
                if (fileName === ".env") {
                    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
                }
            } }), /no space left on device/);

        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "VALUE=old\n");

        // The journal of a rolled back write is removed, it has nothing left to recover
        assert.deepEqual(await readdir(path.join(dataDir, STACK_WRITE_JOURNAL_DIR)), []);

        // The stack is still readable and unchanged
        assert.equal(stack.name, "write-stack");
    });
});

test("a file this save created is removed again when a later file fails", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });

        await assert.rejects(writeStackFiles(stackDir, [
            { name: ".env",
                content: "VALUE=new\n",
                expectedHash: null },
            { name: "compose.yaml",
                content: editedYAML },
        ], { journalRoot: dataDir,
            beforeWrite: async (fileName) => {
                if (fileName === "compose.yaml") {
                    throw new Error("disk is gone");
                }
            } }), /disk is gone/);

        await assert.rejects(stat(path.join(stackDir, ".env")), /ENOENT/);
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
    });
});

test("a save that states what it read is refused when the file changed meanwhile", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });
        const baseline = hashStackFileContent(composeYAML);

        // The first editor saves
        await writeStackFiles(stackDir, [{ name: "compose.yaml",
            content: editedYAML,
            expectedHash: baseline }], { journalRoot: dataDir });

        // The second editor still holds the version from before and is told so
        await assert.rejects(writeStackFiles(stackDir, [{ name: "compose.yaml",
            content: "services:\n  app:\n    image: nginx:other\n",
            expectedHash: baseline }], { journalRoot: dataDir }), (error : unknown) => {
            assert.ok(error instanceof StackWriteConflictError);
            assert.equal((error as Error).message, "stackFileChangedElsewhere");
            assert.deepEqual((error as { values? : unknown }).values, { file: "compose.yaml" });
            return true;
        });

        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), editedYAML);
    });
});

test("two editors of the same stack do not overwrite each other through saveStack", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n" });
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        const loaded = await (await Stack.getStack(server, "write-stack")).toJSON("") as { fileHashes : { compose : string, env : string } };
        const baseline = loaded.fileHashes;

        const first = await call(agentSocket, "saveStack", "write-stack", editedYAML, "VALUE=old\n", false, baseline);
        assert.equal(first.ok, true);
        assert.equal(first.fileHashes?.compose, hashStackFileContent(editedYAML));

        // The second editor started from the same text and is refused, not merged silently
        const second = await call(agentSocket, "saveStack", "write-stack", "services:\n  app:\n    image: nginx:second\n", "VALUE=old\n", false, baseline);
        assert.equal(second.ok, false);
        assert.deepEqual(second.msg, { key: "stackFileChangedElsewhere",
            values: { file: "compose.yaml" } });

        // Saving from the hashes the first save returned works again
        const third = await call(agentSocket, "saveStack", "write-stack", "services:\n  app:\n    image: nginx:third\n", "VALUE=old\n", false, first.fileHashes);
        assert.equal(third.ok, true);
    });
});

test("an editor that changed the env file alone is still told about a changed compose file", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n" });
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        const stale = { compose: hashStackFileContent("services:\n  app:\n    image: nginx:gone\n"),
            env: hashStackFileContent("VALUE=old\n") };

        const response = await call(agentSocket, "saveStack", "write-stack", composeYAML, "VALUE=new\n", false, stale);
        assert.equal(response.ok, false);

        // Neither file was written: a refused save changes nothing at all
        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "VALUE=old\n");
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
    });
});

test("a save without a baseline still writes, so an explicit overwrite stays possible", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        const response = await call(agentSocket, "saveStack", "write-stack", editedYAML, "", false);
        assert.equal(response.ok, true);
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), editedYAML);
    });
});

test("a baseline that is not a pair of hashes is refused before anything is written", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        for (const baseline of [ "nope", { compose: "short" }, { env: 5 }, [ "compose" ]]) {
            const response = await call(agentSocket, "saveStack", "write-stack", editedYAML, "", false, baseline);
            assert.equal(response.ok, false, `a baseline of ${JSON.stringify(baseline)} should be refused`);
        }

        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
    });
});

test("an interrupted save is finished or undone on the next start", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n" });

        // The process dies after the files were written but before the journal was committed
        await assert.rejects(writeStackFiles(stackDir, [
            { name: "compose.yaml",
                content: editedYAML },
            { name: ".env",
                content: "VALUE=new\n" },
        ], { journalRoot: dataDir,
            beforeCommit: async () => {
                throw Object.assign(new Error("power cut"), { code: "EIO" });
            } }), /power cut/);

        // The rollback already restored both files
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "VALUE=old\n");

        // A journal left behind by a process that could not roll back is undone at startup
        const journal = path.join(dataDir, STACK_WRITE_JOURNAL_DIR, "left-behind");
        await mkdir(path.join(journal, "before"), { recursive: true });
        await mkdir(path.join(journal, "after"));
        await writeFile(path.join(journal, "before", "compose.yaml"), composeYAML);
        await writeFile(path.join(journal, "after", "compose.yaml"), editedYAML);
        await writeFile(path.join(journal, "manifest.json"), JSON.stringify({ dir: stackDir,
            createdAt: Date.now(),
            files: [{ name: "compose.yaml",
                beforeHash: hashStackFileContent(composeYAML),
                afterHash: hashStackFileContent(editedYAML),
                mode: 0o644 }] }));
        await writeFile(path.join(stackDir, "compose.yaml"), editedYAML);

        assert.deepEqual(await recoverStackWrites(dataDir), { finished: 0,
            undone: 1,
            unresolved: 0 });
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
        assert.deepEqual(await readdir(path.join(dataDir, STACK_WRITE_JOURNAL_DIR)), []);
    });
});

test("a committed journal is rolled forward instead of undone", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n" });

        const journal = path.join(dataDir, STACK_WRITE_JOURNAL_DIR, "committed-one");
        await mkdir(path.join(journal, "before"), { recursive: true });
        await mkdir(path.join(journal, "after"));
        await writeFile(path.join(journal, "before", ".env"), "VALUE=old\n");
        await writeFile(path.join(journal, "after", ".env"), "VALUE=new\n");
        await writeFile(path.join(journal, "manifest.json"), JSON.stringify({ dir: stackDir,
            createdAt: Date.now(),
            files: [{ name: ".env",
                beforeHash: hashStackFileContent("VALUE=old\n"),
                afterHash: hashStackFileContent("VALUE=new\n"),
                mode: 0o644 }] }));
        await writeFile(path.join(journal, "committed"), "");

        assert.deepEqual(await recoverStackWrites(dataDir), { finished: 1,
            undone: 0,
            unresolved: 0 });
        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "VALUE=new\n");
    });
});

test("a file edited after the crash is left alone and its journal is kept for the user", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": "services:\n  app:\n    image: nginx:hand-edited\n" });

        const journal = path.join(dataDir, STACK_WRITE_JOURNAL_DIR, "third-text");
        await mkdir(path.join(journal, "before"), { recursive: true });
        await mkdir(path.join(journal, "after"));
        await writeFile(path.join(journal, "before", "compose.yaml"), composeYAML);
        await writeFile(path.join(journal, "after", "compose.yaml"), editedYAML);
        await writeFile(path.join(journal, "manifest.json"), JSON.stringify({ dir: stackDir,
            createdAt: Date.now(),
            files: [{ name: "compose.yaml",
                beforeHash: hashStackFileContent(composeYAML),
                afterHash: hashStackFileContent(editedYAML),
                mode: 0o644 }] }));

        assert.deepEqual(await recoverStackWrites(dataDir), { finished: 0,
            undone: 0,
            unresolved: 1 });
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), "services:\n  app:\n    image: nginx:hand-edited\n");

        // The originals stay available under a name the log points at
        assert.deepEqual(await readdir(path.join(dataDir, STACK_WRITE_JOURNAL_DIR)), [ "unresolved-third-text" ]);
    });
});

test("an unreadable file is reported instead of being shown as empty", async (t) => {
    if (process.getuid?.() === 0) {
        t.skip("root can read a file with no permissions at all");
        return;
    }

    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n" });
        await chmod(path.join(stackDir, ".env"), 0o000);

        try {
            const stack = await Stack.getStack(server, "write-stack");
            const json = await stack.toJSON("") as { composeENV : string, fileHashes : { env : string | null }, readIssues : { fileName : string, code : string }[] };

            assert.equal(json.composeENV, "");
            assert.equal(json.fileHashes.env, null);
            assert.deepEqual(json.readIssues, [{ fileName: ".env",
                code: "EACCES" }]);
            assert.equal(stack.filesAreReadable, false);
        } finally {
            await chmod(path.join(stackDir, ".env"), 0o644);
        }
    });
});

test("a missing optional env file is an ordinary state, not a read failure", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });
        const stack = await Stack.getStack(server, "write-stack");
        const json = await stack.toJSON("") as { composeENV : string, fileHashes : { env : string | null }, readIssues : unknown[] };

        assert.equal(json.composeENV, "");
        assert.equal(json.fileHashes.env, null);
        assert.deepEqual(json.readIssues, []);
        assert.equal(stack.filesAreReadable, true);
    });
});

test("writes of the same stack are serialised, and a nested write does not deadlock", async () => {
    const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-lock-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dockge-lock-data-"));

    try {
        const stackDir = path.join(stacksDir, "locked-stack");
        await mkdir(stackDir);
        await writeFile(path.join(stackDir, "compose.yaml"), composeYAML);

        const order : string[] = [];
        const first = withStackLock(stackDir, async () => {
            order.push("first-start");
            await new Promise((resolve) => setTimeout(resolve, 30));

            // A write inside an operation that already holds the lock has to go through
            await writeStackFiles(stackDir, [{ name: "compose.yaml",
                content: editedYAML }], { journalRoot: dataDir });
            order.push("first-end");
        });
        const second = withStackLock(stackDir, async () => {
            order.push("second");
        });

        await Promise.all([ first, second ]);
        assert.deepEqual(order, [ "first-start", "first-end", "second" ]);
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), editedYAML);
    } finally {
        await rm(stacksDir, { recursive: true,
            force: true });
        await rm(dataDir, { recursive: true,
            force: true });
    }
});

/**
 * A stored selection for a stack that uses one compose file and the env files given
 * @param composeFileName Compose file the stack works with
 * @param envFileNames Env files compose interpolates, the first one is the active one
 * @returns Selection ready to be stored
 */
function selection(composeFileName : string, envFileNames : string[] = []) : StackFileConfig {
    return { composeFileName,
        envFileNames,
        activeEnvFileName: envFileNames[0] ?? "",
        secretBindings: [] };
}

test("a save is refused when the stack was pointed at another file holding the same text", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        // Two files with the same bytes: the hashes cannot tell them apart, only the name can
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            "staging.yaml": composeYAML });
        await StackConfig.set("write-stack", selection("compose.yaml"));

        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        const loaded = await (await Stack.getStack(server, "write-stack")).toJSON("") as { fileHashes : StackFileBaseline };
        const baseline = loaded.fileHashes;
        assert.equal(baseline.composeFileName, "compose.yaml");

        // The files screen points the stack at the other file while the editor is open
        await StackConfig.set("write-stack", selection("staging.yaml"));

        const response = await call(agentSocket, "saveStack", "write-stack", editedYAML, "", false, baseline);
        assert.equal(response.ok, false);
        assert.deepEqual(response.msg, { key: "stackSelectionChangedElsewhere",
            values: { expected: "compose.yaml",
                actual: "staging.yaml" } });

        // Neither file was touched: the text of the editor never reached the file it
        // never showed, and the file it did show is not silently left behind either
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
        assert.equal(await readFile(path.join(stackDir, "staging.yaml"), "utf8"), composeYAML);
    });
});

test("the same save goes through while the stack still works with the file the editor read", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            "staging.yaml": composeYAML });
        await StackConfig.set("write-stack", selection("compose.yaml"));

        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        const loaded = await (await Stack.getStack(server, "write-stack")).toJSON("") as { fileHashes : StackFileBaseline };
        const response = await call(agentSocket, "saveStack", "write-stack", editedYAML, "", false, loaded.fileHashes);

        assert.equal(response.ok, true);
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), editedYAML);
        assert.equal(await readFile(path.join(stackDir, "staging.yaml"), "utf8"), composeYAML);

        // The answer names the files it wrote, so the next save of the same editor is
        // still held to them
        const next = response.fileHashes as StackFileBaseline;
        assert.equal(next.composeFileName, "compose.yaml");
        assert.equal(next.compose, hashStackFileContent(editedYAML));
    });
});

test("a save is refused when the stack was pointed at another env file holding the same text", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n",
            "staging.env": "VALUE=old\n" });
        await StackConfig.set("write-stack", selection("compose.yaml", [ ".env" ]));

        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        const loaded = await (await Stack.getStack(server, "write-stack")).toJSON("") as { fileHashes : StackFileBaseline };
        assert.equal(loaded.fileHashes.envFileName, ".env");

        await StackConfig.set("write-stack", selection("compose.yaml", [ "staging.env" ]));

        const response = await call(agentSocket, "saveStack", "write-stack", composeYAML, "VALUE=new\n", false, loaded.fileHashes);
        assert.equal(response.ok, false);
        assert.deepEqual(response.msg, { key: "stackSelectionChangedElsewhere",
            values: { expected: ".env",
                actual: "staging.env" } });

        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "VALUE=old\n");
        assert.equal(await readFile(path.join(stackDir, "staging.env"), "utf8"), "VALUE=old\n");
    });
});

test("a baseline whose file names are not plain names of the directory is refused", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);
        const compose = hashStackFileContent(composeYAML);

        const refused = [
            { compose,
                composeFileName: "../compose.yaml" },
            { compose,
                composeFileName: "/etc/compose.yaml" },
            { compose,
                composeFileName: 5 },
            { compose,
                envFileName: "../../.env" },
        ];

        for (const baseline of refused) {
            const response = await call(agentSocket, "saveStack", "write-stack", editedYAML, "", false, baseline);
            assert.equal(response.ok, false, `a baseline of ${JSON.stringify(baseline)} should be refused`);
        }

        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
    });
});

test("the files are not saved when the selection that belongs to them cannot be stored", async (t) => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        // The settings store is unavailable exactly while the save runs, so the note that
        // compose interpolates the new env file cannot be written
        t.mock.method(Settings, "set", async () => {
            throw new Error("database is locked");
        });

        const response = await call(agentSocket, "saveStack", "write-stack", editedYAML, "VALUE=new\n", false);
        t.mock.restoreAll();

        assert.equal(response.ok, false);
        assert.deepEqual(response.msg, { key: "stackSelectionNotStored",
            values: { stack: "write-stack" } });

        // A stack whose .env exists while nothing says compose reads it would run with
        // other values than the screen shows, so the file is gone again
        await assert.rejects(stat(path.join(stackDir, ".env")), /ENOENT/);
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);
        assert.deepEqual(await readdir(path.join(dataDir, STACK_WRITE_JOURNAL_DIR)), []);
        assert.equal(await StackConfig.get("write-stack"), null);
    });
});

test("a save that adopts an env file stores the selection that goes with it", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        const response = await call(agentSocket, "saveStack", "write-stack", editedYAML, "VALUE=new\n", false);

        assert.equal(response.ok, true);
        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "VALUE=new\n");
        assert.deepEqual(await StackConfig.get("write-stack"), selection("compose.yaml", [ ".env" ]));
    });
});

test("a selection stored by a save that then fails is put back with the files", async (t) => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server, stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(makeAuthenticatedSocket(), server, agentSocket);

        const stored = selection("compose.yaml");
        await StackConfig.set("write-stack", stored);

        // The save fails in the step right after the selection went in: the name of the
        // commit marker is occupied, so the write is never declared finished
        const realSet = Settings.set.bind(Settings);
        t.mock.method(Settings, "set", async (key : string, value : object | string | number | boolean, type : string | null = null) => {
            await realSet(key, value, type);
            const root = path.join(dataDir, STACK_WRITE_JOURNAL_DIR);
            for (const entry of await readdir(root).catch(() => [])) {
                await mkdir(path.join(root, entry, "committed"), { recursive: true });
            }
        });

        const response = await call(agentSocket, "saveStack", "write-stack", editedYAML, "VALUE=new\n", false);
        t.mock.restoreAll();

        assert.equal(response.ok, false);
        await assert.rejects(stat(path.join(stackDir, ".env")), /ENOENT/);
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);

        // The selection describes the files that are really there again
        assert.deepEqual(await StackConfig.get("write-stack"), stored);
        assert.deepEqual(await readdir(path.join(dataDir, STACK_WRITE_JOURNAL_DIR)), []);
    });
});

test("a write that changes nothing but the selection still has to store it", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n" });
        const adopted = selection("compose.yaml", [ ".env" ]);

        const result = await writeStackFiles(stackDir, [{ name: ".env",
            content: "VALUE=old\n" }], { journalRoot: dataDir,
            metadata: { stack: "write-stack",
                before: null,
                after: adopted } });

        assert.deepEqual(result.changed, []);
        assert.deepEqual(await StackConfig.get("write-stack"), adopted);
    });
});

test("a selection that cannot be stored fails the write even when no file changes", async (t) => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=old\n" });
        t.mock.method(Settings, "set", async () => {
            throw new Error("database is locked");
        });

        await assert.rejects(writeStackFiles(stackDir, [{ name: ".env",
            content: "VALUE=old\n" }], { journalRoot: dataDir,
            metadata: { stack: "write-stack",
                before: null,
                after: selection("compose.yaml", [ ".env" ]) } }), (error : unknown) => {
            assert.ok(error instanceof StackMetadataWriteError);
            assert.deepEqual((error as { values? : unknown }).values, { stack: "write-stack" });
            return true;
        });

        t.mock.restoreAll();
        assert.equal(await StackConfig.get("write-stack"), null);
    });
});

test("an interrupted save takes its file selection back with the files", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=new\n" });

        // The crash happened after the selection was stored and before the write was
        // declared finished, so both the file and the selection are ahead of the truth
        await StackConfig.set("write-stack", selection("compose.yaml", [ ".env" ]));

        const journal = path.join(dataDir, STACK_WRITE_JOURNAL_DIR, "half-adopted");
        await mkdir(path.join(journal, "before"), { recursive: true });
        await mkdir(path.join(journal, "after"));
        await writeFile(path.join(journal, "after", ".env"), "VALUE=new\n");
        await writeFile(path.join(journal, "manifest.json"), JSON.stringify({ dir: stackDir,
            createdAt: Date.now(),
            files: [{ name: ".env",
                beforeHash: null,
                afterHash: hashStackFileContent("VALUE=new\n"),
                mode: 0o644 }],
            metadata: { stack: "write-stack",
                before: null,
                after: selection("compose.yaml", [ ".env" ]) } }));

        assert.deepEqual(await recoverStackWrites(dataDir), { finished: 0,
            undone: 1,
            unresolved: 0 });

        // The env file this save created is gone, and so is the note that compose reads it
        await assert.rejects(stat(path.join(stackDir, ".env")), /ENOENT/);
        assert.equal(await StackConfig.get("write-stack"), null);
    });
});

test("a committed save whose selection was lost gets it back on the next start", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            ".env": "VALUE=new\n" });
        const adopted = selection("compose.yaml", [ ".env" ]);

        const journal = path.join(dataDir, STACK_WRITE_JOURNAL_DIR, "committed-adoption");
        await mkdir(path.join(journal, "before"), { recursive: true });
        await mkdir(path.join(journal, "after"));
        await writeFile(path.join(journal, "after", ".env"), "VALUE=new\n");
        await writeFile(path.join(journal, "manifest.json"), JSON.stringify({ dir: stackDir,
            createdAt: Date.now(),
            files: [{ name: ".env",
                beforeHash: null,
                afterHash: hashStackFileContent("VALUE=new\n"),
                mode: 0o644 }],
            metadata: { stack: "write-stack",
                before: null,
                after: adopted } }));
        await writeFile(path.join(journal, "committed"), "");

        assert.deepEqual(await recoverStackWrites(dataDir), { finished: 1,
            undone: 0,
            unresolved: 0 });

        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "VALUE=new\n");
        assert.deepEqual(await StackConfig.get("write-stack"), adopted);
    });
});

test("a selection that cannot be put back keeps the journal for the user", async (t) => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { stackDir } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML });

        const journal = path.join(dataDir, STACK_WRITE_JOURNAL_DIR, "store-is-gone");
        await mkdir(path.join(journal, "before"), { recursive: true });
        await mkdir(path.join(journal, "after"));
        await writeFile(path.join(journal, "before", "compose.yaml"), composeYAML);
        await writeFile(path.join(journal, "after", "compose.yaml"), editedYAML);
        await writeFile(path.join(journal, "manifest.json"), JSON.stringify({ dir: stackDir,
            createdAt: Date.now(),
            files: [{ name: "compose.yaml",
                beforeHash: hashStackFileContent(composeYAML),
                afterHash: hashStackFileContent(editedYAML),
                mode: 0o644 }],
            metadata: { stack: "write-stack",
                before: selection("compose.yaml"),
                after: selection("compose.yaml", [ ".env" ]) } }));

        t.mock.method(Settings, "set", async () => {
            throw new Error("database is locked");
        });

        // The files are already back, but the selection is not: that is not a finished
        // recovery, so nobody is told the stack is in a known state
        assert.deepEqual(await recoverStackWrites(dataDir), { finished: 0,
            undone: 0,
            unresolved: 1 });
        t.mock.restoreAll();

        assert.deepEqual(await readdir(path.join(dataDir, STACK_WRITE_JOURNAL_DIR)), [ "unresolved-store-is-gone" ]);
    });
});

test("a selection conflict is a validation error, so the browser is told which file to re-read", async () => {
    await withDatabase(async ({ dataDir, stacksDir }) => {
        const { server } = await makeStack(dataDir, stacksDir, { "compose.yaml": composeYAML,
            "staging.yaml": composeYAML });
        await StackConfig.set("write-stack", selection("staging.yaml"));

        const stack = new Stack(server, "write-stack", editedYAML, "", false);

        await assert.rejects(stack.save(false, { compose: hashStackFileContent(composeYAML),
            composeFileName: "compose.yaml" }), (error : unknown) => {
            assert.ok(error instanceof StackSelectionConflictError);
            assert.deepEqual((error as { values? : unknown }).values, { expected: "compose.yaml",
                actual: "staging.yaml" });
            return true;
        });
    });
});
