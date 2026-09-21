import { strict as assert } from "node:assert";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { DockgeServer } from "../../backend/dockge-server";
import { Stack } from "../../backend/stack";
import { Terminal } from "../../backend/terminal";
import { ValidationError, type DockgeSocket } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

for (const scenario of [ "unavailable", "invalid-output", "stop-fails", "rm-fails" ]) {
    test(`recovery deletion keeps stack files when Docker ${scenario}`, async (t) => {
        await withDatabase(async ({ dataDir, stacksDir }) => {
            const directory = path.join(stacksDir, "broken");
            const bin = path.join(dataDir, "bin");
            await mkdir(directory);
            await mkdir(bin);
            const compose = "services: [broken yaml\n";
            await writeFile(path.join(directory, "compose.yaml"), compose);
            const id = "a".repeat(64);
            const stdout = scenario === "invalid-output" ? "not-an-id" : id;
            await writeFile(path.join(bin, "docker"), `#!${process.execPath}
process.stdout.write(${JSON.stringify(stdout)});
process.exit(${scenario === "unavailable" ? 1 : 0});
`, { mode: 0o700 });
            const originalPath = process.env.PATH;
            const commands : string[][] = [];
            t.mock.method(Stack.prototype, "validateComposeConfig", async () => {
                throw new ValidationError("Broken compose");
            });
            t.mock.method(Terminal, "exec", async (_server : unknown, _socket : unknown, _name : unknown, _file : unknown, args : string[]) => {
                commands.push(args);
                return args[0] === (scenario === "stop-fails" ? "stop" : "rm") ? 1 : 0;
            });
            process.env.PATH = `${bin}:${originalPath}`;
            try {
                const stack = await Stack.getStack({ stacksDir } as DockgeServer, "broken");
                await assert.rejects(stack.delete({ endpoint: "" } as DockgeSocket));
                assert.equal(await readFile(path.join(directory, "compose.yaml"), "utf8"), compose);
                await access(directory);
                const expected = scenario === "stop-fails" ? [[ "stop", id ]]
                    : scenario === "rm-fails" ? [[ "stop", id ], [ "rm", id ]] : [];
                assert.deepEqual(commands, expected);
            } finally {
                if (originalPath === undefined) {
                    delete process.env.PATH;
                } else {
                    process.env.PATH = originalPath;
                }
            }
        });
    });
}
