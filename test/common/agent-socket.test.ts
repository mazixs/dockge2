import { strict as assert } from "node:assert";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";

test("AgentSocket dispatches registered events and ignores unknown events", () => {
    const socket = new AgentSocket();
    const calls: unknown[][] = [];

    socket.on("event", (...args: unknown[]) => {
        calls.push(args);
    });

    socket.call("event", "value", 42);
    socket.call("missing", "ignored");

    assert.deepEqual(calls, [[ "value", 42 ]]);
});
