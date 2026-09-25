import test from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING, isStackFailed, statusStateName } from "../../common/util-common";

const source = readFileSync(new URL("../../frontend/src/components/Uptime.vue", import.meta.url), "utf8");
const script = source.split("<script>")[1]!.split("</script>")[0]!.replace(/^import .*;$/gm, "").replace("export default", "result =");
const context = { ATTENTION,
    CREATED_FILE,
    CREATED_STACK,
    EXITED,
    RUNNING,
    isStackFailed,
    statusStateName,
    StateChip: {},
    result: { computed: { state() {},
        statusName() {},
        issueText() {} } } };
runInNewContext(script, context);

test("stack chip distinguishes saved files, stopped containers, running and failure", () => {
    for (const [ status, expected ] of [[ CREATED_FILE, "pagesNotDeployed" ], [ CREATED_STACK, "pagesStopped" ], [ RUNNING, "pagesRunning" ], [ EXITED, "pagesFailed" ], [ ATTENTION, "pagesAttention" ], [ undefined, "pagesUnknown" ]]) {
        assert.equal(context.result.computed.statusName.call({ stack: { status },
            $t: (key: string) => key }), expected);
    }
});

test("a stack someone stopped reads as stopped, a crashed one as an error", () => {
    const failed = { status: EXITED,
        issues: [{ service: "web",
            name: "web-1",
            reason: "serviceFailed",
            detail: "1" }] };
    const stopped = { status: EXITED,
        issues: [{ service: "web",
            name: "web-1",
            reason: "serviceStopped" }] };
    const job = { status: EXITED,
        issues: [] };

    for (const [ stack, label, state ] of [[ failed, "pagesFailed", "failed" ], [ stopped, "pagesStopped", "stopped" ], [ job, "pagesStopped", "stopped" ]] as const) {
        const self = { stack,
            $t: (key: string) => key };
        assert.equal(context.result.computed.statusName.call(self), label);
        assert.equal(context.result.computed.state.call(self), state);
    }
});

test("attention retains the actual service reason instead of replacing it with a generic error", () => {
    assert.equal(context.result.computed.issueText.call({ stack: { issues: [{ service: "db",
        reason: "healthcheckFailed",
        detail: "timeout" }] },
    $t: (key: string) => key }), "db: healthcheckFailed (timeout)");
});
