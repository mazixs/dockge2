import { strict as assert } from "node:assert";
import test from "node:test";
import { AgentRequests } from "../../frontend/src/agent-requests";
import type { AgentRequestName, AgentRequestResult } from "../../common/agent-events";

/** One request that left the application, kept so the test can answer it later */
interface SentRequest {
    endpoint : string;
    eventName : string;
    args : unknown[];
    ack : (response : never) => void;
}

/**
 * Build a requester whose transport answers nothing on its own
 * @param defaultTimeoutMs Deadline of a request that names none
 * @returns The requester and everything it sent
 */
function requester(defaultTimeoutMs = 50) : { requests : AgentRequests, sent : SentRequest[] } {
    const sent : SentRequest[] = [];
    const requests = new AgentRequests((endpoint, eventName, args, ack) => {
        sent.push({ endpoint,
            eventName,
            args: [ ...args ],
            ack: ack as (response : never) => void });
    }, defaultTimeoutMs);

    return { requests,
        sent };
}

/**
 * Answer a request the way the server would
 * @param sent Request to answer
 * @param response What the server said
 */
function answer<E extends AgentRequestName>(sent : SentRequest, response : AgentRequestResult<E>) : void {
    (sent.ack as (value : AgentRequestResult<E>) => void)(response);
}

test("an answer ends the request and stops it being counted as waiting", async () => {
    const { requests, sent } = requester();
    const pending = requests.request("", "getStackFiles", [ "app" ]);

    assert.equal(requests.waiting, 1);
    assert.deepEqual(sent[0]?.args, [ "app" ]);
    answer(sent[0] as SentRequest, { ok: true,
        inventory: { files: [],
            secrets: [] } } as never);

    const response = await pending;

    assert.equal(response.ok, true);
    assert.equal(requests.waiting, 0);
});

test("an acknowledgement that never comes ends as unknown, not as a failure", async () => {
    const { requests } = requester(20);

    const response = await requests.request("", "startStack", [ "app" ]);

    // A command whose answer was lost may well have run, so the screen is told that the
    // result is unknown and asks the server again instead of repeating the command
    assert.equal(response.ok, false);
    assert.equal(response.ok === false && response.unknown, true);
    assert.equal(response.ok === false && response.msg, "requestResultUnknown");
    assert.equal(requests.waiting, 0);
});

test("an answer arriving after the deadline does not replace the result already given", async () => {
    const { requests, sent } = requester(20);
    const response = await requests.request("", "startStack", [ "app" ]);

    assert.equal(response.ok, false);

    // The server was slow rather than silent. Answering now must not resolve a promise
    // the caller already acted on
    answer(sent[0] as SentRequest, { ok: true,
        msg: "Started" } as never);
    assert.equal(requests.waiting, 0);
});

test("a lost connection ends everything that was waiting at once", async () => {
    const { requests, sent } = requester(5000);
    const first = requests.request("", "startStack", [ "app" ]);
    const second = requests.request("remote.example", "stopStack", [ "other" ]);

    assert.equal(requests.waiting, 2);
    requests.failAll();

    for (const response of await Promise.all([ first, second ])) {
        assert.equal(response.ok, false);
        assert.equal(response.ok === false && response.unknown, true);
    }
    assert.equal(requests.waiting, 0);
    assert.equal(sent.length, 2);
});

test("a socket that acknowledges with nothing is an unknown result, not an empty answer", async () => {
    const { requests, sent } = requester();
    const pending = requests.request("", "getStack", [ "app" ]);

    (sent[0] as SentRequest).ack(undefined as never);

    const response = await pending;

    assert.equal(response.ok, false);
    assert.equal(response.ok === false && response.unknown, true);
});

test("the deadline of one request does not end another", async () => {
    const { requests, sent } = requester(5000);
    const slow = requests.request("", "updateStack", [ "app" ], { timeoutMs: 20 });
    const waiting = requests.request("", "getStack", [ "app" ]);
    const slowResponse = await slow;

    assert.equal(slowResponse.ok, false);
    assert.equal(requests.waiting, 1);
    answer(sent[1] as SentRequest, { ok: true,
        stack: { name: "app" } } as never);

    const waitingResponse = await waiting;

    assert.equal(waitingResponse.ok, true);
});
