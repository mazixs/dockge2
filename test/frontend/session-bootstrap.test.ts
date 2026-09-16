import test from "node:test";
import { strict as assert } from "node:assert";
import { createSessionBootstrap, reduceSessionBootstrap, sessionConnectionReady } from "../../frontend/src/session-bootstrap";

test("workspace first becomes ready only after identity, matching profile and both initial lists", () => {
    let state = reduceSessionBootstrap(createSessionBootstrap(), { type: "connected" });
    const generation = state.generation;
    state = reduceSessionBootstrap(state, { type: "identity",
        userID: "owner" });
    state = reduceSessionBootstrap(state, { type: "profile",
        generation,
        userID: "owner" });
    assert.equal(state.ready, false, "a cookie alone must not render an empty workspace");
    state = reduceSessionBootstrap(state, { type: "agents",
        generation });
    assert.equal(state.ready, false);
    state = reduceSessionBootstrap(state, { type: "stacks",
        generation });
    assert.equal(state.ready, true);
    assert.equal(sessionConnectionReady(state), true);
});

test("initial list order and genuinely empty lists do not change the readiness contract", () => {
    let state = reduceSessionBootstrap(createSessionBootstrap(), { type: "connected" });
    const generation = state.generation;
    state = reduceSessionBootstrap(state, { type: "stacks",
        generation });
    state = reduceSessionBootstrap(state, { type: "agents",
        generation });
    state = reduceSessionBootstrap(state, { type: "identity",
        userID: "owner" });
    assert.equal(state.ready, false);
    state = reduceSessionBootstrap(state, { type: "profile",
        generation,
        userID: "owner" });
    assert.equal(state.ready, true, "received empty lists are complete snapshots too");
});

test("a late profile from an anonymous or older connection cannot restore login readiness", () => {
    let state = reduceSessionBootstrap(createSessionBootstrap(), { type: "connected" });
    const previousGeneration = state.generation;
    state = reduceSessionBootstrap(state, { type: "identity",
        userID: "owner" });
    state = reduceSessionBootstrap(state, { type: "anonymous" });
    state = reduceSessionBootstrap(state, { type: "profile",
        generation: previousGeneration,
        userID: "owner" });
    assert.equal(state.ready, false);
    assert.equal(state.userID, null);
    state = reduceSessionBootstrap(state, { type: "connected" });
    state = reduceSessionBootstrap(state, { type: "identity",
        userID: "next-user" });
    state = reduceSessionBootstrap(state, { type: "profile",
        generation: previousGeneration,
        userID: "owner" });
    assert.equal(state.profileReady, false);
});

test("same-account reconnect keeps the existing workspace mounted until the new snapshot arrives", () => {
    let state = reduceSessionBootstrap(createSessionBootstrap(), { type: "connected" });
    const generation = state.generation;
    for (const event of [
        { type: "identity",
            userID: "owner" },
        { type: "profile",
            generation,
            userID: "owner" },
        { type: "agents",
            generation },
        { type: "stacks",
            generation },
    ] as const) {
        state = reduceSessionBootstrap(state, event);
    }
    state = reduceSessionBootstrap(state, { type: "connected" });
    assert.equal(state.ready, true);
    assert.equal(sessionConnectionReady(state), false);
    state = reduceSessionBootstrap(state, { type: "identity",
        userID: "owner" });
    assert.equal(state.ready, true);
    state = reduceSessionBootstrap(state, { type: "identity",
        userID: "someone-else" });
    assert.equal(state.ready, false, "a different user cannot inherit the previous workspace");
});

test("an identity change cannot reuse the previous user's inventory or profile", () => {
    let state = createSessionBootstrap();
    const generation = state.generation;
    for (const event of [
        { type: "identity",
            userID: "owner" },
        { type: "profile",
            generation,
            userID: "owner" },
        { type: "agents",
            generation },
        { type: "stacks",
            generation },
    ] as const) {
        state = reduceSessionBootstrap(state, event);
    }
    state = reduceSessionBootstrap(state, { type: "identity",
        userID: "viewer" });
    state = reduceSessionBootstrap(state, { type: "profile",
        generation,
        userID: "owner" });
    assert.equal(state.profileReady, false);
    state = reduceSessionBootstrap(state, { type: "profile",
        generation,
        userID: "viewer" });
    assert.equal(state.ready, false);
    assert.equal(state.agentsReady, false);
    assert.equal(state.stacksReady, false);
    state = reduceSessionBootstrap(state, { type: "agents",
        generation });
    state = reduceSessionBootstrap(state, { type: "stacks",
        generation });
    assert.equal(state.ready, true);
});

test("a failed initialization can recover on real evidence, while old failures are ignored", () => {
    let state = reduceSessionBootstrap(createSessionBootstrap(), { type: "connected" });
    state = reduceSessionBootstrap(state, { type: "failed",
        generation: state.generation,
        message: "authConnectionFailed" });
    assert.equal(state.error, "authConnectionFailed");
    assert.equal(state.ready, false);
    state = reduceSessionBootstrap(state, { type: "connected" });
    const generation = state.generation;
    state = reduceSessionBootstrap(state, { type: "failed",
        generation: generation - 1,
        message: "authConnectionFailed" });
    assert.equal(state.error, "");
    for (const event of [
        { type: "identity",
            userID: "owner" },
        { type: "profile",
            generation,
            userID: "owner" },
        { type: "agents",
            generation },
        { type: "stacks",
            generation },
    ] as const) {
        state = reduceSessionBootstrap(state, event);
    }
    assert.equal(state.ready, true);
    assert.equal(state.error, "");
});
