import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";
import dayjs from "dayjs";
import { AgentManager } from "../../backend/agent-manager";
import { AgentProxySocketHandler } from "../../backend/socket-handlers/agent-proxy-socket-handler";
import { AgentSocket } from "../../common/agent-socket";
import type { AgentRequestContract } from "../../common/agent-events";
import { ALL_ENDPOINTS } from "../../common/util-common";
import { resolveSocketIdentity } from "../../backend/auth";
import { issueUser } from "../../backend/auth-access";
import { getAuth } from "../../backend/auth";
import { ManageAgentSocketHandler } from "../../backend/socket-handlers/manage-agent-socket-handler";
import type { DockgeServer } from "../../backend/dockge-server";
import type { DockgeSocket } from "../../backend/util-server";
import { createTestAccount, makeAuthenticatedSocket, TEST_PASSWORD, withDatabase } from "../helpers/database";

/** What one agent connection received */
interface SentEvent {
    args : unknown[];
}

/**
 * A manager whose agents are fakes, so forwarding can be watched without a network
 */
class TestAgentManager extends AgentManager {

    /**
     * Pretend an agent is connected and signed in
     * @param endpoint Address of the agent
     * @param protocol Protocol generation the agent reported
     * @param sent Where the events this agent receives are collected
     * @param connected Whether the connection is up
     */
    addFakeAgent(endpoint : string, protocol : number, sent : SentEvent[], connected = true) : void {
        this.agentSocketList[endpoint] = {
            connected,
            emit: (...args : unknown[]) => sent.push({ args }),
        } as never;
        this.agentLoggedInList[endpoint] = connected;
        this.agentProtocolList[endpoint] = protocol;
        // Without this the manager waits ten seconds for an agent that is not coming
        this._firstConnectTime = dayjs().subtract(1, "minute");
    }
}

/**
 * Wait until something the code does in the background has happened
 * @param done What has to become true
 * @param timeoutMs How long to wait before giving up
 */
async function waitFor(done : () => boolean, timeoutMs = 2000) : Promise<void> {
    const until = Date.now() + timeoutMs;

    while (!done() && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

/**
 * Sign in an account and build the socket the server code sees
 * @param options Username, role and password of the account to create first
 * @returns Socket carrying that session
 */
async function signedInSocket(options : { username : string, role : "admin" | "operator" | "viewer" }) : Promise<DockgeSocket> {
    await issueUser({ username: options.username,
        email: `${options.username}@example.com`,
        name: options.username,
        role: options.role,
        password: TEST_PASSWORD });
    const login = await getAuth().api.signInUsername({ body: { username: options.username,
        password: TEST_PASSWORD },
    asResponse: true });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const identity = await resolveSocketIdentity({ cookie });

    return makeAuthenticatedSocket({ cookie,
        userID: identity.userID ?? "" });
}

test("a request to an agent that is not connected fails instead of waiting", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const socket = await signedInSocket({ username: "operator1",
            role: "operator" });
        const manager = new TestAgentManager(socket);

        // The browser is waiting for an answer, so the caller has to be told that there
        // is nothing to send to rather than be left holding the request
        await assert.rejects(manager.emitToEndpoint("remote.example", "getStack", "app"), /not found/);

        const sent : SentEvent[] = [];
        manager.addFakeAgent("remote.example", 2, sent, false);
        await assert.rejects(manager.emitToEndpoint("remote.example", "getStack", "app"), /not connected/);
        assert.equal(sent.length, 0);
    });
});

test("an event reaches the agent it names, with its endpoint and arguments", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const socket = await signedInSocket({ username: "operator2",
            role: "operator" });
        const manager = new TestAgentManager(socket);
        const sent : SentEvent[] = [];
        manager.addFakeAgent("remote.example", 2, sent);

        await manager.emitToEndpoint("remote.example", "getStack", "app");

        assert.deepEqual(sent[0]?.args, [ "agent", "remote.example", "getStack", "app" ]);
    });
});

test("an agent of the older generation is sent the save without the baseline", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const socket = await signedInSocket({ username: "operator3",
            role: "operator" });
        const manager = new TestAgentManager(socket);
        const sent : SentEvent[] = [];
        manager.addFakeAgent("old.example", 1, sent);
        manager.addFakeAgent("new.example", 2, sent);
        const ack = () => undefined;
        const baseline = { compose: "hash-of-compose",
            env: null };

        await manager.emitToEndpoint("old.example", "saveStack", "app", "services: {}", "", false, baseline, ack);
        await manager.emitToEndpoint("new.example", "saveStack", "app", "services: {}", "", false, baseline, ack);

        // Generation 1 expects its acknowledgement where the baseline now sits: sending
        // the baseline anyway would leave the browser without an answer
        assert.deepEqual(sent[0]?.args, [ "agent", "old.example", "saveStack", "app", "services: {}", "", false, ack ]);
        assert.deepEqual(sent[1]?.args, [ "agent", "new.example", "saveStack", "app", "services: {}", "", false, baseline, ack ]);
    });
});

test("rights are checked again at the moment of forwarding, not only when the screen opened", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const socket = await signedInSocket({ username: "watcher1",
            role: "viewer" });
        const manager = new TestAgentManager(socket);
        const sent : SentEvent[] = [];
        manager.addFakeAgent("remote.example", 2, sent);

        await assert.rejects(manager.emitToEndpoint("remote.example", "deployStack", "app"), /authPermissionDenied/);
        assert.equal(sent.length, 0);

        // What a viewer may ask still travels
        await manager.emitToEndpoint("remote.example", "serviceStatusList", "app");
        assert.equal(sent.length, 1);
    });
});

test("one unreachable agent does not stop the others from being told", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        const socket = await signedInSocket({ username: "operator4",
            role: "operator" });
        const manager = new TestAgentManager(socket);
        const sent : SentEvent[] = [];
        manager.addFakeAgent("down.example", 2, sent, false);
        manager.addFakeAgent("up.example", 2, sent);

        manager.emitToAllEndpoints("requestStackList");
        await waitFor(() => sent.length > 0);

        assert.deepEqual(sent.map((event) => event.args[1]), [ "up.example" ]);
    });
});

test("managing agents answers the browser and refuses what it cannot read", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const identity = await resolveSocketIdentity({ cookie });
        const socket = Object.assign(new EventEmitter(), makeAuthenticatedSocket({ cookie,
            userID: identity.userID ?? "" }));
        const added : unknown[] = [];
        let listsSent = 0;
        let refreshedOthers = 0;
        socket.instanceManager = {
            test: async () => undefined,
            add: async (...args : unknown[]) => added.push(args),
            connect: async () => undefined,
            remove: async (url : string) => {
                if (url !== "http://agent.example:5001") {
                    throw new Error("Agent not found");
                }
            },
            sendAgentList: async () => {
                listsSent += 1;
            },
        } as never;
        const server = { disconnectAllSocketClients: () => {
            refreshedOthers += 1;
        } } as unknown as DockgeServer;
        new ManageAgentSocketHandler().create(socket, server);
        const call = (event : string, ...args : unknown[]) => new Promise<{ ok : boolean; msg? : unknown }>(
            (resolve) => socket.emit(event, ...args, resolve));

        const wrongType = await call("addAgent", "http://agent.example:5001");
        assert.equal(wrongType.ok, false);
        assert.equal(added.length, 0);

        const added1 = await call("addAgent", { url: "http://agent.example:5001",
            username: "owner",
            password: TEST_PASSWORD,
            name: "Agent" });
        assert.equal(added1.ok, true);
        assert.equal(added1.msg, "agentAddedSuccessfully");
        assert.equal(added.length, 1);
        assert.equal(refreshedOthers, 1);

        const removedWrong = await call("removeAgent", 42);
        assert.equal(removedWrong.ok, false);

        const removed = await call("removeAgent", "http://agent.example:5001");
        assert.equal(removed.ok, true);
        assert.equal(removed.msg, "agentRemovedSuccessfully");

        // The list of agents is sent again after a change, so another browser tab of the
        // same session does not keep showing an agent that is gone
        await waitFor(() => listsSent === 2);
        assert.equal(listsSent, 2);
    });
});

test("an event goes to the agent it names: this one, all of them, or a remote one", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const identity = await resolveSocketIdentity({ cookie });
        const socket = Object.assign(new EventEmitter(), makeAuthenticatedSocket({ cookie,
            userID: identity.userID ?? "" }));
        const toAll : string[] = [];
        const toOne : string[] = [];
        // The acknowledgement travels as the last argument, and whoever handles the
        // event is the one who answers it
        const answer = (args : unknown[]) => {
            const callback = args[args.length - 1];

            if (typeof callback === "function") {
                (callback as (response : unknown) => void)({ ok: true });
            }
        };
        socket.instanceManager = {
            emitToAllEndpoints: (event : string, ...args : unknown[]) => {
                toAll.push(event);
                answer(args);
            },
            emitToEndpoint: async (endpoint : string, event : string, ...args : unknown[]) => {
                toOne.push(`${endpoint}:${event}`);
                answer(args);
            },
        } as never;
        const agentSocket = new AgentSocket<AgentRequestContract>();
        const handled : string[] = [];
        agentSocket.on("requestStackList", (callback) => {
            handled.push("local");
            callback({ ok: true });
        });
        new AgentProxySocketHandler().create2(socket, {} as never, agentSocket);
        const call = (endpoint : unknown, event : unknown) => new Promise<{ ok : boolean; msg? : unknown }>(
            (resolve) => socket.emit("agent", endpoint, event, resolve));

        // An empty endpoint is this panel itself, and its own handler answers
        const local = await call("", "requestStackList");
        assert.equal(local.ok, true);
        assert.deepEqual(handled, [ "local" ]);

        await call(ALL_ENDPOINTS, "requestStackList");
        assert.deepEqual(toAll, [ "requestStackList" ]);

        await call("remote.example", "requestStackList");
        assert.deepEqual(toOne, [ "remote.example:requestStackList" ]);

        // Anything that is not a name of an endpoint and an event is refused, and the
        // browser is told rather than left waiting
        const badEndpoint = await call(5, "requestStackList");
        assert.equal(badEndpoint.ok, false);

        const badEvent = await call("", 5);
        assert.equal(badEvent.ok, false);

        assert.equal(handled.length, 1);
    });
});
