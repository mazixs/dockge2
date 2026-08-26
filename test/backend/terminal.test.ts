import { strict as assert } from "node:assert";
import os from "node:os";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";
import { TerminalSocketHandler } from "../../backend/agent-socket-handlers/terminal-socket-handler";
import type { DockgeServer } from "../../backend/dockge-server";
import { InteractiveTerminal, Terminal } from "../../backend/terminal";
import type { DockgeSocket } from "../../backend/util-server";

/**
 * A socket that only records what the terminal sends to it
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
 * Wait until a condition holds or the timeout expires
 * @param check Condition to poll
 * @param timeoutMs Maximum wait
 * @returns Whether the condition became true
 */
async function waitFor(check : () => boolean, timeoutMs = 10_000) : Promise<boolean> {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        if (check()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return check();
}

test("killing a terminal ends the process and drops it from the registry", async () => {
    const server = { stacksDir: os.tmpdir() } as unknown as DockgeServer;
    const name = "container-exec-test-kill";

    // A real child process that ignores Ctrl+C the way an idle shell does
    const terminal = new InteractiveTerminal(server, name, process.execPath, [
        "-e",
        "process.on('SIGINT', () => {}); setTimeout(() => {}, 60000);",
    ], os.tmpdir());

    let exitCode : number | undefined;
    terminal.onExit((code) => {
        exitCode = code;
    });

    terminal.join(makeSocket("client-1"));
    terminal.start();

    assert.equal(terminal.clientCount, 1);
    assert.ok(await waitFor(() => terminal.ptyProcess !== undefined));
    assert.equal(Terminal.getTerminal(name), terminal);

    terminal.kill();

    assert.ok(await waitFor(() => exitCode !== undefined), "kill() must end the process");
    assert.equal(Terminal.getTerminal(name), undefined);
});

test("end() asks the shell to exit and kills a session that ignores it", async () => {
    const server = { stacksDir: os.tmpdir() } as unknown as DockgeServer;
    const name = "container-exec-test-end";

    // This process ignores both the exit command and SIGINT, so only a kill ends it
    const terminal = new InteractiveTerminal(server, name, process.execPath, [
        "-e",
        "process.on('SIGINT', () => {}); process.stdin.resume(); setTimeout(() => {}, 60000);",
    ], os.tmpdir());

    let exitCode : number | undefined;
    terminal.onExit((code) => {
        exitCode = code;
    });

    terminal.join(makeSocket("client-end"));
    terminal.start();
    assert.ok(await waitFor(() => terminal.ptyProcess !== undefined));

    await terminal.end(500);

    assert.ok(await waitFor(() => exitCode !== undefined), "end() must not leave the process behind");
    assert.equal(Terminal.getTerminal(name), undefined);
});

test("leaving a container terminal without other clients kills the session", async () => {
    const server = { stacksDir: os.tmpdir() } as unknown as DockgeServer;
    const name = "container-exec-test-leave";
    const socket = makeSocket("client-leave");

    const terminal = new InteractiveTerminal(server, name, process.execPath, [
        "-e",
        "process.on('SIGINT', () => {}); setTimeout(() => {}, 60000);",
    ], os.tmpdir());

    let exitCode : number | undefined;
    terminal.onExit((code) => {
        exitCode = code;
    });

    terminal.join(socket);
    terminal.join(makeSocket("client-other"));
    terminal.start();
    assert.ok(await waitFor(() => terminal.ptyProcess !== undefined));

    const agentSocket = new AgentSocket();
    new TerminalSocketHandler().create(socket, server, agentSocket);

    const leave = (target : DockgeSocket) => new Promise<Record<string, unknown>>((resolve) => {
        const handler = new AgentSocket();
        new TerminalSocketHandler().create(target, server, handler);
        handler.call("terminalLeave", name, (res : Record<string, unknown>) => resolve(res));
    });

    // While another client is attached the session stays alive
    const first = await leave(socket);
    assert.equal(first.ok, true);
    assert.equal(terminal.clientCount, 1);
    assert.equal(exitCode, undefined);

    // The last client leaving ends it
    const second = await leave(makeSocket("client-other"));
    assert.equal(second.ok, true);
    assert.ok(await waitFor(() => exitCode !== undefined), "the last client leaving must end the session");
    assert.equal(Terminal.getTerminal(name), undefined);
});
