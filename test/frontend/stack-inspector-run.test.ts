import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { RequestTracker } from "../../frontend/src/request-tracker";
import { StackRun } from "../../frontend/src/stack-run";
import type { ComposeTask } from "../../common/compose-progress";

/**
 * The options of the inspector, evaluated as the component defines them.
 *
 * The page cannot be mounted here, but the methods that decide what belongs to which
 * stack are plain functions: they are called with a context the test controls, which is
 * what makes the answer of a stack that was left observable at all.
 */
const source = readFileSync(new URL("../../frontend/src/pages/StackInspector.vue", import.meta.url), "utf8");
const script = source.split("<script>")[1]!.split("</script>")[0]!
    .replace(/^import .*;$/gm, "")
    .replace("export default", "result =");

const context : Record<string, unknown> = { result: {},
    // Only the identifiers the options object mentions while it is being built
    StateChip: {},
    InterfaceIcon: {},
    StackSourcePanel: {},
    StackJournal: {},
    StackTerminals: {},
    StackProgress: {},
    BModal: {},
    Uptime: {},
    defineAsyncComponent: () => ({}),
    // A separate context has no timers of its own, and the page uses them
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    stackColor: () => "",
    markRaw: <T>(value : T) => value,
    RequestTracker,
    StackRun };

runInNewContext(script, context);

const options = context.result as {
    data : () => Record<string, unknown>,
    methods : Record<string, (...args : never[]) => unknown>,
};

/** A promise the test answers when it wants to */
interface Answer {
    promise : Promise<unknown>;
    reply : (value : unknown) => void;
}

/**
 * A request whose answer arrives when the test says so
 * @returns The promise and the way to answer it
 */
function answer() : Answer {
    let reply : (value : unknown) => void = () => undefined;
    const promise = new Promise<unknown>((resolve) => {
        reply = resolve;
    });

    return { promise,
        reply };
}

interface InspectorContext extends Record<string, unknown> {
    operation : StackRun;
    requests : RequestTracker;
    stackName : string;
    endpoint : string;
    /** Starts a command for the stack the context is on */
    run : (event : string) => void;
    /** Reads the stack the context points at, as picking another one does */
    loadStack : () => void;
    /** A step reported by the progress line of some stack */
    onProgress : (progress : { endpoint : string, stackName : string, tasks : ComposeTask[], hasOutput : boolean }) => void;
}

/**
 * The inspector as its own methods see it: real data, real request tracker, real run
 * state, and stubs only where the screen would talk to the browser or the server.
 * @param sent Requests the component sends, collected in order
 * @param toasts Messages the component would show
 * @param statusReads How often the component asked for the service status
 * @returns The context to call the methods with
 */
function makeContext(sent : Answer[], toasts : unknown[], statusReads : { count : number }) : InspectorContext {
    const ctx = { $route: { params: {} },
        $root: {
            canManageStacks: false,
            emitAgentRequest: () => {
                const pending = answer();
                sent.push(pending);
                return pending.promise;
            },
            toastRes: (res : unknown) => toasts.push(res),
        },
        stackName: "alpha",
        endpoint: "",
        stack: {},
        globalStack: null,
        processing: false } as unknown as InspectorContext;

    for (const [ name, method ] of Object.entries(options.methods)) {
        ctx[name] = (...args : never[]) => method.apply(ctx, args);
    }

    Object.assign(ctx, options.data.call(ctx));

    // The screen itself is not there: these read from the server or the DOM
    ctx.requestServiceStatus = () => {
        statusReads.count++;
    };
    ctx.requestAvailability = () => undefined;
    ctx.parseConfig = () => undefined;
    ctx.leaveLogs = () => undefined;

    return ctx;
}

for (const [ outcome, reply ] of [
    [ "ok", { ok: true }],
    [ "failed", { ok: false,
        msg: "no" }],
    [ "unknown", { ok: false,
        unknown: true }],
] as const) {
    test(`the ${outcome} answer of the stack that was left does not reach the stack that is open`, async (t) => {
        const sent : Answer[] = [];
        const toasts : unknown[] = [];
        const statusReads = { count: 0 };
        const ctx = makeContext(sent, toasts, statusReads);
        const operation = ctx.operation;
        t.after(() => operation.release());

        // An update is started for alpha
        ctx.run("updateStack");
        assert.equal(ctx.operation.running, true);
        assert.equal(ctx.operation.event, "updateStack");

        // The user picks beta while it is still running
        ctx.stackName = "beta";
        ctx.loadStack();

        assert.equal(ctx.operation, operation, "the run state has to be released, not replaced by a new one");
        assert.equal(ctx.operation.running, false, "beta must not show the command of alpha");
        assert.equal(ctx.operation.event, "");
        assert.equal(ctx.operation.outcome, "");
        assert.deepEqual(ctx.operation.tasks, []);

        const readsAfterSwitch = statusReads.count;
        const toastsAfterSwitch = toasts.length;

        // Only now does alpha answer
        sent[0]!.reply(reply);
        await sent[0]!.promise;
        await Promise.resolve();

        assert.equal(ctx.operation.outcome, "", "the outcome of alpha must not appear under beta");
        assert.equal(ctx.operation.running, false);
        assert.equal(toasts.length, toastsAfterSwitch, "the message belongs to a screen the user left");
        assert.equal(statusReads.count, readsAfterSwitch, "a stack nobody is looking at is not polled");
    });
}

test("the answer of the stack that is still open is applied to it", async (t) => {
    const sent : Answer[] = [];
    const toasts : unknown[] = [];
    const statusReads = { count: 0 };
    const ctx = makeContext(sent, toasts, statusReads);
    t.after(() => ctx.operation.release());

    ctx.run("updateStack");
    sent[0]!.reply({ ok: true });
    await sent[0]!.promise;
    await Promise.resolve();

    assert.equal(ctx.operation.running, false);
    assert.equal(ctx.operation.outcome, "ok");
    assert.equal(toasts.length, 1);
    assert.equal(statusReads.count > 0, true, "the state of the stack is read again once the command ended");
});

test("a lost answer of the open stack is an unknown outcome, not a failure", async (t) => {
    const sent : Answer[] = [];
    const toasts : unknown[] = [];
    const ctx = makeContext(sent, toasts, { count: 0 });
    t.after(() => ctx.operation.release());

    ctx.run("updateStack");
    sent[0]!.reply({ ok: false,
        unknown: true });
    await sent[0]!.promise;
    await Promise.resolve();

    assert.equal(ctx.operation.outcome, "unknown");
});

test("the progress of the stack that was left is not shown under the new one", (t) => {
    const ctx = makeContext([], [], { count: 0 });
    t.after(() => ctx.operation.release());

    ctx.run("updateStack");
    ctx.onProgress({ endpoint: "",
        stackName: "alpha",
        tasks: [{ key: "container:alpha-app-1",
            kind: "container",
            name: "alpha-app-1",
            verb: "starting",
            state: "working",
            seconds: null }],
        hasOutput: true });
    assert.equal(ctx.operation.tasks.length, 1);

    ctx.stackName = "beta";
    ctx.loadStack();
    ctx.run("startStack");

    // A step of alpha arrives after the switch, from the terminal of the old stack
    ctx.onProgress({ endpoint: "",
        stackName: "alpha",
        tasks: [{ key: "container:alpha-app-1",
            kind: "container",
            name: "alpha-app-1",
            verb: "started",
            state: "done",
            seconds: 1 }],
        hasOutput: true });

    assert.deepEqual(ctx.operation.tasks, [], "the steps of another stack must not describe this one");
    assert.equal(ctx.operation.event, "startStack");
});

for (const [ outcome, reply ] of [
    [ "ok", { ok: true }],
    [ "failed", { ok: false,
        msg: "Compose failed" }],
    [ "unknown", { ok: false,
        unknown: true }],
] as const) {
    test(`deletion reports ${outcome} through command progress and only leaves on success`, async (t) => {
        const sent : Answer[] = [];
        const ctx = makeContext(sent, [], { count: 0 });
        const routes : string[] = [];
        ctx.$router = { push: (route : string) => routes.push(route) };
        t.after(() => ctx.operation.release());

        (ctx.deleteStack as () => void)();
        assert.equal(ctx.operation.event, "deleteStack");
        assert.equal(ctx.processing, true);
        (ctx.deleteStack as () => void)();
        assert.equal(sent.length, 1, "a second click must not repeat deletion");

        sent[0]!.reply(reply);
        await sent[0]!.promise;
        await Promise.resolve();

        assert.equal(ctx.operation.outcome, outcome);
        assert.equal(ctx.processing, false);
        assert.deepEqual(routes, outcome === "ok" ? [ "/" ] : []);
    });
}

test("a deletion completed after navigation does not redirect away from the new stack", async (t) => {
    const sent : Answer[] = [];
    const ctx = makeContext(sent, [], { count: 0 });
    const routes : string[] = [];
    ctx.$router = { push: (route : string) => routes.push(route) };
    t.after(() => ctx.operation.release());

    (ctx.deleteStack as () => void)();
    ctx.stackName = "beta";
    ctx.loadStack();
    sent[0]!.reply({ ok: true });
    await sent[0]!.promise;
    await Promise.resolve();

    assert.deepEqual(routes, []);
    assert.equal(ctx.operation.outcome, "");
});
