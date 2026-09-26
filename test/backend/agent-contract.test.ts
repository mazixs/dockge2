import { strict as assert } from "node:assert";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";
import { AGENT_REQUEST_NAMES } from "../../common/agent-events";
import type { AgentRequestContract } from "../../common/agent-events";
import { DockerSocketHandler } from "../../backend/agent-socket-handlers/docker-socket-handler";
import { GitSocketHandler } from "../../backend/agent-socket-handlers/git-socket-handler";
import { StabilitySocketHandler } from "../../backend/agent-socket-handlers/stability-socket-handler";
import { ContainerSocketHandler } from "../../backend/agent-socket-handlers/container-socket-handler";
import { TerminalSocketHandler } from "../../backend/agent-socket-handlers/terminal-socket-handler";
import { OPERATOR_EVENTS, roleAllowsEvent, VIEWER_EVENTS } from "../../backend/auth-access";
import type { DockgeServer } from "../../backend/dockge-server";
import type { DockgeSocket } from "../../backend/util-server";

/**
 * Register every agent handler of the server on one socket
 * @returns Names of the events that were registered, in registration order
 */
function registeredEvents() : string[] {
    const agentSocket = new AgentSocket<AgentRequestContract>();
    const socket = { on: () => undefined } as unknown as DockgeSocket;
    const server = {} as DockgeServer;

    for (const handler of [ new DockerSocketHandler(), new StabilitySocketHandler(), new ContainerSocketHandler(), new GitSocketHandler(), new TerminalSocketHandler() ]) {
        handler.create(socket, server, agentSocket);
    }
    return [ ...agentSocket.eventList.keys() ];
}

test("the server serves exactly the requests the contract describes", () => {
    // The contract is a type, so nothing at runtime makes the handlers follow it. An
    // event described and never registered answers nothing; one registered and never
    // described is invisible to every caller that is type checked
    const registered = registeredEvents();

    assert.deepEqual([ ...registered ].sort(), [ ...AGENT_REQUEST_NAMES ].sort());
    assert.equal(new Set(registered).size, registered.length, "an event is registered twice");
});

test("every request of the contract is reachable for an operator", () => {
    // A request nobody may send is dead code with a handler behind it: the check in
    // `authorizeSocketEvent` refuses an event that no list mentions
    const unreachable = AGENT_REQUEST_NAMES.filter((name) => !roleAllowsEvent("operator", name, true));

    assert.deepEqual(unreachable, []);
});

test("what a viewer may send is a part of what an operator may send", () => {
    // A viewer sees status and nothing else, so its events are a subset rather than a
    // separate list that may drift into granting something an operator does not have
    const viewerEvents = AGENT_REQUEST_NAMES.filter((name) => roleAllowsEvent("viewer", name, true));

    assert.ok(viewerEvents.length > 0);
    for (const name of viewerEvents) {
        assert.equal(roleAllowsEvent("operator", name, true), true, name + " is allowed for a viewer but not for an operator");
    }
});

test("no name is left in the access lists after the event is gone", () => {
    // The lists in `auth-access.ts` are written by hand. A name kept there after the
    // event was renamed authorises nothing and hides that the rename is incomplete
    const known = new Set<string>(AGENT_REQUEST_NAMES);

    assert.deepEqual([ ...OPERATOR_EVENTS ].filter((name) => !known.has(name)), []);
    assert.deepEqual([ ...VIEWER_EVENTS ].filter((name) => !known.has(name)), []);
    assert.equal(roleAllowsEvent("admin", "definitelyNotAnEvent", true), false);
});
