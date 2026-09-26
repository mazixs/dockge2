import { strict as assert } from "node:assert";
import test from "node:test";
import {
    PANEL_UPDATE_DEADLINES,
    PANEL_UPDATE_STORAGE_KEY,
    createPanelUpdateState,
    panelUpdateDeadline,
    reducePanelUpdate,
    type PanelUpdateEvent,
    type PanelUpdateRecord,
    type PanelUpdateState,
} from "../../frontend/src/panel-update-machine";
import { createSessionBootstrap } from "../../frontend/src/session-bootstrap";
import { APPLY_ID, FROM, TO, installSocketPage, panelOperation, panelStatus } from "../helpers/socket-page";
import { installGlobal } from "../helpers/vue-instance";

// This file never connects: the module's socket stays absent, as before the first connection
const page = installSocketPage("127.0.0.1", FROM);
const { default: socketMixin } = await import("../../frontend/src/mixins/socket");
installGlobal("window", () => page);

type Panel = InstanceType<typeof socketMixin>;

/** The option functions of the mixin, as `defineComponent` keeps them */
interface MixinOptions {
    data : (this : object) => object;
    computed : Record<string, (this : object) => unknown>;
    methods : Record<string, (this : object, ...args : never[]) => unknown>;
}

const options = socketMixin as unknown as MixinOptions;

const T0 = 1_900_000_000_000;
const PRELOAD_KEY = "dockge2.preloadReload";
const UNKNOWN = { ok: false,
    unknown: true,
    msgi18n: true,
    msg: "requestResultUnknown" };

/**
 * The root's session state without Vue: the real data, methods and computed values of the
 * mixin over a plain object, with the fields a test names set in place of the defaults.
 * A field named like a computed value replaces it.
 * @param fields Values to start from
 * @returns The state, typed as the root offers it
 */
function plain(fields : Record<string, unknown> = {}) : Panel {
    const ctx : Record<string, unknown> = { $t: (key : string) => key };
    Object.assign(ctx, options.data.call(ctx), fields);
    ctx.$data = ctx;
    for (const [ name, method ] of Object.entries(options.methods)) {
        ctx[name] = method.bind(ctx);
    }
    for (const [ name, getter ] of Object.entries(options.computed)) {
        if (!(name in fields)) {
            Object.defineProperty(ctx, name, { get: () => getter.call(ctx) });
        }
    }
    return ctx as unknown as Panel;
}

/**
 * Run events through the real machine
 * @param events Events in order
 * @returns The state they lead to
 */
function drive(...events : PanelUpdateEvent[]) : PanelUpdateState {
    return events.reduce((state, event) => reducePanelUpdate(state, event).state, createPanelUpdateState());
}

/**
 * An update this tab kept before a reload
 * @param stage How far it got
 * @param outcome How it ended, for a finished one
 * @returns The record
 */
function record(stage : PanelUpdateRecord["stage"], outcome : string | null = null) : PanelUpdateRecord {
    return { v: 1,
        request: APPLY_ID,
        from: FROM,
        to: TO,
        phase: "prepared",
        startedAt: T0,
        stage,
        outcome };
}

/**
 * What the tab keeps of the panel update
 * @returns The stored record, parsed
 */
function stored() : unknown {
    const text = page.sessionStorage.getItem(PANEL_UPDATE_STORAGE_KEY);
    return text === null ? null : JSON.parse(text);
}

/**
 * A stack row as the list keeps it
 * @param name Name of the stack
 * @param endpoint Agent it belongs to
 * @returns The row
 */
function stack(name : string, endpoint = "") {
    return { name,
        endpoint,
        status: 1 };
}

test("before any connection exists a request ends as unknown instead of waiting", async () => {
    const toasts : unknown[] = [];
    const written : unknown[] = [];
    const panel = plain({ $root: { toastRes: (response : unknown) => toasts.push(response) } });

    assert.deepEqual(await panel.emitAgentRequest("", "requestStackList", []), UNKNOWN);

    // A terminal that could not join is told so, and gets no output
    panel.bindTerminal("", "web-shell", { write: (data : unknown) => written.push(data) } as never);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(toasts, [ UNKNOWN ]);
    assert.deepEqual(written, []);
});

test("an endpoint is shown by its agent's name, by its address when unnamed, and not at all when unknown", () => {
    const panel = plain({ agentList: {
        "": { endpoint: "",
            name: "" },
        "10.0.0.2:5001": { endpoint: "10.0.0.2:5001",
            name: "Backup" },
        "10.0.0.3:5001": { endpoint: "10.0.0.3:5001",
            name: "" },
    } });

    assert.equal(panel.endpointDisplayFunction("10.0.0.2:5001"), "Backup");
    assert.equal(panel.endpointDisplayFunction("10.0.0.3:5001"), "10.0.0.3:5001");
    // The screens fall back to the address or to "this server" themselves
    assert.equal(panel.endpointDisplayFunction("10.0.0.9:5001"), undefined);
    assert.equal(panel.endpointDisplayFunction(""), undefined);
});

test("the agent count, the avatar letter and the version check read the session as it is", () => {
    assert.equal(plain().agentCount, 0);
    assert.equal(plain({ agentList: { "": { endpoint: "",
        name: "" },
    "10.0.0.2:5001": { endpoint: "10.0.0.2:5001",
        name: "Backup" } } }).agentCount, 2);

    assert.equal(plain({ username: "alice" }).usernameFirstChar, "A");
    assert.equal(plain({ username: "élodie" }).usernameFirstChar, "É");
    for (const username of [ null, "" ]) {
        assert.equal(plain({ username }).usernameFirstChar, "🐬");
    }

    assert.equal(plain().frontendVersion, FROM);
    // A server that has not said its version yet is not a mismatch
    assert.equal(plain({ info: {} }).isFrontendBackendVersionMatched, true);
    assert.equal(plain({ info: { version: FROM } }).isFrontendBackendVersionMatched, true);
    assert.equal(plain({ info: { version: TO } }).isFrontendBackendVersionMatched, false);
});

test("the role decides what the session may do, and the workspace waits for the full snapshot", () => {
    const roles : [ boolean, string, boolean, boolean ][] = [
        [ false, "admin", false, false ],
        [ true, "admin", true, true ],
        [ true, "operator", false, true ],
        [ true, "viewer", false, false ],
    ];
    for (const [ loggedIn, userRole, admin, manage ] of roles) {
        const panel = plain({ loggedIn,
            userRole });
        assert.equal(panel.isAdmin, admin, `${userRole} signed in: ${loggedIn}`);
        assert.equal(panel.canManageStacks, manage, `${userRole} signed in: ${loggedIn}`);
    }

    const ready = { ...createSessionBootstrap(),
        ready: true };
    assert.equal(plain({ loggedIn: true,
        sessionBootstrap: ready }).appReady, true);
    assert.equal(plain({ loggedIn: false,
        sessionBootstrap: ready }).appReady, false);
    assert.equal(plain({ loggedIn: true }).appReady, false);

    // The loading screen is shown only while nothing else explains the wait
    assert.equal(plain().sessionBootstrapping, true);
    assert.equal(plain({ allowLoginDialog: true }).sessionBootstrapping, false);
    assert.equal(plain({ sessionBootstrap: { ...createSessionBootstrap(),
        anonymous: true } }).sessionBootstrapping, false);
    const failed = plain({ sessionBootstrap: { ...createSessionBootstrap(),
        error: "authConnectionFailed" } });
    assert.equal(failed.sessionBootstrapping, false);
    assert.equal(failed.sessionBootstrapError, "authConnectionFailed");
});

test("a running update is an overlay for the signed-in owner and a banner for everyone else", () => {
    const running = drive({ type: "BOOT",
        persisted: record("running"),
        now: T0 });
    assert.equal(plain({ loggedIn: true,
        userRole: "admin",
        panelUpdate: running }).panelUpdateView, "overlay");
    assert.equal(plain({ loggedIn: true,
        userRole: "operator",
        panelUpdate: running }).panelUpdateView, "banner");
    assert.equal(plain({ loggedIn: false,
        panelUpdate: running }).panelUpdateView, "banner");
    assert.equal(plain({ loggedIn: true,
        userRole: "admin" }).panelUpdateView, "none");
});

test("the stacks of every endpoint are listed together, each under a key of its own", () => {
    const panel = plain({ stackList: { web: stack("web") },
        allAgentStackList: {
            "10.0.0.2:5001": { stackList: { web: stack("web", "10.0.0.2:5001"),
                db: stack("db", "10.0.0.2:5001") } },
        } });

    assert.deepEqual(Object.keys(panel.completeStackList).sort(), [ "db_10.0.0.2:5001", "web_", "web_10.0.0.2:5001" ]);
    assert.equal(panel.completeStackList["web_"]?.endpoint, "");
    assert.equal(panel.completeStackList["web_10.0.0.2:5001"]?.endpoint, "10.0.0.2:5001");
});

test("a new stack stays marked for its time, and an older mark does not clear a newer one", (t) => {
    t.mock.timers.enable({ apis: [ "setTimeout" ] });
    const panel = plain();

    panel.markStackFresh("web", 1_000);
    assert.equal(panel.freshStack, "web");
    t.mock.timers.tick(500);
    panel.markStackFresh("db", 1_000);
    t.mock.timers.tick(500);
    assert.equal(panel.freshStack, "db");
    t.mock.timers.tick(500);
    assert.equal(panel.freshStack, null);

    panel.markStackFresh("cache");
    t.mock.timers.tick(59_999);
    assert.equal(panel.freshStack, "cache");
    t.mock.timers.tick(1);
    assert.equal(panel.freshStack, null);
});

test("ending a session drops everything the next user of the browser must not see", () => {
    const panel = plain({ userRole: "admin",
        userID: "u-1",
        stackList: { web: stack("web") },
        allAgentStackList: { "10.0.0.2:5001": { stackList: { db: stack("db", "10.0.0.2:5001") } } },
        agentList: { "10.0.0.2:5001": { endpoint: "10.0.0.2:5001",
            name: "Backup" } },
        agentStatusList: { "": "online",
            "10.0.0.2:5001": "online" },
        composeTemplate: "services: {}\n",
        freshStack: "web" });

    panel.clearData();
    assert.deepEqual({ userRole: panel.userRole,
        userID: panel.userID,
        stackList: panel.stackList,
        allAgentStackList: panel.allAgentStackList,
        agentList: panel.agentList,
        agentStatusList: panel.agentStatusList,
        composeTemplate: panel.composeTemplate,
        freshStack: panel.freshStack }, { userRole: "viewer",
        userID: null,
        stackList: {},
        allAgentStackList: {},
        agentList: {},
        agentStatusList: {},
        composeTemplate: "",
        freshStack: null });
    assert.deepEqual(panel.completeStackList, {});
});

test("a missing chunk reloads the page once, and again only after the guard has passed", (t) => {
    t.mock.timers.enable({ apis: [ "Date" ],
        now: T0 });
    page.sessionStorage.clear();
    const panel = plain();
    const reloads = page.location.reloads;

    const first = new Event("vite:preloadError", { cancelable: true });
    panel.onPreloadError(first);
    assert.equal(page.location.reloads, reloads + 1);
    assert.equal(first.defaultPrevented, true, "the reload replaces Vite's own error");
    assert.equal(page.sessionStorage.getItem(PRELOAD_KEY), String(T0));

    // The chunk is still missing after the reload: the error stays instead of a loop
    t.mock.timers.tick(9_999);
    const again = new Event("vite:preloadError", { cancelable: true });
    panel.onPreloadError(again);
    assert.equal(page.location.reloads, reloads + 1);
    assert.equal(again.defaultPrevented, false);

    t.mock.timers.tick(1);
    panel.onPreloadError(new Event("vite:preloadError", { cancelable: true }));
    assert.equal(page.location.reloads, reloads + 2);

    // A mark from a clock that went back, or one that is not a time, does not hold the reload
    for (const mark of [ String(T0 + 60_000), "not a time" ]) {
        page.sessionStorage.setItem(PRELOAD_KEY, mark);
        const before = page.location.reloads;
        panel.onPreloadError(new Event("vite:preloadError", { cancelable: true }));
        assert.equal(page.location.reloads, before + 1, mark);
    }
});

test("a missing chunk does not reload when the tab cannot remember it, or while an update runs", (t) => {
    t.mock.timers.enable({ apis: [ "Date" ],
        now: T0 });
    page.sessionStorage.clear();
    const reloads = page.location.reloads;

    page.sessionStorage.blocked = true;
    const blocked = new Event("vite:preloadError", { cancelable: true });
    plain().onPreloadError(blocked);
    page.sessionStorage.blocked = false;
    assert.equal(page.location.reloads, reloads, "without storage the next page would reload again");
    assert.equal(blocked.defaultPrevented, false);

    const updating = new Event("vite:preloadError", { cancelable: true });
    plain({ panelUpdateSuppressing: true }).onPreloadError(updating);
    assert.equal(page.location.reloads, reloads, "a reload with the panel down lands on an error page");
    assert.equal(updating.defaultPrevented, false);
    assert.equal(page.sessionStorage.getItem(PRELOAD_KEY), null);
});

test("leaving is questioned only while an update runs and the panel does not answer", () => {
    const offline = drive({ type: "BOOT",
        persisted: record("running"),
        now: T0 });
    const cases : [ string, PanelUpdateState, boolean ][] = [
        [ "running, panel unreachable", offline, true ],
        [ "running, panel answering", reducePanelUpdate(offline, { type: "LINK_UP",
            now: T0 }).state, false ],
        [ "no update, panel unreachable", drive({ type: "BOOT",
            persisted: null,
            now: T0 }), false ],
    ];
    for (const [ name, panelUpdate, asks ] of cases) {
        const event = { defaultPrevented: false,
            returnValue: undefined as unknown,
            preventDefault() {
                this.defaultPrevented = true;
            } };
        plain({ panelUpdate }).onBeforeUnload(event as unknown as BeforeUnloadEvent);
        assert.equal(event.defaultPrevented, asks, name);
        assert.equal(event.returnValue, asks ? "" : undefined, name);
    }
});

test("the panel update keeps a followed operation in the tab, forgets a failed one and reloads for a new build", (t) => {
    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval", "Date" ],
        now: T0 });
    page.sessionStorage.clear();
    const reloads = page.location.reloads;
    const panel = plain();

    panel.dispatchPanelUpdate({ type: "BOOT",
        persisted: null,
        now: T0,
        build: FROM });
    panel.dispatchPanelUpdate({ type: "STATUS",
        status: panelStatus(FROM, panelOperation("apply", APPLY_ID)),
        solicited: false,
        ask: null,
        now: T0 });
    assert.equal(panel.panelUpdate.node.name, "running");
    assert.deepEqual(stored(), { ...record("running"),
        phase: null });

    // The update finished while this page ran the old build: it loads the new one
    panel.dispatchPanelUpdate({ type: "STATUS",
        status: panelStatus(TO, panelOperation("apply", APPLY_ID, "success")),
        solicited: false,
        ask: null,
        now: T0 });
    assert.equal(page.location.reloads, reloads + 1);
    assert.deepEqual(stored(), { ...record("finished", "success"),
        phase: null });
    assert.equal(panel.panelUpdateSuppressing, true);

    // A reload that does not happen is noticed by the clock, which then stops
    assert.notEqual(panelUpdateDeadline(panel.panelUpdate), null);
    t.mock.timers.tick(5_000);
    assert.equal((panel.panelUpdate.node as { stalled? : boolean }).stalled, true);
    assert.equal(panelUpdateDeadline(panel.panelUpdate), null);

    // A failed update found after a reload is not shown again
    panel.dispatchPanelUpdate({ type: "BOOT",
        persisted: record("finished", "failed-before-cutover"),
        now: T0 });
    assert.equal(stored(), null);
});

test("blocked tab storage does not stop the panel update", (t) => {
    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval", "Date" ],
        now: T0 });
    page.sessionStorage.blocked = true;
    t.after(() => {
        page.sessionStorage.blocked = false;
    });
    const panel = plain();

    panel.dispatchPanelUpdate({ type: "BOOT",
        persisted: null,
        now: T0 });
    panel.dispatchPanelUpdate({ type: "STATUS",
        status: panelStatus(FROM, panelOperation("apply", APPLY_ID)),
        solicited: false,
        ask: null,
        now: T0 });
    assert.equal(panel.panelUpdate.node.name, "running");

    panel.dispatchPanelUpdate({ type: "AUTH_LOST" });
    assert.equal(panelUpdateDeadline(panel.panelUpdate), null);
});

test("the one-second clock runs only while a deadline is armed, and stops once it has passed", (t) => {
    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval", "Date" ],
        now: T0 });
    const panel = plain();
    const dispatch = panel.dispatchPanelUpdate;
    let ticks = 0;
    panel.dispatchPanelUpdate = (event : PanelUpdateEvent) => {
        ticks += event.type === "TICK" ? 1 : 0;
        dispatch(event);
    };

    panel.dispatchPanelUpdate({ type: "BOOT",
        persisted: null,
        now: Date.now() });
    t.mock.timers.tick(10_000);
    assert.equal(ticks, 0, "nothing waits on the clock");

    // Resumed after a reload with the panel unreachable: the deadline of the step runs
    panel.dispatchPanelUpdate({ type: "BOOT",
        persisted: record("running"),
        now: Date.now() });
    const deadline = PANEL_UPDATE_DEADLINES.downloading;
    t.mock.timers.tick(deadline - 1_000);
    assert.equal(ticks, deadline / 1_000 - 1);
    assert.equal(panel.panelUpdate.ctx.link.kind === "offline" && panel.panelUpdate.ctx.link.overdue, false);

    t.mock.timers.tick(1_000);
    assert.equal(panel.panelUpdate.ctx.link.kind === "offline" && panel.panelUpdate.ctx.link.overdue, true);
    t.mock.timers.tick(10_000);
    assert.equal(ticks, deadline / 1_000, "the clock stops with nothing left to wait for");
});

test("only the owner starts a dry run, with a UUID request even outside a secure context", (t) => {
    t.mock.timers.enable({ apis: [ "setTimeout", "setInterval", "Date" ],
        now: T0 });
    const available = drive({ type: "BOOT",
        persisted: null,
        now: T0 }, { type: "INFO",
        latestVersion: TO,
        updateAvailable: true }, { type: "LINK_UP",
        now: T0 }, { type: "ACK",
        kind: "status",
        ask: 1,
        result: { kind: "ok",
            status: panelStatus(FROM) },
        now: T0 });
    assert.deepEqual([ available.node.name, (available.node as { sub : string }).sub ], [ "idle", "available" ]);

    const operator = plain({ loggedIn: true,
        userRole: "operator",
        panelUpdate: available });
    operator.panelUpdateCheck();
    assert.equal(operator.panelUpdate.node.name, "idle");

    // `crypto.randomUUID` exists only in a secure context, and a panel is often opened over plain HTTP
    Object.defineProperty(crypto, "randomUUID", { value: undefined,
        configurable: true });
    t.after(() => Reflect.deleteProperty(crypto, "randomUUID"));
    const owner = plain({ loggedIn: true,
        userRole: "admin",
        panelUpdate: available });
    owner.panelUpdateCheck();
    const node = owner.panelUpdate.node as { name : string; sub : string; request : string };
    assert.deepEqual([ node.name, node.sub ], [ "preview", "checking" ]);
    assert.match(node.request, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Without a connection nothing is sent, and the answer is "lost" rather than a wait
    assert.equal(owner.panelUpdate.node, node, "the loss is reported asynchronously, like an answer");
    t.mock.timers.tick(0);
    assert.notEqual(owner.panelUpdate.node, node);
});
