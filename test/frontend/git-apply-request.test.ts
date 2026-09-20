import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { canApplyGitChoices, diffLineRows } from "../../frontend/src/git-ui";
import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING } from "../../common/util-common";
import { AgentRequests } from "../../frontend/src/agent-requests";

/**
 * The options of the Git changes page, evaluated as the component defines them.
 *
 * The page refuses to be left while an apply is running, so what happens to an apply
 * whose answer never arrives decides whether the person can leave the page at all. The
 * real methods run here against the real request transport.
 */
const source = readFileSync(new URL("../../frontend/src/pages/StackGitChanges.vue", import.meta.url), "utf8");
const script = source.split("<script>")[1]!.split("</script>")[0]!
    .replace(/^import .*;$/gm, "")
    .replace("export default", "result =");

const context : Record<string, unknown> = { result: {},
    canApplyGitChoices,
    diffLineRows,
    ATTENTION,
    CREATED_FILE,
    CREATED_STACK,
    EXITED,
    RUNNING,
    // Forwarded rather than captured, so a test that replaces the timers is obeyed
    setTimeout: (...args : Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (...args : Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args) };

runInNewContext(script, context);

const options = context.result as {
    beforeRouteLeave : () => boolean,
    data : () => Record<string, unknown>,
    computed : Record<string, () => unknown>,
    methods : Record<string, (...args : never[]) => unknown>,
    watch : Record<string, (...args : never[]) => unknown>,
    unmounted : () => void,
};

/** A request the page sent, as the transport received it */
interface Sent {
    eventName : string;
    args : unknown[];
    ack : (response : unknown) => void;
}

interface ChangesContext extends Record<string, unknown> {
    applying : boolean;
    loading : boolean;
    failure : string;
    result : unknown;
    preview : unknown;
    choices : Record<string, string>;
    /** Writes the chosen files, and deploys them when asked to */
    apply : (deploy : boolean) => void;
}

/** The page, what it sent, and the transport it sent it through */
interface Page {
    ctx : ChangesContext;
    sent : Sent[];
    requests : AgentRequests;
    route : { params : { stackName : string, endpoint : string } };
}

/**
 * The page as its own methods see it, with one file left to decide about
 * @returns The page and everything it sent
 */
function makePage() : Page {
    const sent : Sent[] = [];
    const route = { params: { stackName: "alpha",
        endpoint: "" },
    fullPath: "/stack/alpha/git" };

    const requests = new AgentRequests((endpoint, eventName, args, ack) => {
        sent.push({ eventName,
            args: args as unknown[],
            ack: ack as (response : unknown) => void });
    });

    const ctx = { $route: route,
        $t: (key : string) => key,
        $root: {
            canManageStacks: true,
            socketIO: { connected: true },
            agentStatusList: { "": "online" },
            completeStackList: {},
            serverText: (msg : string, fallback : string) => msg || fallback,
            emitAgentRequest: (endpoint : string, eventName : string, args : unknown[], requestOptions : unknown) =>
                requests.request(endpoint as never, eventName as never, args as never, requestOptions as never),
            emitAgent: (endpoint : string, eventName : string, ...rest : unknown[]) => {
                // The plain emit has no deadline: nothing ever answers this one
                sent.push({ eventName,
                    args: rest,
                    ack: () => undefined });
            },
        } } as unknown as ChangesContext;

    for (const [ name, method ] of Object.entries(options.methods)) {
        ctx[name] = (...args : never[]) => method.apply(ctx, args);
    }

    Object.assign(ctx, options.data.call(ctx));

    for (const [ name, getter ] of Object.entries(options.computed)) {
        Object.defineProperty(ctx, name, { get: () => getter.call(ctx),
            configurable: true });
    }

    // The comparison the person already made a decision about
    ctx.preview = { id: "preview-1",
        branch: "main",
        currentCommit: "1111111",
        targetCommit: "2222222",
        files: [{ path: "compose.yaml",
            status: "modified",
            serverText: "services:\n  app:\n    image: nginx:1\n",
            gitText: "services:\n  app:\n    image: nginx:2\n" }] };
    ctx.choices = { "compose.yaml": "git" };
    ctx.review = true;

    return { ctx,
        sent,
        requests,
        route };
}

/** Let the promises of an answer reach the component */
async function settle() : Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

/**
 * Timers a test moves by hand, so a deadline of minutes takes no time at all
 * @param t The running test
 */
function controlTime(t : TestContext) : void {
    t.mock.timers.enable({ apis: [ "setTimeout" ] });
}

test("an apply whose acknowledgement is lost stops waiting and lets the page go", async (t) => {
    controlTime(t);
    const { ctx, sent } = makePage();

    ctx.apply(true);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.eventName, "gitApplyUpdate");
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0]!.args)), [{ stackName: "alpha",
        previewId: "preview-1",
        choices: { "compose.yaml": "git" },
        editedContents: {},
        deploy: true }]);
    assert.equal(ctx.applying, true);
    assert.equal(options.beforeRouteLeave.call(ctx), false, "while the apply runs the page holds the person");

    // The server never answers: nothing acknowledges the request
    t.mock.timers.tick(15 * 60_000);
    await settle();

    assert.equal(ctx.applying, false, "a page that waits for ever cannot even be left");
    assert.equal(options.beforeRouteLeave.call(ctx), true);
    assert.equal(ctx.failure, "gitUiResultUnknown");
    assert.equal(ctx.result, null, "nothing is known about the files, so nothing is reported as done");

    // The server answers at last: this belongs to a wait that already ended
    sent[0]!.ack({ ok: true,
        deployed: true });
    await settle();
    assert.equal(ctx.result, null, "an answer that arrives after the wait ended changes nothing");
});

test("a connection lost during an apply ends the wait with an unknown result", async (t) => {
    controlTime(t);
    const { ctx, requests } = makePage();

    ctx.apply(false);
    assert.equal(requests.waiting, 1);

    // What the application does when the socket goes away
    requests.failAll();
    await settle();

    assert.equal(ctx.applying, false);
    assert.equal(ctx.failure, "gitUiResultUnknown");
    assert.equal(ctx.result, null);
    assert.equal(options.beforeRouteLeave.call(ctx), true);
});

test("the answer of the stack that was left is not applied to the stack that is open", async (t) => {
    controlTime(t);
    const { ctx, sent, route } = makePage();

    ctx.apply(true);
    assert.equal(ctx.applying, true);

    // The same page, another stack: the route changes without unmounting anything
    route.params.stackName = "beta";
    options.watch["$route.fullPath"]!.call(ctx);

    assert.equal(ctx.applying, false, "the new stack is not the one that was being applied");
    assert.equal(sent.length, 2, "the changes of the stack that is now open have to be read");
    assert.equal(sent[1]!.eventName, "gitPreviewUpdate");

    sent[0]!.ack({ ok: true,
        deployed: true });
    await settle();

    assert.equal(ctx.result, null, "the result of alpha must not be reported under beta");
    assert.equal(ctx.failure, "");
});

test("an answer that arrives after the page is gone is not applied", async (t) => {
    controlTime(t);
    const { ctx, sent } = makePage();

    ctx.apply(true);
    options.unmounted.call(ctx);

    sent[0]!.ack({ ok: true,
        deployed: true });
    await settle();

    assert.equal(ctx.result, null);
});

test("an apply that is acknowledged reports what happened to the files", async (t) => {
    controlTime(t);
    const { ctx, sent } = makePage();

    ctx.apply(true);
    sent[0]!.ack({ ok: true,
        deployed: true });
    await settle();

    assert.equal(ctx.applying, false);
    assert.equal(ctx.failure, "");
    assert.equal((ctx.result as { deployed : boolean }).deployed, true);
    assert.equal(options.beforeRouteLeave.call(ctx), true);
});

test("an apply that is refused says what the server said, not that the result is unknown", async (t) => {
    controlTime(t);
    const { ctx, sent } = makePage();

    ctx.apply(true);
    sent[0]!.ack({ ok: false,
        msg: "gitUiPreviewExpired" });
    await settle();

    assert.equal(ctx.applying, false);
    assert.equal(ctx.failure, "gitUiPreviewExpired");
    assert.equal(ctx.result, null);
});
