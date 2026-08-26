import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "../../backend/child-process";
import { Stack } from "../../backend/stack";
import { Terminal } from "../../backend/terminal";
import type { DockgeServer } from "../../backend/dockge-server";
import type { DockgeSocket } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

const enabled = process.env.DOCKGE_DOCKER_INTEGRATION === "1";
const skip = enabled ? false : "set DOCKGE_DOCKER_INTEGRATION=1 and provide a working Docker Compose to run this test";

/**
 * A client socket that ignores terminal output
 * @param id Socket id
 * @returns Fake client socket
 */
function makeSocket(id : string) : DockgeSocket {
    return {
        id,
        userID: 1,
        endpoint: "",
        connected: true,
        emitAgent: () => undefined,
    } as unknown as DockgeSocket;
}

/**
 * Count the shell processes running inside the container of a service
 * @param stack Stack under test
 * @param service Service name
 * @param shell Shell to look for
 * @returns Number of matching processes
 */
async function countShellProcesses(stack : Stack, service : string, shell : string) : Promise<number> {
    const res = await spawn("docker", stack.getComposeOptions("exec", "-T", service, "ps", "-o", "args"), {
        cwd: stack.path,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeoutMs: 60_000,
    });

    const lines = (res.stdout?.toString() ?? "").split("\n").map((line) => line.trim());

    // `ps` itself and the container command are not sessions we opened
    return lines.filter((line) => line === shell || line.endsWith(`/${shell}`)).length;
}

test("a container shell is gone after the last client leaves", { skip }, async () => {
    await withDatabase(async () => {
        const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-it-shell-"));
        const stackName = `dockge-it-shell-${process.pid}`;
        const stackDir = path.join(stacksDir, stackName);
        await mkdir(stackDir);

        await writeFile(path.join(stackDir, "compose.yaml"), `services:
  box:
    image: bash:5.2
    command: ["bash", "-c", "sleep 600"]
`);

        const server = { stacksDir } as unknown as DockgeServer;
        const stack = await Stack.getStack(server, stackName);
        const socket = makeSocket("client-1");

        try {
            await spawn("docker", stack.getComposeOptions("up", "-d", "--wait"), {
                cwd: stack.path,
                encoding: "utf-8",
                timeoutMs: 300_000,
            });

            // No interactive shell yet, only the container command
            assert.equal(await countShellProcesses(stack, "box", "sh"), 0);

            const terminalName = await stack.joinContainerTerminal(socket, "box", "sh");
            const terminal = Terminal.getTerminal(terminalName);
            assert.ok(terminal, "the terminal should exist after joining");

            // The exec session is visible inside the container
            let attempts = 0;
            while (await countShellProcesses(stack, "box", "sh") === 0 && attempts < 40) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                attempts++;
            }
            assert.ok(await countShellProcesses(stack, "box", "sh") > 0, "the exec session should be running");

            // The last client leaving must end it, an idle shell survives Ctrl+C
            terminal.leave(socket);
            await terminal.end();

            attempts = 0;
            while (await countShellProcesses(stack, "box", "sh") > 0 && attempts < 40) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                attempts++;
            }

            assert.equal(await countShellProcesses(stack, "box", "sh"), 0, "no exec session may be left behind");
            assert.equal(Terminal.getTerminal(terminalName), undefined);
        } finally {
            await spawn("docker", stack.getComposeOptions("down", "-v"), {
                cwd: stack.path,
                encoding: "utf-8",
                timeoutMs: 300_000,
            }).catch(() => undefined);
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});
