import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";
import { TerminalSocketHandler } from "../../backend/agent-socket-handlers/terminal-socket-handler";
import type { DockgeServer } from "../../backend/dockge-server";
import { Stack } from "../../backend/stack";
import type { DockgeSocket } from "../../backend/util-server";
import { ValidationError } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

/**
 * Call an agent socket event and wait for its callback
 * @param agentSocket Agent socket the handler is registered on
 * @param eventName Event to call
 * @param args Arguments without the callback
 * @returns Callback response
 */
function call(agentSocket : AgentSocket, eventName : string, ...args : unknown[]) : Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        agentSocket.call(eventName, ...args, (response : Record<string, unknown>) => resolve(response));
    });
}

test("the interactive terminal event refuses anything but the allowed shells", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const stackDir = path.join(stacksDir, "shell-stack");
        await mkdir(stackDir);
        await writeFile(path.join(stackDir, "compose.yaml"), "services:\n  app:\n    image: alpine\n");

        const socket = { userID: 1,
            endpoint: "",
            emitAgent: () => undefined } as unknown as DockgeSocket;
        const server = { stacksDir } as unknown as DockgeServer;
        const agentSocket = new AgentSocket();
        new TerminalSocketHandler().create(socket, server, agentSocket);

        // Anything outside the allow-list is refused before Docker is touched
        for (const shell of [ "zsh", "bash -c ls", "/bin/sh", "sh;id", "", 5, null ]) {
            const res = await call(agentSocket, "interactiveTerminal", "shell-stack", "app", shell);
            assert.equal(res.ok, false, `${JSON.stringify(shell)} must be refused`);
            assert.match(String(res.msg), /shell/i);
        }

        // A service the compose file does not declare is refused as well
        const unknownService = await call(agentSocket, "interactiveTerminal", "shell-stack", "nope", "sh");
        assert.equal(unknownService.ok, false);
        assert.match(String(unknownService.msg), /Unknown service/);

        // Wrong types never reach the stack lookup
        for (const args of [
            [ 5, "app", "sh" ],
            [ "shell-stack", 7, "sh" ],
        ]) {
            const res = await call(agentSocket, "interactiveTerminal", ...args);
            assert.equal(res.ok, false);
        }
    });
});

test("a stack refuses a service that its compose file does not declare", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const stackDir = path.join(stacksDir, "guard-stack");
        await mkdir(stackDir);
        await writeFile(path.join(stackDir, "compose.yaml"), "services:\n  app:\n    image: alpine\n  db:\n    image: mariadb\n");

        const stack = await Stack.getStack({ stacksDir } as never, "guard-stack");

        assert.doesNotThrow(() => stack.assertServiceExists("app"));
        assert.doesNotThrow(() => stack.assertServiceExists("db"));
        assert.throws(() => stack.assertServiceExists("other"), ValidationError);
        assert.throws(() => stack.assertServiceExists(""), ValidationError);
    });
});

test("terminal events answer the browser instead of leaving it waiting", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const socket = { userID: 1,
            endpoint: "",
            emitAgent: () => undefined } as unknown as DockgeSocket;
        const server = { stacksDir,
            config: { enableConsole: false } } as unknown as DockgeServer;
        const agentSocket = new AgentSocket();
        new TerminalSocketHandler().create(socket, server, agentSocket);

        // Every one of these ends with an answer: a screen that only leaves its waiting
        // state in the callback would otherwise stay there
        const missing = await call(agentSocket, "terminalInput", "container-exec-nothing", "ls");
        assert.equal(missing.ok, false);
        assert.match(String(missing.msg), /not found|Interactive/);

        const wrongType = await call(agentSocket, "terminalInput", 5, "ls");
        assert.equal(wrongType.ok, false);

        // The console is a deployment decision, and a refusal is not a failure
        const console = await call(agentSocket, "checkMainTerminal");
        assert.equal(console.ok, false);

        const refused = await call(agentSocket, "mainTerminal", "console");
        assert.equal(refused.ok, false);
        assert.match(String(refused.msg), /Console is not enabled/);

        // A terminal nobody opened has no output, which is not an error
        const joined = await call(agentSocket, "terminalJoin", "container-exec-nothing");
        assert.equal(joined.ok, true);
        assert.equal(joined.buffer, "");

        const joinType = await call(agentSocket, "terminalJoin", 5);
        assert.equal(joinType.ok, false);

        // Leaving a session this client never joined changes nothing and still answers
        const left = await call(agentSocket, "terminalLeave", "container-exec-nothing");
        assert.equal(left.ok, true);

        const leaveType = await call(agentSocket, "terminalLeave", null);
        assert.equal(leaveType.ok, false);

        const combined = await call(agentSocket, "joinCombinedTerminal", 7);
        assert.equal(combined.ok, false);

        const leaveCombined = await call(agentSocket, "leaveCombinedTerminal", 7);
        assert.equal(leaveCombined.ok, false);
    });
});

test("a resize of a terminal that is not ours is ignored rather than thrown at the window", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const socket = { userID: 1,
            endpoint: "",
            emitAgent: () => undefined } as unknown as DockgeSocket;
        const server = { stacksDir,
            config: { enableConsole: false } } as unknown as DockgeServer;
        const agentSocket = new AgentSocket();
        new TerminalSocketHandler().create(socket, server, agentSocket);

        // The event carries no acknowledgement: it is sent while the window is being
        // dragged. Nothing may escape from it, whatever the arguments are
        for (const args of [
            [ "container-exec-nothing", 50, 100 ],
            [ 5, 50, 100 ],
            [ "console", "50", 100 ],
            [ "console", 50, null ],
        ]) {
            agentSocket.call("terminalResize", ...args);
        }
        await new Promise((resolve) => setImmediate(resolve));
    });
});
