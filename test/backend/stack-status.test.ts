import { strict as assert } from "node:assert";
import test from "node:test";
import { Stack } from "../../backend/stack";
import { CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../../common/util-common";

test("container statuses resolve clean-exit init containers as running", () => {
    assert.equal(Stack.resolveContainerStatuses([
        { State: "running",
            Status: "Up 10 seconds" },
        { State: "exited",
            Status: "Exited (0) 10 seconds ago" },
    ]), RUNNING);

    assert.equal(Stack.resolveContainerStatuses([
        { State: "running",
            Status: "Up 10 seconds" },
        { State: "exited",
            Status: "Exited (1) 10 seconds ago" },
    ]), EXITED);

    assert.equal(Stack.resolveContainerStatuses([
        { State: "exited",
            Status: "Exited (0) 10 seconds ago" },
    ]), EXITED);

    assert.equal(Stack.resolveContainerStatuses([
        { State: "restarting",
            Status: "Restarting" },
    ]), EXITED);
});

test("container statuses stay fail-closed for malformed and missing data", () => {
    // No container at all must never be reported as running
    assert.equal(Stack.resolveContainerStatuses([]), EXITED);

    // Malformed exit status must not be read as a clean exit
    assert.equal(Stack.resolveContainerStatuses([
        { State: "running",
            Status: "Up 3 minutes" },
        { State: "exited",
            Status: "Exited" },
    ]), EXITED);

    assert.equal(Stack.resolveContainerStatuses([
        { State: "running",
            Status: "Up 3 minutes" },
        { State: "exited" },
    ]), EXITED);

    // An unknown state next to a running one is a problem, not a success
    assert.equal(Stack.resolveContainerStatuses([
        { State: "running",
            Status: "Up 3 minutes" },
        { State: "dead",
            Status: "Dead" },
    ]), EXITED);

    // Case differences in Docker output are still recognised
    assert.equal(Stack.resolveContainerStatuses([
        { State: "running",
            Status: "Up 1 second" },
        { State: "exited",
            Status: "exited (0) 1 second ago" },
    ]), RUNNING);
});

test("compose status only consults containers for mixed exited output", async () => {
    // Unchanged aggregated statuses keep working without touching Docker
    assert.equal(await Stack.resolveComposeStatus({ Name: "created-stack",
        Status: "created(1)" }), CREATED_STACK);
    assert.equal(await Stack.resolveComposeStatus({ Name: "running-stack",
        Status: "running(2)" }), RUNNING);
    assert.equal(await Stack.resolveComposeStatus({ Name: "unknown-stack",
        Status: "something else" }), UNKNOWN);
    assert.equal(await Stack.resolveComposeStatus({ Name: "exited-stack",
        Status: "exited(2)" }), EXITED);
});
