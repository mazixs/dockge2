import { strict as assert } from "node:assert";
import os from "node:os";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";
import { TerminalSocketHandler } from "../../backend/agent-socket-handlers/terminal-socket-handler";
import type { DockgeServer } from "../../backend/dockge-server";
import { InteractiveTerminal, Terminal, TERMINAL_CLIENT_HEADER, terminalClientKey, terminalOwner } from "../../backend/terminal";
import { Stack } from "../../backend/stack";
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
 * A client of one account
 * @param id Socket id
 * @param userID Account the client signed in as
 * @param client Value of the terminal client header, as a panel sends it to an agent
 * @returns Fake client socket
 */
function userSocket(id : string, userID : string, client? : string) : DockgeSocket {
    return Object.assign(makeSocket(id), { userID,
        request: { headers: client ? { [TERMINAL_CLIENT_HEADER]: client } : {} } });
}

/**
 * Send an event to a handler and wait for its answer
 * @param agentSocket Socket the handler listens on
 * @param eventName Event to send
 * @param args Arguments without the callback
 * @returns The answer
 */
function call(agentSocket : AgentSocket, eventName : string, ...args : unknown[]) : Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        agentSocket.call(eventName, ...args, resolve);
    });
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

test("a real PTY burst reaches the live client while replay remains bounded", async (context) => {
    const size = 4 * 1024 * 1024;
    let received = 0;
    const socket = makeSocket("burst-client");
    socket.emitAgent = (event, ...args) => {
        if (event === "terminalWrite") {
            received += Buffer.byteLength(String(args[1]));
        }
    };
    const terminal = new Terminal({ stacksDir: os.tmpdir() } as DockgeServer, "test-burst", process.execPath, [
        "-e", `process.stdout.write("x".repeat(${size}), () => process.stdout.write("BURST-END", () => process.exit(0)));`,
    ], os.tmpdir());
    context.after(() => terminal.kill());
    let exit : number | undefined;
    terminal.onExit(code => {
        exit = code;
    });
    terminal.join(socket);
    terminal.start();
    assert.ok(await waitFor(() => exit !== undefined));
    assert.equal(exit, 0);
    assert.equal(received, size + "BURST-END".length, "live output must not use the truncated replay");
    const replay = terminal.getBuffer();
    assert.match(replay, /^\[Earlier terminal output omitted\]/);
    assert.ok(replay.endsWith("BURST-END"));
    assert.ok(Buffer.byteLength(replay) <= 1024 * 1024 + 64);
    assert.equal(Terminal.getTerminal("test-burst"), undefined);
});

test("leaving logs cancels a delayed join and a fresh join survives a delayed leave", async (context) => {
    const server = { stacksDir: os.tmpdir() } as DockgeServer;
    const socket = makeSocket("log-race-client");
    const handlers = new AgentSocket();
    new TerminalSocketHandler().create(socket, server, handlers);
    let joins = 0;
    let leaves = 0;
    const stack = { isManagedByDockge: true,
        joinCombinedTerminal: async () => {
            joins++;
        },
        leaveCombinedTerminal: async () => {
            leaves++;
        } } as unknown as Stack;
    const pending : ((value : Stack) => void)[] = [];
    context.mock.method(Stack, "getStack", () => new Promise<Stack>(resolve => pending.push(resolve)));
    const call = (event : string) => new Promise<Record<string, unknown>>(resolve => {
        handlers.call(event, "fixture", (response : Record<string, unknown>) => resolve(response));
    });
    const oldJoin = call("joinCombinedTerminal");
    const leave = call("leaveCombinedTerminal");
    pending[1]!(stack);
    assert.equal((await leave).ok, true);
    pending[0]!(stack);
    assert.equal((await oldJoin).ok, true);
    assert.equal(joins, 0);
    assert.equal(leaves, 1);

    const oldLeave = call("leaveCombinedTerminal");
    const freshJoin = call("joinCombinedTerminal");
    pending[3]!(stack);
    assert.equal((await freshJoin).ok, true);
    pending[2]!(stack);
    assert.equal((await oldLeave).ok, true);
    assert.equal(joins, 1);
    assert.equal(leaves, 1);
});

test("busy commands are acknowledged and interruption cannot become a successful exit", async (context) => {
    const server = { stacksDir: os.tmpdir() } as DockgeServer;
    const name = "compose-interruption-test";
    const command = Terminal.exec(server, undefined, name, process.execPath, [
        "-e", "process.on('SIGINT', () => process.exit(0)); console.log('READY'); setInterval(() => {}, 1000);",
    ], os.tmpdir());
    // Attach the rejection handler before sending a signal to the real process.
    const interrupted = assert.rejects(command, { code: "interrupted",
        unknown: true });
    const terminal = Terminal.getTerminal(name)!;
    context.after(() => terminal.kill());
    assert.ok(await waitFor(() => terminal.getBuffer().includes("READY")));
    await assert.rejects(Terminal.exec(server, undefined, name, "true", [], os.tmpdir()), { code: "busy" });
    await terminal.end(1000);
    await interrupted;
    assert.equal(Terminal.getTerminal(name), undefined);
});

test("a missing executable reports a spawn failure and releases the terminal", async () => {
    const server = { stacksDir: os.tmpdir() } as DockgeServer;
    await assert.rejects(Terminal.exec(server, undefined, "missing-command-test", "/does-not-exist/dockge-command", [], os.tmpdir()), { code: "spawn" });
    assert.equal(Terminal.getTerminal("missing-command-test"), undefined);
});

test("a private shell is out of reach of every other user, whatever name they send", async () => {
    const server = { stacksDir: os.tmpdir() } as unknown as DockgeServer;
    const name = "container-exec-test-private";
    const alice = userSocket("alice-socket", "alice");
    const bob = userSocket("bob-socket", "bob");
    const terminal = new InteractiveTerminal(server, name, process.execPath, [
        "-e",
        "console.log('alice-secret'); setInterval(() => {}, 1000);",
    ], os.tmpdir(), terminalOwner(alice));
    terminal.join(alice);
    terminal.start();

    const asAlice = new AgentSocket();
    const asBob = new AgentSocket();
    new TerminalSocketHandler().create(alice, server, asAlice);
    new TerminalSocketHandler().create(bob, server, asBob);

    try {
        assert.ok(await waitFor(() => terminal.getBuffer().includes("alice-secret")));
        assert.equal(Terminal.getTerminal(name), undefined, "a private shell is not filed under its bare name");
        assert.match(String((await call(asAlice, "terminalJoin", name)).buffer), /alice-secret/);

        // Neither the name nor a guess at the registry key reaches it
        for (const crafted of [ name, JSON.stringify([ "alice", "", name ]) ]) {
            assert.equal((await call(asBob, "terminalJoin", crafted)).buffer, "", crafted);
            assert.equal((await call(asBob, "terminalInput", crafted, "exit\r")).ok, false, crafted);
            await call(asBob, "terminalLeave", crafted);
        }
        assert.equal(Terminal.getTerminal(name, terminalOwner(alice)), terminal, "the shell of alice survived");
        assert.equal(terminal.hasClient(alice), true);
    } finally {
        await terminal.end(500);
    }
});

test("the users of a panel get separate shells on an agent, and a forged header stays inside the account", () => {
    const key = terminalClientKey("panel-user");
    assert.match(key, /^[a-f0-9]{16}$/);
    assert.notEqual(key, terminalClientKey("another-panel-user"));
    assert.equal(key, terminalClientKey("panel-user"), "a reconnect finds the same shell");

    assert.deepEqual(terminalOwner(userSocket("s1", "agent-account", key)), { user: "agent-account",
        client: key });
    assert.deepEqual(terminalOwner(userSocket("s2", "agent-account", "../other")), { user: "agent-account",
        client: "" });
    assert.deepEqual(terminalOwner(userSocket("s3", "agent-account")), { user: "agent-account",
        client: "" });
});

test("ending the sessions of one account leaves the others running", async () => {
    const server = { stacksDir: os.tmpdir() } as unknown as DockgeServer;
    const shell = (user : string) => new InteractiveTerminal(server, "container-exec-test-owned", process.execPath, [
        "-e",
        "setInterval(() => {}, 1000);",
    ], os.tmpdir(), { user,
        client: "" });
    const alice = shell("alice");
    const bob = shell("bob");
    alice.start();
    bob.start();

    try {
        assert.ok(await waitFor(() => alice.ptyProcess !== undefined && bob.ptyProcess !== undefined));
        await Terminal.endOwnedBy("alice");
        assert.equal(Terminal.getTerminal(alice.name, alice.owner), undefined);
        assert.equal(Terminal.getTerminal(bob.name, bob.owner), bob);
    } finally {
        await bob.end(500);
    }
});
