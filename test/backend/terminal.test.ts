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

    // The registry entry proves it: end() removes it right away, so this catches a
    // missing clientCount guard even though the process exit itself is asynchronous
    assert.equal(Terminal.getTerminal(name), terminal, "the session must still be registered");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(Terminal.getTerminal(name), terminal, "the session must not be ended while a client is attached");
    assert.equal(exitCode, undefined);

    // The last client leaving ends it
    const second = await leave(makeSocket("client-other"));
    assert.equal(second.ok, true);
    assert.ok(await waitFor(() => exitCode !== undefined), "the last client leaving must end the session");
    assert.equal(Terminal.getTerminal(name), undefined);
});

test("a client that never joined cannot end or write to a session", async () => {
    const server = { stacksDir: os.tmpdir() } as unknown as DockgeServer;
    const name = "container-exec-test-ownership";
    const owner = makeSocket("owner");
    const stranger = makeSocket("stranger");

    const terminal = new InteractiveTerminal(server, name, process.execPath, [
        "-e",
        "process.on('SIGINT', () => {}); process.stdin.resume(); setTimeout(() => {}, 60000);",
    ], os.tmpdir());

    let exitCode : number | undefined;
    terminal.onExit((code) => {
        exitCode = code;
    });

    terminal.join(owner);
    terminal.start();
    assert.ok(await waitFor(() => terminal.ptyProcess !== undefined));

    const call = (target : DockgeSocket, event : string, ...args : unknown[]) => new Promise<Record<string, unknown>>((resolve) => {
        const handler = new AgentSocket();
        new TerminalSocketHandler().create(target, server, handler);
        handler.call(event, ...args, (res : Record<string, unknown>) => resolve(res));
    });

    // A stranger cannot type into the session
    const written = await call(stranger, "terminalInput", name, "exit\r");
    assert.equal(written.ok, false);
    assert.match(String(written.msg), /not attached/i);

    // And cannot end it either
    const left = await call(stranger, "terminalLeave", name);
    assert.equal(left.ok, true, "the event answers, but it must not touch the session");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(exitCode, undefined, "a stranger must not end the session");
    assert.equal(terminal.clientCount, 1);
    assert.equal(Terminal.getTerminal(name), terminal);

    // The owner can
    const ownerLeft = await call(owner, "terminalLeave", name);
    assert.equal(ownerLeft.ok, true);
    assert.ok(await waitFor(() => exitCode !== undefined), "the owner leaving must end the session");
});

test("a session that ends is removed from the registry at once, so a reconnect is fresh", async () => {
    const server = { stacksDir: os.tmpdir() } as unknown as DockgeServer;
    const name = "container-exec-test-reconnect";
    const socket = makeSocket("client-reconnect");

    const first = new InteractiveTerminal(server, name, process.execPath, [
        "-e",
        "process.on('SIGINT', () => {}); process.stdin.resume(); setTimeout(() => {}, 60000);",
    ], os.tmpdir());

    let firstExit : number | undefined;
    first.onExit((code) => {
        firstExit = code;
    });

    first.join(socket);
    first.start();
    assert.ok(await waitFor(() => first.ptyProcess !== undefined));

    first.leave(socket);
    const ending = first.end(3000);

    // The dying session is gone from the registry immediately
    assert.equal(Terminal.getTerminal(name), undefined);

    // So a reconnect during the grace period builds a new session
    const second = new InteractiveTerminal(server, name, process.execPath, [
        "-e",
        "setTimeout(() => {}, 60000);",
    ], os.tmpdir());
    second.join(socket);
    second.start();
    assert.equal(Terminal.getTerminal(name), second);

    await ending;
    assert.ok(await waitFor(() => firstExit !== undefined), "the old session still ends");

    // And the late shutdown of the old session did not drop the new one
    assert.equal(Terminal.getTerminal(name), second);

    second.kill();
});

test("leaving a shared stack terminal does not end it", async () => {
    const server = { stacksDir: os.tmpdir() } as unknown as DockgeServer;
    const name = "combined-test-shared";
    const socket = makeSocket("client-shared");

    const terminal = new InteractiveTerminal(server, name, process.execPath, [
        "-e",
        "setTimeout(() => {}, 60000);",
    ], os.tmpdir());

    let exitCode : number | undefined;
    terminal.onExit((code) => {
        exitCode = code;
    });

    terminal.join(socket);
    terminal.start();
    assert.ok(await waitFor(() => terminal.ptyProcess !== undefined));

    const handler = new AgentSocket();
    new TerminalSocketHandler().create(socket, server, handler);
    const res = await new Promise<Record<string, unknown>>((resolve) => {
        handler.call("terminalLeave", name, (value : Record<string, unknown>) => resolve(value));
    });

    assert.equal(res.ok, true);
    assert.equal(terminal.clientCount, 0);

    // Only container shells are ended by a leaving client: a deploy or logs terminal is shared
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(exitCode, undefined, "a shared terminal must survive a leaving client");
    assert.equal(Terminal.getTerminal(name), terminal);

    terminal.kill();
});
