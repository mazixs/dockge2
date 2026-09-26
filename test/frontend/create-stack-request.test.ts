import { strict as assert } from "node:assert";
import test, { type TestContext } from "node:test";
import { parse } from "yaml";
import type { ConversionReport } from "../../common/docker-run-flags";
import { MAX_STACK_NAME_LENGTH } from "../../common/util-common";
import { AgentRequests } from "../../frontend/src/agent-requests";
import { componentOptions } from "../helpers/sfc";

/**
 * The options of the create-stack sheet, evaluated as the component defines them.
 *
 * What is under test is what happens to the sheet when the answer to a creation never
 * arrives, so the real component methods run against the real request transport, with
 * only the browser and the server replaced.
 */
const context : Record<string, unknown> = {
    parse,
    MAX_STACK_NAME_LENGTH,
    // Forwarded rather than captured, so a test that replaces the timers is obeyed
    setTimeout: (...args : Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (...args : Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args),
    setInterval: (...args : Parameters<typeof setInterval>) => globalThis.setInterval(...args),
    clearInterval: (...args : Parameters<typeof clearInterval>) => globalThis.clearInterval(...args) };

const options = componentOptions<{
    data : () => Record<string, unknown>,
    computed : Record<string, () => unknown>,
    methods : Record<string, (...args : never[]) => unknown>,
    watch : Record<string, (...args : never[]) => unknown>,
    unmounted : () => void,
        }>(new URL("../../frontend/src/components/CreateStackSheet.vue", import.meta.url), context);

/** A request the sheet sent, as the transport received it */
interface Sent {
    endpoint : string;
    eventName : string;
    args : unknown[];
    ack : (response : unknown) => void;
}

interface SheetContext extends Record<string, unknown> {
    name : string;
    source : string;
    saving : boolean;
    deploying : boolean;
    uncertain : boolean;
    failure : string;
    elapsed : number;
    visible : boolean;
    /** Writes the files, and starts the containers when asked to */
    send : (event : string, withDeploy : boolean) => void;
}

/** What the sheet did on its own: where it went, what it said, what it sent */
interface Sheet {
    ctx : SheetContext;
    sent : Sent[];
    pushed : string[];
    toasts : unknown[];
    fresh : string[];
    requests : AgentRequests;
}

/**
 * The sheet as its own methods see it, talking to a real request transport
 * @returns The sheet and everything it did
 */
function makeSheet() : Sheet {
    const sent : Sent[] = [];
    const pushed : string[] = [];
    const toasts : unknown[] = [];
    const fresh : string[] = [];

    // The real transport, with a server that answers only when a test says so
    const requests = new AgentRequests((endpoint, eventName, args, ack) => {
        sent.push({ endpoint,
            eventName,
            args: args as unknown[],
            ack: ack as (response : unknown) => void });
    });

    const ctx = { initialEndpoint: "",
        inline: false,
        $t: (key : string) => key,
        $emit: () => undefined,
        $router: { push: (path : string) => pushed.push(path) },
        $refs: {},
        $nextTick: () => Promise.resolve(),
        $root: {
            canManageStacks: true,
            agentStatusList: { "": "online" },
            envTemplate: "",
            emitAgentRequest: (endpoint : string, eventName : string, args : unknown[], requestOptions : unknown) =>
                requests.request(endpoint as never, eventName as never, args as never, requestOptions as never),
            emitAgent: (endpoint : string, eventName : string, ...rest : unknown[]) => {
                // The plain emit has no deadline: nothing ever answers this one
                sent.push({ endpoint,
                    eventName,
                    args: rest,
                    ack: () => undefined });
            },
            serverText: (message : { key : string } | string | undefined, fallback : string) =>
                (typeof message === "string" ? message : message?.key) || fallback,
            markStackFresh: (stackName : string) => fresh.push(stackName),
            toastRes: (res : unknown) => toasts.push(res),
        } } as unknown as SheetContext;

    for (const [ name, method ] of Object.entries(options.methods)) {
        ctx[name] = (...args : never[]) => method.apply(ctx, args);
    }

    Object.assign(ctx, options.data.call(ctx));

    for (const [ name, getter ] of Object.entries(options.computed)) {
        Object.defineProperty(ctx, name, { get: () => getter.call(ctx),
            configurable: true });
    }

    ctx.name = "alpha";
    ctx.source = "services:\n  app:\n    image: nginx:alpine\n";

    return { ctx,
        sent,
        pushed,
        toasts,
        fresh,
        requests };
}

/**
 * Let the promises of an answer reach the component
 */
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
    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval" ] });
}

test("a creation whose acknowledgement is lost ends with an unknown result", async (t) => {
    controlTime(t);
    const { ctx, sent, pushed, toasts, fresh } = makeSheet();

    ctx.send("deployStack", true);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.eventName, "deployStack");
    // Compared through JSON: the component builds its objects in its own realm
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0]!.args)), [ "alpha", ctx.source, "# VARIABLE=value #comment", true, { compose: null,
        env: null }]);
    assert.equal(ctx.deploying, true);

    // The clock of the deployment runs while the command runs
    t.mock.timers.tick(3000);
    assert.equal(ctx.elapsed, 3);

    // The server never answers: nothing acknowledges the request
    t.mock.timers.tick(15 * 60_000);
    await settle();

    assert.equal(ctx.deploying, false, "the sheet must not stay busy for ever");
    assert.equal(ctx.saving, false);
    assert.equal(ctx.uncertain, true, "the result is unknown, so the files must not be written again");
    assert.equal(ctx.failure, "gitUiResultUnknown");
    assert.equal(ctx.canDeploy, false, "an unknown result blocks repeating the creation");
    assert.deepEqual(pushed, [], "a stack that may not exist must not be opened");
    assert.deepEqual(fresh, []);
    assert.deepEqual(toasts, []);

    // The clock stopped with the attempt
    const elapsedAtDeadline = ctx.elapsed;
    t.mock.timers.tick(10_000);
    assert.equal(ctx.elapsed, elapsedAtDeadline, "a deployment nobody waits for must not keep counting");

    // The server answers at last: this belongs to a wait that already ended
    sent[0]!.ack({ ok: true });
    await settle();
    assert.deepEqual(pushed, [], "an answer that arrives after the wait ended changes nothing");
    assert.equal(ctx.uncertain, true);
});

test("a connection lost during a creation ends the wait with an unknown result", async (t) => {
    controlTime(t);
    const { ctx, requests, pushed } = makeSheet();

    ctx.send("saveStack", false);
    assert.equal(ctx.saving, true);
    assert.equal(requests.waiting, 1);

    // What the application does when the socket goes away
    requests.failAll();
    await settle();

    assert.equal(ctx.saving, false, "a save whose connection went away must not stay busy");
    assert.equal(ctx.deploying, false);
    assert.equal(ctx.uncertain, true);
    assert.equal(ctx.failure, "gitUiResultUnknown");
    assert.deepEqual(pushed, []);
});

test("an answer that arrives after the sheet is gone moves nobody anywhere", async (t) => {
    controlTime(t);
    const { ctx, sent, pushed, toasts } = makeSheet();

    ctx.send("deployStack", true);
    t.mock.timers.tick(2000);
    assert.equal(ctx.elapsed, 2);

    // The person navigated away while the deployment was running
    options.unmounted.call(ctx);

    sent[0]!.ack({ ok: true });
    await settle();

    assert.deepEqual(pushed, [], "a page the person left must not take them somewhere else");
    assert.deepEqual(toasts, []);

    t.mock.timers.tick(10_000);
    assert.equal(ctx.elapsed, 2, "the clock of a sheet that is gone must not keep counting");
});

test("a creation that is acknowledged opens the stack it created", async (t) => {
    controlTime(t);
    const { ctx, sent, pushed, toasts, fresh } = makeSheet();

    ctx.send("deployStack", true);
    t.mock.timers.tick(2000);

    sent[0]!.ack({ ok: true,
        msg: "done" });
    await settle();

    assert.equal(ctx.deploying, false);
    assert.equal(ctx.saving, false);
    assert.equal(ctx.uncertain, false);
    assert.equal(ctx.failure, "");
    assert.deepEqual(fresh, [ "alpha" ]);
    assert.equal(toasts.length, 1);
    assert.deepEqual(pushed, [ "/stack/alpha" ]);
    assert.equal(ctx.source, "", "the sheet starts empty for the next stack");

    t.mock.timers.tick(10_000);
    assert.equal(ctx.elapsed, 2, "the clock stops with the deployment it was counting");
});

test("a creation that is refused says what the server said, not that the result is unknown", async (t) => {
    controlTime(t);
    const { ctx, sent, pushed } = makeSheet();

    ctx.send("deployStack", true);
    sent[0]!.ack({ ok: false,
        msg: "stackNameAlreadyExists" });
    await settle();

    assert.equal(ctx.deploying, false);
    assert.equal(ctx.uncertain, false, "a refusal is an answer: the sheet may be sent again");
    assert.equal(ctx.failure, "stackNameAlreadyExists");
    assert.equal(ctx.canDeploy, true);
    assert.deepEqual(pushed, []);
});

test("a reason the server sent with its own values is shown as text, not as an object", async (t) => {
    controlTime(t);
    const { ctx, sent } = makeSheet();

    ctx.send("deployStack", true);
    sent[0]!.ack({ ok: false,
        msgi18n: true,
        msg: { key: "stackFileChangedElsewhere",
            values: { fileName: "compose.yaml" } } });
    await settle();

    assert.equal(ctx.failure, "stackFileChangedElsewhere", "a structured reason has to be translated, not printed");
    assert.equal(ctx.uncertain, false);
});

test("changing what is created starts a new attempt instead of repeating the unknown one", async (t) => {
    controlTime(t);
    const { ctx, sent } = makeSheet();

    ctx.send("deployStack", true);
    t.mock.timers.tick(15 * 60_000);
    await settle();
    assert.equal(ctx.uncertain, true);

    // The person renames the stack: this attempt is about something else
    ctx.name = "beta";
    options.watch.name!.call(ctx);

    assert.equal(ctx.uncertain, false);
    assert.equal(ctx.canDeploy, true);

    ctx.send("deployStack", true);
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.args[0], "beta");
});

test("creation sends the edited environment unchanged for save and deploy", async () => {
    for (const deploy of [ false, true ]) {
        const sheet = makeSheet();
        sheet.ctx.composeENV = "PORT=8123\nPASSWORD='a $literal value'\n";
        sheet.ctx.send(deploy ? "deployStack" : "saveStack", deploy);
        assert.equal(sheet.sent[0]!.args[2], sheet.ctx.composeENV);
        sheet.sent[0]!.ack({ ok: false,
            msg: "validation failed" });
        await settle();
        assert.equal(sheet.ctx.composeENV, "PORT=8123\nPASSWORD='a $literal value'\n");
        sheet.requests.failAll();
    }
});

/**
 * Give the sheet a server that answers a conversion at once
 * @param ctx The sheet
 * @param answer What the server answers
 * @returns The commands the sheet sent
 */
function answerConversion(ctx : SheetContext, answer : unknown) : unknown[] {
    const commands : unknown[] = [];

    (ctx.$root as Record<string, unknown>).getSocket = () => ({
        timeout: () => ({
            emit: (event : string, command : unknown, ack : (error : Error | null, response : unknown) => void) => {
                assert.equal(event, "convertDockerRun");
                commands.push(command);
                ack(null, answer);
            },
        }),
    });
    return commands;
}

test("a refused conversion shows the reason the server gave, as text", () => {
    const { ctx } = makeSheet();

    // The reason comes as a catalogue key with values, which is not text yet
    answerConversion(ctx, { ok: false,
        msg: { key: "dockerRunCommandTooLong",
            values: { max: "8192" } },
        msgi18n: true });
    ctx.source = "docker run nginx";
    (ctx.convert as () => void)();

    assert.equal(ctx.failure, "dockerRunCommandTooLong");
    assert.equal(ctx.converted, false);
    assert.equal(ctx.source, "docker run nginx", "a refused command stays as it was typed");

    answerConversion(ctx, { ok: false });
    (ctx.convert as () => void)();
    assert.equal(ctx.failure, "conversionFailed");
});

test("a flag that needs a look is shown instead of all flags carried", () => {
    const { ctx } = makeSheet();
    const compose = "services:\n  nginx:\n    image: nginx\n";
    const carried = { flag: "-d",
        outcome: "carried",
        reason: "flagNotNeeded" };
    const review = { flag: "--network",
        value: "proxy",
        outcome: "review",
        reason: "flagNetworkExternal" };
    const dropped = { flag: "-P",
        outcome: "dropped",
        reason: "flagPublishAllDropped" };
    const convertWith = (report : ConversionReport) => {
        (ctx.returnCommand as () => void)();
        answerConversion(ctx, { ok: true,
            composeTemplate: compose,
            report });
        ctx.source = "docker run -d --network proxy -P nginx";
        (ctx.convert as () => void)();
        assert.equal(ctx.source, compose);
    };

    convertWith({ carried: [ carried ],
        review: [ review ],
        dropped: [] } as ConversionReport);
    assert.deepEqual(ctx.firstProblem, review);
    assert.equal(ctx.restFlagCount, 1);

    // A lost flag comes before one that needs a look
    convertWith({ carried: [ carried ],
        review: [ review ],
        dropped: [ dropped ] } as ConversionReport);
    assert.deepEqual(ctx.firstProblem, dropped);
    assert.equal(ctx.restFlagCount, 2);
    // Compared through JSON: the component builds its arrays in its own realm
    assert.deepEqual(JSON.parse(JSON.stringify(ctx.allFlags)).map((item : { flag : string }) => item.flag), [ "-P", "--network", "-d" ]);

    // Only a report without either says that everything was carried
    convertWith({ carried: [ carried ],
        review: [],
        dropped: [] } as ConversionReport);
    assert.equal(ctx.firstProblem, null);
    assert.equal(ctx.restFlagCount, 1);
});

test("a command is recognised in every form the server converts, and compose is left alone", () => {
    const { ctx } = makeSheet();
    const looksLikeDockerRun = ctx.looksLikeDockerRun as (text : string) => boolean;

    for (const command of [ "docker run nginx", "  sudo docker run -d nginx", "docker container run nginx", "sudo docker container run nginx" ]) {
        assert.equal(looksLikeDockerRun(command), true, command);
    }
    for (const text of [ "services:\n  web:\n    image: nginx\n", "docker compose up", "docker runner" ]) {
        assert.equal(looksLikeDockerRun(text), false, text);
    }
});
