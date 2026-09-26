import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, type TestContext } from "node:test";
import type { Terminal } from "@xterm/xterm";
import { Server, type Socket as PeerSocket } from "socket.io";
import { nextTick } from "vue";
import { PANEL_UPDATE_EVENTS, PANEL_UPDATE_REQUEST_PATTERN, type PanelUpdateStatus } from "../../common/panel-update";
import { PANEL_UPDATE_STORAGE_KEY, createPanelUpdateState, panelUpdateDeadline, reducePanelUpdate } from "../../frontend/src/panel-update-machine";
import { APPLY_ID, FROM, TO, installSocketPage, panelOperation, panelStatus } from "../helpers/socket-page";
import { installGlobal, mountOptions } from "../helpers/vue-instance";

// The panel as the page reaches it: Socket.IO and the auth endpoints on one local port.
// Auth answers are set per test; every request is recorded with its body.
const authAnswers = new Map<string, { status : number; body : unknown }>();
const authRequests : { path : string; body : unknown }[] = [];
const http = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk : Buffer) => {
        text += chunk.toString();
    });
    request.on("end", () => {
        const path = new URL(request.url ?? "/", "http://panel.invalid").pathname;
        authRequests.push({ path,
            body: text ? JSON.parse(text) : null });
        const answer = authAnswers.get(path) ?? { status: 404,
            body: { message: "Not found" } };
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
    });
});
const io = new Server(http);
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
after(async () => {
    http.closeAllConnections();
    await io.close();
});

const page = installSocketPage(`127.0.0.1:${(http.address() as AddressInfo).port}`, FROM);
const { default: socketMixin } = await import("../../frontend/src/mixins/socket");
installGlobal("window", () => page);

type Panel = InstanceType<typeof socketMixin>;

const UNKNOWN = { ok: false,
    unknown: true,
    msgi18n: true,
    msg: "requestResultUnknown" };
const PASSWORD = "invented-password-7";
const OWNER = { id: "u-1",
    username: "owner",
    name: "Owner",
    email: "owner@example.test" };

/** A page connected to the test server */
interface OpenPanel {
    vm : Panel;
    /** The server's side of the page's socket */
    peer : PeerSocket;
    /** What the page showed as toasts */
    toasts : unknown[];
    /** Where the page navigated to */
    pushed : string[];
}

/**
 * Open the page against the test server and wait for its socket to connect.
 *
 * The server answers the status question of the panel update, by default with a panel
 * that cannot update itself, so no deadline waits on a question nobody answers. The clock
 * of the panel update belongs to the module and outlives a page, so every test has to end
 * with nothing armed.
 * @param t Test that owns the page
 * @param status The status the server answers with
 * @returns The page and the server's end of its connection
 */
async function openPanel(t : TestContext, status : () => PanelUpdateStatus = () => panelStatus(FROM, undefined, "no")) : Promise<OpenPanel> {
    const toasts : unknown[] = [];
    const pushed : string[] = [];
    const router = { currentRoute: { value: { path: "/" } },
        push(path : string) {
            pushed.push(path);
            router.currentRoute.value = { path };
        } };
    // Every page opens in a new tab, without an operation an earlier test left in its storage
    page.sessionStorage.clear();
    const connection = new Promise<PeerSocket>((resolve) => io.once("connection", resolve));
    const mounted = mountOptions<Panel>({ mixins: [ socketMixin ],
        methods: {
            toastRes(response : unknown) {
                toasts.push(response);
            },
            toastError(message : unknown) {
                toasts.push(message);
            },
        } }, { $t: (key : string) => key,
        $router: router });
    const connected = new Promise<void>((resolve) => mounted.vm.getSocket().once("connect", () => resolve()));
    const peer = await connection;
    peer.on(PANEL_UPDATE_EVENTS.status, (ack : (answer : unknown) => void) => ack({ ok: true,
        status: status() }));
    await connected;
    // A page spends its life on the WebSocket, and closing a polling connection from the
    // server leaves engine.io's 30 second close timer holding the test process
    if (peer.conn.transport.name !== "websocket") {
        await new Promise((resolve) => peer.conn.once("upgrade", resolve));
    }
    t.after(() => {
        mounted.vm.getSocket().disconnect();
        mounted.unmount();
        assert.deepEqual(mounted.errors, []);
        assert.equal(panelUpdateDeadline(mounted.vm.panelUpdate), null, "the test left the panel update clock running");
    });
    return { vm: mounted.vm,
        peer,
        toasts,
        pushed };
}

/**
 * Wait for something the page does when a message arrives
 * @param check True once it happened
 * @param what What is awaited, for the failure message
 */
async function until(check : () => boolean, what = "the page to react") : Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!check()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

/**
 * A stack row as the server lists it
 * @param name Name of the stack
 * @param endpoint Agent it belongs to
 * @returns The row
 */
function stack(name : string, endpoint = "") {
    return { name,
        endpoint,
        status: 1,
        tags: [] };
}

/**
 * The node of the panel update, loosely typed for the checks
 * @param vm Page
 * @returns The node
 */
function node(vm : Panel) {
    return vm.panelUpdate.node as { name : string; sub? : string; ackPending? : boolean; request? : string; dialog? : boolean };
}

/**
 * A terminal renderer that records what it was given
 * @param sink Where the writes go
 * @returns The renderer
 */
function renderer(sink : unknown[]) : Terminal {
    return { write: (data : unknown) => sink.push(data),
        clear: () => sink.push("<clear>") } as unknown as Terminal;
}

test("a connection marks this server online; losing it marks it offline and ends every waiting request as unknown", async (t) => {
    const { vm, peer } = await openPanel(t);
    await nextTick();

    assert.deepEqual({ ...vm.socketIO,
        connectionErrorMsg: undefined }, { firstConnect: false,
        connected: true,
        connectCount: 1,
        initedSocketIO: true,
        connectionErrorMsg: undefined,
        showReverseProxyGuide: false,
        connecting: false });
    assert.equal(vm.agentStatusList[""], "online");
    // A transport connection is not yet a session: nobody is identified and nothing is loaded
    assert.equal(vm.loggedIn, false);
    assert.equal(vm.sessionBootstrapping, true);

    const asked = new Promise((resolve) => peer.once("agent", (...args : unknown[]) => resolve(args.slice(0, -1))));
    const waiting = vm.emitAgentRequest("", "getStack", [ "web" ], { timeoutMs: 60_000 });
    assert.deepEqual(await asked, [ "", "getStack", "web" ]);

    peer.disconnect(true);
    assert.deepEqual(await waiting, UNKNOWN);
    await nextTick();
    assert.equal(vm.socketIO.connected, false);
    assert.equal(vm.agentStatusList[""], "offline");
    assert.equal(vm.socketIO.connectionErrorMsg, "socketConnectionLost");
    assert.equal(vm.panelUpdate.ctx.link.kind, "offline");
});

test("an answer is returned, a missing one ends as unknown at its deadline, and failing the waiting requests ends them at once", async (t) => {
    const { vm, peer } = await openPanel(t);
    const held : ((answer : unknown) => void)[] = [];
    peer.on("agent", (_endpoint : string, eventName : string, ...rest : unknown[]) => {
        const ack = rest.pop() as (answer : unknown) => void;
        if (eventName === "getStack") {
            ack({ ok: true,
                stack: { name: rest[0] } });
        } else {
            held.push(ack);
        }
    });

    assert.deepEqual(await vm.emitAgentRequest("", "getStack", [ "web" ]), { ok: true,
        stack: { name: "web" } });
    assert.deepEqual(await vm.emitAgentRequest("", "requestStackList", [], { timeoutMs: 50 }), UNKNOWN);

    const waiting = vm.emitAgentRequest("", "requestStackList", [], { timeoutMs: 60_000 });
    await until(() => held.length === 2, "the second request to reach the server");
    vm.failPendingRequests();
    assert.deepEqual(await waiting, UNKNOWN);
    assert.equal(vm.socketIO.connected, true, "ending the requests does not end the connection");
});

test("a terminal gets its buffer and its output only while it is bound, and a late join cannot revive it", async (t) => {
    const { vm, peer, toasts } = await openPanel(t);
    const joins = new Map<string, ((answer : unknown) => void)[]>();
    peer.on("agent", (_endpoint : string, eventName : string, name : string, ack : (answer : unknown) => void) => {
        if (eventName === "terminalJoin") {
            joins.set(name, [ ...joins.get(name) ?? [], ack ]);
        }
    });
    /**
     * The acknowledgement of a join the server holds
     * @param name Terminal name
     * @param index Which join of that name
     * @returns Answers the join
     */
    const join = async (name : string, index = 0) => {
        await until(() => (joins.get(name)?.length ?? 0) > index, `the join of ${name}`);
        return joins.get(name)![index]!;
    };
    const out = { shell: [] as unknown[],
        late: [] as unknown[],
        stale: [] as unknown[],
        fresh: [] as unknown[] };

    vm.bindTerminal("", "web-shell", renderer(out.shell));
    (await join("web-shell"))({ ok: true,
        buffer: "earlier\r\n" });
    await until(() => out.shell.length === 1, "the buffer");

    // Output is checked as it arrives: text and bytes are written, anything else is dropped
    peer.emit("agent", "terminalWrite", "web-shell", "live\r\n");
    peer.emit("agent", "terminalWrite", "web-shell", Buffer.from("bytes"));
    peer.emit("agent", "terminalWrite", "web-shell", 42);
    peer.emit("agent", "terminalWrite", "nobody", "lost");
    peer.emit("agent", "terminalWrite", "web-shell", "end\r\n");
    await until(() => out.shell.length === 4, "the output");
    assert.deepEqual(out.shell.map((data) => Buffer.from(data as string | Uint8Array).toString()), [ "earlier\r\n", "live\r\n", "bytes", "end\r\n" ]);

    vm.unbindTerminal("web-shell");
    peer.emit("agent", "terminalWrite", "web-shell", "after unbind");

    // A join answered after its renderer went away must not bind it again
    vm.bindTerminal("", "web-logs", renderer(out.late));
    const lateJoin = await join("web-logs");
    vm.unbindTerminal("web-logs");
    lateJoin({ ok: true,
        buffer: "late" });

    // Two joins of one name: only the renderer that asked last is bound
    vm.bindTerminal("", "db-shell", renderer(out.stale));
    vm.bindTerminal("", "db-shell", renderer(out.fresh));
    (await join("db-shell", 0))({ ok: true,
        buffer: "stale" });
    (await join("db-shell", 1))({ ok: true,
        buffer: "fresh" });
    await until(() => out.fresh.length === 1, "the buffer of the rebound terminal");
    peer.emit("agent", "terminalWrite", "db-shell", "to fresh");
    await until(() => out.fresh.length === 2, "the output of the rebound terminal");

    assert.deepEqual(out.fresh, [ "fresh", "to fresh" ]);
    assert.deepEqual(out.stale, []);
    assert.deepEqual(out.late, []);
    assert.equal(out.shell.length, 4);

    // A refused join is reported, unless a newer join of that name took over
    vm.bindTerminal("", "cache-shell", renderer([]));
    vm.bindTerminal("", "cache-shell", renderer([]));
    (await join("cache-shell", 0))({ ok: false,
        msg: "superseded" });
    (await join("cache-shell", 1))({ ok: false,
        msgi18n: true,
        msg: "terminalNotFound" });
    await until(() => toasts.length > 0, "the refusal");
    assert.deepEqual(toasts, [{ ok: false,
        msgi18n: true,
        msg: "terminalNotFound" }]);

    // Signing out clears what the terminals show and unbinds them
    vm.clearData();
    assert.deepEqual(out.fresh.slice(2), [ "<clear>" ]);
    const marker : unknown[] = [];
    vm.bindTerminal("", "marker", renderer(marker));
    (await join("marker"))({ ok: true,
        buffer: "" });
    await until(() => marker.length === 1, "the join of the marker");
    peer.emit("agent", "terminalWrite", "db-shell", "after sign-out");
    peer.emit("agent", "terminalWrite", "marker", "later");
    await until(() => marker.length === 2, "the marker");
    assert.deepEqual(out.fresh.slice(2), [ "<clear>" ]);
});

test("output sent right after the join answer reaches the terminal, even when both arrive in one batch", async (t) => {
    const { vm, peer } = await openPanel(t);
    peer.on("agent", (_endpoint : string, eventName : string, name : string, ack : (answer : unknown) => void) => {
        if (eventName === "terminalJoin") {
            // Polling delivers queued packets together, and they are dispatched in one task
            ack({ ok: true,
                buffer: "before\r\n" });
            peer.emit("agent", "terminalWrite", name, "right after\r\n");
        }
    });
    const out : unknown[] = [];

    vm.bindTerminal("", "deploy", renderer(out));
    await until(() => out.length === 2, "the buffer and the output after it");
    assert.deepEqual(out, [ "before\r\n", "right after\r\n" ]);
});

test("the workspace appears once identity, profile, agents and stacks of this connection have arrived", async (t) => {
    authAnswers.set("/api/auth/get-session", { status: 200,
        body: { session: { id: "s-1",
            userId: OWNER.id },
        user: OWNER } });
    t.after(() => authAnswers.clear());
    const { vm, peer, toasts } = await openPanel(t);

    peer.emit("authIdentity", { userID: OWNER.id,
        role: "operator" });
    await until(() => vm.username === "owner", "the profile");
    assert.equal(vm.appReady, false, "a profile alone is not a workspace");

    peer.emit("agentList", { ok: true,
        agentList: { "": { endpoint: "",
            name: "" },
        "10.0.0.2:5001": { endpoint: "10.0.0.2:5001",
            name: "Backup" } } });
    peer.emit("agent", "stackList", { ok: true,
        stackList: { web: stack("web"),
            db: stack("db") } });
    await until(() => vm.appReady, "the workspace");

    assert.deepEqual({ loggedIn: vm.loggedIn,
        role: vm.userRole,
        canManageStacks: vm.canManageStacks,
        isAdmin: vm.isAdmin,
        letter: vm.usernameFirstChar,
        agents: vm.agentCount,
        status: { ...vm.agentStatusList } }, { loggedIn: true,
        role: "operator",
        canManageStacks: true,
        isAdmin: false,
        letter: "O",
        agents: 2,
        status: { "": "online",
            "10.0.0.2:5001": "connecting" } });
    assert.ok(vm.stackListAt > 0);

    // An agent's list lands under its endpoint and leaves the local one alone
    peer.emit("agent", "stackList", { ok: true,
        endpoint: "10.0.0.2:5001",
        stackList: { web: stack("web", "10.0.0.2:5001") } });
    await until(() => "web_10.0.0.2:5001" in vm.completeStackList, "the agent's stacks");
    assert.deepEqual(Object.keys(vm.completeStackList).sort(), [ "db_", "web_", "web_10.0.0.2:5001" ]);

    // Statuses change known stacks only, and only with a status this build understands
    peer.emit("stackStatusList", { ok: true,
        stackStatusList: { web: 3,
            db: "running",
            ghost: 1 } });
    await until(() => vm.stackList.web?.status === 3, "the new status");
    assert.equal(vm.stackList.db?.status, 1);
    assert.equal("ghost" in vm.stackList, false);

    peer.emit("agentStatus", { endpoint: "10.0.0.2:5001",
        status: "offline",
        msg: "agentUnreachable" });
    await until(() => vm.agentStatusList["10.0.0.2:5001"] === "offline", "the agent status");
    assert.deepEqual(toasts, [ "agentUnreachable" ]);

    // Another account signed in on this browser: nothing of the first one stays
    peer.emit("authIdentity", { userID: "u-2",
        role: "viewer" });
    await until(() => vm.userID === "u-2", "the second identity");
    assert.deepEqual({ ...vm.stackList }, {});
    assert.deepEqual({ ...vm.agentList }, {});
    assert.equal(vm.appReady, false);

    peer.emit("needAuth");
    await until(() => vm.allowLoginDialog, "the sign-in dialog");
    assert.deepEqual({ loggedIn: vm.loggedIn,
        username: vm.username,
        userID: vm.userID,
        role: vm.userRole,
        anonymous: vm.sessionBootstrap.anonymous,
        bootstrapping: vm.sessionBootstrapping,
        link: vm.panelUpdate.ctx.link.kind }, { loggedIn: false,
        username: null,
        userID: null,
        role: "viewer",
        anonymous: true,
        bootstrapping: false,
        link: "need-auth" });
});

test("a failed profile request stops the opening with an error, unless the server says authentication is off", async (t) => {
    authAnswers.set("/api/auth/get-session", { status: 500,
        body: { message: "Internal Server Error" } });
    t.after(() => authAnswers.clear());
    const { vm, peer } = await openPanel(t);
    /**
     * The snapshot of a signed-in connection, in the order the server sends it
     * @param userID Who the socket belongs to
     */
    const signedIn = async (userID : string) => {
        peer.emit("authIdentity", { userID,
            role: "admin" });
        await until(() => vm.sessionBootstrap.confirmedUserID === userID && vm.sessionBootstrapError === "authConnectionFailed", "the failed profile");
        peer.emit("agent", "stackList", { ok: true,
            stackList: { web: stack("web") } });
        peer.emit("agentList", { ok: true,
            agentList: { "": { endpoint: "",
                name: "" } } });
        await until(() => vm.sessionBootstrap.agentsReady && vm.sessionBootstrap.stacksReady, "the inventory");
    };

    await signedIn("u-1");
    assert.equal(vm.appReady, false, "without a profile the workspace does not open");
    assert.equal(vm.sessionBootstrapError, "authConnectionFailed");

    // Authentication off behind a proxy that drops the cookie: the profile can never load
    peer.emit("needAuth");
    await until(() => vm.sessionBootstrap.anonymous && !vm.sessionBootstrap.agentsReady, "the signed-out page");
    await signedIn("u-2");
    assert.equal(vm.appReady, false);
    peer.emit("autoLogin");
    await until(() => vm.appReady, "the workspace");
    assert.deepEqual({ error: vm.sessionBootstrapError,
        authDisabled: vm.authDisabled,
        username: vm.username,
        loggedIn: vm.loggedIn }, { error: "",
        authDisabled: true,
        username: "usersRole_admin",
        loggedIn: true });
});

test("a server without an owner sends the page to the setup once", async (t) => {
    const { vm, peer, pushed } = await openPanel(t);
    peer.emit("setup");
    peer.emit("setup");
    peer.emit("info", { seq: 1 });
    await until(() => vm.info.seq === 1, "the marker");
    assert.deepEqual(pushed, [ "/setup" ]);
});

test("a new server version reloads the page, a reconnect does not, and neither happens while an update runs", async (t) => {
    const { vm, peer } = await openPanel(t);
    const reloads = page.location.reloads;
    /**
     * Let the server send its info, and wait until the page has taken it in
     * @param seq Marker of this packet
     * @param fields What the packet says
     */
    const info = async (seq : number, fields : Record<string, unknown> = {}) => {
        peer.emit("info", { seq,
            ...fields });
        await until(() => vm.info.seq === seq, `info ${seq}`);
        await nextTick();
    };

    // The first packet of every connection deliberately carries no version
    await info(1);
    await info(2, { version: FROM });
    await info(3);
    await info(4, { version: FROM });
    assert.equal(page.location.reloads, reloads);
    assert.equal(vm.isFrontendBackendVersionMatched, true);

    await info(5, { version: TO });
    assert.equal(page.location.reloads, reloads + 1);
    assert.equal(vm.isFrontendBackendVersionMatched, false);

    peer.emit("refresh");
    await info(6, { version: TO });
    assert.equal(page.location.reloads, reloads + 2);

    // With the panel update running, a reload could land on the browser's error page
    vm.panelUpdate = reducePanelUpdate(createPanelUpdateState(), { type: "BOOT",
        persisted: { v: 1,
            request: APPLY_ID,
            from: FROM,
            to: TO,
            phase: null,
            startedAt: Date.now(),
            stage: "running",
            outcome: null },
        now: Date.now() }).state;
    peer.emit("refresh");
    await info(7, { version: "0.0.15" });
    assert.equal(page.location.reloads, reloads + 2);
    vm.panelUpdate = createPanelUpdateState();

    // The news of a release reaches the panel update
    await info(8, { version: "0.0.15",
        latestVersion: "0.0.16",
        updateAvailable: true });
    assert.deepEqual([ vm.panelUpdate.ctx.latest, vm.panelUpdate.ctx.updateAvailable ], [ "0.0.16", true ]);
});

test("the panel update sends what the machine asks for, and the password only in the apply", async (t) => {
    authAnswers.set("/api/auth/get-session", { status: 200,
        body: { session: { id: "s-1",
            userId: OWNER.id },
        user: OWNER } });
    t.after(() => authAnswers.clear());
    let current = panelStatus(FROM);
    const received : unknown[][] = [];
    const { vm, peer } = await openPanel(t, () => current);
    peer.on(PANEL_UPDATE_EVENTS.preview, (requestId : string, version : string, ack : (answer : unknown) => void) => {
        received.push([ "preview", requestId, version ]);
        ack({ ok: true,
            status: panelStatus(FROM, panelOperation("preview", requestId)) });
        current = panelStatus(FROM, panelOperation("preview", requestId, "previewed"));
        peer.emit(PANEL_UPDATE_EVENTS.status, current);
    });
    peer.on(PANEL_UPDATE_EVENTS.apply, (...args : unknown[]) => {
        const ack = args.pop() as (answer : unknown) => void;
        received.push([ "apply", ...args ]);
        current = panelStatus(FROM, panelOperation("apply", args[0] as string));
        ack({ ok: true,
            status: current });
    });

    peer.emit("info", { version: FROM,
        latestVersion: TO,
        updateAvailable: true });
    peer.emit("authIdentity", { userID: OWNER.id,
        role: "admin" });
    await until(() => node(vm).sub === "available", "the release news");

    vm.panelUpdateCheck();
    await until(() => node(vm).sub === "ready", "the dry run");
    vm.panelUpdateConfirm();
    assert.equal(node(vm).dialog, true);

    vm.panelUpdateSubmit(PASSWORD);
    const submitted = page.sessionStorage.getItem(PANEL_UPDATE_STORAGE_KEY) ?? "";
    assert.equal(JSON.parse(submitted).stage, "submitting", "the operation is kept before the answer, for a reload");
    await until(() => node(vm).name === "running" && node(vm).ackPending === false, "the apply acknowledgement");

    const [ preview, apply ] = received;
    assert.equal(received.length, 2);
    assert.match(String(preview?.[1]), PANEL_UPDATE_REQUEST_PATTERN);
    assert.equal(preview?.[2], TO);
    assert.match(String(apply?.[1]), PANEL_UPDATE_REQUEST_PATTERN);
    assert.notEqual(apply?.[1], preview?.[1]);
    assert.deepEqual(apply?.slice(2), [ preview?.[1], TO, PASSWORD ]);
    for (const kept of [ submitted, page.sessionStorage.getItem(PANEL_UPDATE_STORAGE_KEY) ?? "", JSON.stringify(vm.panelUpdate) ]) {
        assert.equal(kept.includes(PASSWORD), false, "the password exists only in its emit");
    }
    assert.equal(vm.panelUpdateSuppressing, true);
    assert.equal(vm.panelUpdateView, "overlay");

    const leaving = () => ({ defaultPrevented: false,
        returnValue: undefined as unknown,
        preventDefault() {
            this.defaultPrevented = true;
        } });
    const whileAnswering = leaving();
    vm.onBeforeUnload(whileAnswering as unknown as BeforeUnloadEvent);
    assert.equal(whileAnswering.defaultPrevented, false);

    // The panel goes down to replace itself
    peer.disconnect(true);
    await until(() => vm.panelUpdate.ctx.link.kind === "offline", "the lost connection");
    const whileDown = leaving();
    vm.onBeforeUnload(whileDown as unknown as BeforeUnloadEvent);
    assert.equal(whileDown.defaultPrevented, true);
    assert.equal(whileDown.returnValue, "");

    const reloads = page.location.reloads;
    vm.onPreloadError(new Event("vite:preloadError", { cancelable: true }));
    assert.equal(page.location.reloads, reloads);

    // Losing the session holds the clock; the operation stays as it is
    vm.dispatchPanelUpdate({ type: "AUTH_LOST" });
    assert.equal(node(vm).name, "running");
});

test("offline, a panel update request is not queued for the next connection but ends as lost", async (t) => {
    const { vm, peer } = await openPanel(t);
    peer.disconnect(true);
    await until(() => !vm.socketIO.connected, "the lost connection");

    // An ordinary emit is queued by Socket.IO, which shows the check below can see a queued one
    vm.emitAgent("", "requestStackList");
    const results : unknown[] = [];
    vm.emitPanelUpdate(PANEL_UPDATE_EVENTS.status, [], (result) => results.push(result));
    assert.deepEqual(results, [], "the loss arrives like an answer, not inside the dispatch that asked");
    await until(() => results.length === 1, "the loss");
    assert.deepEqual(results, [{ kind: "lost" }]);

    const received : string[] = [];
    const next = new Promise<PeerSocket>((resolve) => io.once("connection", (socket : PeerSocket) => {
        socket.onAny((event : string) => received.push(event));
        resolve(socket);
    }));
    vm.getSocket().connect();
    const reconnected = await next;
    const marker = new Promise((resolve) => reconnected.once("marker", resolve));
    vm.getSocket().emit("marker");
    await marker;
    assert.deepEqual(received, [ "agent", "marker" ]);
});

test("signing in picks the method from the identifier and the code, and reports refusals in the interface's words", async (t) => {
    const { vm } = await openPanel(t);
    authAnswers.set("/api/auth/sign-in/email", { status: 401,
        body: { code: "INVALID_EMAIL_OR_PASSWORD",
            message: "Invalid email or password" } });
    authAnswers.set("/api/auth/sign-in/username", { status: 200,
        body: { twoFactorRedirect: true } });
    authAnswers.set("/api/auth/two-factor/verify-totp", { status: 401,
        body: { code: "INVALID_TWO_FACTOR_AUTHENTICATION",
            message: "Invalid code" } });
    authAnswers.set("/api/auth/two-factor/verify-backup-code", { status: 401,
        body: { code: "INVALID_BACKUP_CODE",
            message: "Invalid backup code" } });
    t.after(() => authAnswers.clear());
    authRequests.length = 0;

    assert.deepEqual(await vm.signIn("  owner@example.test ", "wrong"), { ok: false,
        msg: "authInvalidCredentials" });
    assert.deepEqual(await vm.signIn("owner", "right"), { ok: false,
        twoFactorRequired: true });
    assert.deepEqual(await vm.verifyTwoFactor(" 123456 "), { ok: false,
        twoFactorRequired: true,
        msg: "authInvalidCode" });
    assert.deepEqual(await vm.verifyTwoFactor("abcd-efgh"), { ok: false,
        twoFactorRequired: true,
        msg: "authInvalidBackupCode" });

    assert.deepEqual(authRequests, [
        { path: "/api/auth/sign-in/email",
            body: { email: "owner@example.test",
                password: "wrong" } },
        { path: "/api/auth/sign-in/username",
            body: { username: "owner",
                password: "right" } },
        { path: "/api/auth/two-factor/verify-totp",
            body: { code: "123456" } },
        { path: "/api/auth/two-factor/verify-backup-code",
            body: { code: "abcd-efgh" } },
    ]);
    assert.equal(vm.loggedIn, false);
});

test("a sign-in succeeds only once the reconnected socket delivered the whole workspace, and signing out clears it", async (t) => {
    const { vm } = await openPanel(t);
    authAnswers.set("/api/auth/sign-in/email", { status: 200,
        body: { redirect: false,
            token: null,
            user: OWNER } });
    authAnswers.set("/api/auth/get-session", { status: 200,
        body: { session: { id: "s-1",
            userId: OWNER.id },
        user: OWNER } });
    t.after(() => authAnswers.clear());

    // The reconnected socket carries the new cookie; the server then sends the snapshot in parts
    let sendStacks = () => {};
    io.once("connection", (peer : PeerSocket) => {
        peer.on(PANEL_UPDATE_EVENTS.status, (ack : (answer : unknown) => void) => ack({ ok: true,
            status: panelStatus(FROM, undefined, "no") }));
        peer.emit("authIdentity", { userID: OWNER.id,
            role: "admin" });
        peer.emit("agentList", { ok: true,
            agentList: { "": { endpoint: "",
                name: "" } } });
        sendStacks = () => peer.emit("agent", "stackList", { ok: true,
            stackList: { web: stack("web") } });
    });

    let settled = false;
    const signingIn = vm.signIn("owner@example.test", "right").then((result) => {
        settled = true;
        return result;
    });
    await until(() => vm.username === "owner" && vm.sessionBootstrap.agentsReady, "the profile and the agents");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, "without its stacks the workspace is not ready");

    sendStacks();
    assert.deepEqual(await signingIn, { ok: true });
    assert.equal(vm.appReady, true);
    assert.equal(vm.isAdmin, true);

    // A sign-out the server refused leaves the page signed in, as the cookie is
    authAnswers.set("/api/auth/sign-out", { status: 500,
        body: { message: "Database is locked" } });
    assert.deepEqual(await vm.logout(), { ok: false,
        msg: "Database is locked" });
    assert.equal(vm.loggedIn, true);

    authAnswers.set("/api/auth/sign-out", { status: 200,
        body: { success: true } });
    // The socket drops the session it was opened with: the server sees a new connection
    const before = vm.getSocket().id;
    const next = new Promise<PeerSocket>((resolve) => io.once("connection", resolve));
    assert.deepEqual(await vm.logout(), { ok: true });
    assert.notEqual((await next).id, before);
    assert.deepEqual({ loggedIn: vm.loggedIn,
        username: vm.username,
        userID: vm.userID,
        allowLoginDialog: vm.allowLoginDialog,
        stacks: { ...vm.stackList },
        agents: { ...vm.agentList } }, { loggedIn: false,
        username: null,
        userID: null,
        allowLoginDialog: true,
        stacks: {},
        agents: {} });
});
