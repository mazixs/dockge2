import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import test from "node:test";
import { getAuth, resolveSocketIdentity } from "../../backend/auth";
import { issueUser, OPERATOR_EVENTS, roleAllowsEvent, VIEWER_EVENTS } from "../../backend/auth-access";
import type { DockgeServer } from "../../backend/dockge-server";
import { PanelUpdateError } from "../../backend/panel-update";
import { PanelUpdateSocketHandler } from "../../backend/socket-handlers/panel-update-socket-handler";
import { AGENT_REQUEST_NAMES } from "../../common/agent-events";
import { PANEL_UPDATE_EVENTS, type PanelUpdateAck, type PanelUpdateStatus } from "../../common/panel-update";
import { setOwnContainerReader } from "../../backend/own-container";
import { PANEL_CONTAINER_EVENT } from "../../common/types/panel-container";
import { createTestAccount, makeAuthenticatedSocket, TEST_PASSWORD, withDatabase } from "../helpers/database";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const PREVIEW_REQUEST = "22222222-2222-4222-8222-222222222222";

const STATUS : PanelUpdateStatus = {
    schema: 1,
    panel: { version: "0.0.13",
        managed: "yes",
        installDir: "/srv/dockge2" },
    operation: {
        requestId: REQUEST,
        kind: "apply",
        from: "0.0.13",
        to: "0.0.14",
        startedAt: "2026-09-25T10:00:00.000Z",
        running: false,
        result: { outcome: "failed-before-cutover",
            error: "pull access denied" },
    },
};

/** The observer as the handler sees it, recording what reached it */
class StubPanelUpdate {
    readonly calls : unknown[][] = [];
    failure : Error | undefined;

    private answer(...args : unknown[]) : Promise<PanelUpdateStatus> {
        this.calls.push(args);
        return this.failure ? Promise.reject(this.failure) : Promise.resolve(STATUS);
    }

    status() {
        return this.answer("status");
    }

    preview(requestId : unknown, version : unknown) {
        return this.answer("preview", requestId, version);
    }

    apply(requestId : unknown, previewRequestId : unknown, version : unknown) {
        return this.answer("apply", requestId, previewRequestId, version);
    }

    cancel(requestId : unknown) {
        return this.answer("cancel", requestId);
    }

    dismiss(requestId : unknown) {
        return this.answer("dismiss", requestId);
    }
}

function handlerFor(cookie : string, userID : string, stub : StubPanelUpdate) : (event : string, ...args : unknown[]) => Promise<PanelUpdateAck> {
    const socket = Object.assign(new EventEmitter(), makeAuthenticatedSocket({ cookie,
        userID }));
    new PanelUpdateSocketHandler().create(socket, { panelUpdate: stub } as unknown as DockgeServer);
    return (event, ...args) => new Promise((resolve) => socket.emit(event, ...args, resolve));
}

async function signIn(username : string, role : "operator" | "viewer") : Promise<{ cookie : string; id : string }> {
    const user = await issueUser({ username,
        email: `${username}@example.com`,
        name: username,
        role,
        password: TEST_PASSWORD });
    const login = await getAuth().api.signInUsername({ body: { username,
        password: TEST_PASSWORD },
    asResponse: true });
    return { cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
        id: user.id };
}

test("no panel update event is an agent event, and only the owner changes anything", () => {
    const events = Object.values(PANEL_UPDATE_EVENTS);
    const agentNames : ReadonlySet<string> = new Set(AGENT_REQUEST_NAMES);
    for (const event of events) {
        assert.equal(OPERATOR_EVENTS.has(event), false, event);
        assert.equal(VIEWER_EVENTS.has(event), false, event);
        assert.equal(agentNames.has(event), false, event);
        for (const role of [ "admin", "operator", "viewer" ] as const) {
            assert.equal(roleAllowsEvent(role, event, true), false, `${role} ${event} through an agent`);
        }
        assert.equal(roleAllowsEvent("admin", event), true, event);
    }
    for (const role of [ "operator", "viewer" ] as const) {
        assert.equal(roleAllowsEvent(role, PANEL_UPDATE_EVENTS.status), true);
        for (const event of [ PANEL_UPDATE_EVENTS.preview, PANEL_UPDATE_EVENTS.apply, PANEL_UPDATE_EVENTS.cancel, PANEL_UPDATE_EVENTS.dismiss ]) {
            assert.equal(roleAllowsEvent(role, event), false, `${role} ${event}`);
        }
    }
});

test("other roles read a redacted status and are refused every change", async () => {
    await withDatabase(async () => {
        await createTestAccount();
        for (const role of [ "operator", "viewer" ] as const) {
            const stub = new StubPanelUpdate();
            const user = await signIn(`${role}7`, role);
            const call = handlerFor(user.cookie, user.id, stub);

            const status = await call(PANEL_UPDATE_EVENTS.status);
            assert.equal(status.ok, true);
            assert.ok(status.ok);
            assert.equal(status.status.panel.installDir, undefined);
            assert.equal(status.status.operation?.result?.error, undefined);
            assert.equal(status.status.operation?.result?.outcome, "failed-before-cutover");

            for (const [ event, args ] of [
                [ PANEL_UPDATE_EVENTS.preview, [ REQUEST, "0.0.14" ]],
                [ PANEL_UPDATE_EVENTS.apply, [ REQUEST, PREVIEW_REQUEST, "0.0.14", TEST_PASSWORD ]],
                [ PANEL_UPDATE_EVENTS.cancel, [ REQUEST ]],
                [ PANEL_UPDATE_EVENTS.dismiss, [ REQUEST ]],
            ] as const) {
                const refused = await call(event, ...args);
                assert.deepEqual(refused, { ok: false,
                    code: "forbidden",
                    msg: "authPermissionDenied",
                    msgi18n: true }, `${role} ${event}`);
            }
            assert.deepEqual(stub.calls, [[ "status" ]]);
        }
    });
});

test("the owner's update needs well formed arguments first and the password second", async () => {
    await withDatabase(async () => {
        const ownerCookie = await createTestAccount();
        const owner = await resolveSocketIdentity({ cookie: ownerCookie });
        const stub = new StubPanelUpdate();
        const call = handlerFor(ownerCookie, owner.userID ?? "", stub);

        const status = await call(PANEL_UPDATE_EVENTS.status);
        assert.ok(status.ok);
        assert.equal(status.status.panel.installDir, "/srv/dockge2");
        assert.equal(status.status.operation?.result?.error, "pull access denied");

        for (const args of [
            [ "nope", PREVIEW_REQUEST, "0.0.14", TEST_PASSWORD ],
            [ REQUEST, PREVIEW_REQUEST, "0.0.14; reboot", TEST_PASSWORD ],
            [ REQUEST, PREVIEW_REQUEST, "0.0.14", 1234 ],
        ]) {
            const invalid = await call(PANEL_UPDATE_EVENTS.apply, ...args);
            assert.deepEqual(invalid, { ok: false,
                code: "invalid",
                msg: "panelUpdateError.invalid",
                msgi18n: true });
        }

        const wrong = await call(PANEL_UPDATE_EVENTS.apply, REQUEST, PREVIEW_REQUEST, "0.0.14", "not-the-password");
        assert.deepEqual(wrong, { ok: false,
            code: "password",
            msg: "panelUpdateError.password",
            msgi18n: true });
        assert.deepEqual(stub.calls, [[ "status" ]], "nothing is started without the password");

        const applied = await call(PANEL_UPDATE_EVENTS.apply, REQUEST, PREVIEW_REQUEST, "0.0.14", TEST_PASSWORD);
        assert.equal(applied.ok, true);
        assert.deepEqual(stub.calls.at(-1), [ "apply", REQUEST, PREVIEW_REQUEST, "0.0.14" ]);
    });
});

test("the owner's refusals carry the observer's code, and unexpected failures a safe one", async () => {
    await withDatabase(async () => {
        const ownerCookie = await createTestAccount();
        const owner = await resolveSocketIdentity({ cookie: ownerCookie });
        const stub = new StubPanelUpdate();
        const call = handlerFor(ownerCookie, owner.userID ?? "", stub);

        stub.failure = new PanelUpdateError("busy");
        assert.deepEqual(await call(PANEL_UPDATE_EVENTS.preview, REQUEST, "0.0.14"), { ok: false,
            code: "busy",
            msg: "panelUpdateError.busy",
            msgi18n: true });

        stub.failure = new PanelUpdateError("too-late");
        assert.equal((await call(PANEL_UPDATE_EVENTS.cancel, REQUEST) as { code? : string }).code, "too-late");

        stub.failure = new Error("EACCES /var/run/docker.sock");
        assert.deepEqual(await call(PANEL_UPDATE_EVENTS.dismiss, REQUEST), { ok: false,
            code: "unreadable",
            msg: "panelUpdateError.unreadable",
            msgi18n: true });
        assert.equal((await call(PANEL_UPDATE_EVENTS.preview, REQUEST, "0.0.14") as { code? : string }).code, "start-failed");

        stub.failure = undefined;
        assert.equal((await call(PANEL_UPDATE_EVENTS.dismiss, REQUEST)).ok, true);
    });
});

test("a socket without a session is refused", async () => {
    const stub = new StubPanelUpdate();
    const socket = Object.assign(new EventEmitter(), makeAuthenticatedSocket({}));
    socket.userID = "";
    new PanelUpdateSocketHandler().create(socket, { panelUpdate: stub } as unknown as DockgeServer);
    const ack = await new Promise<PanelUpdateAck>((resolve) => socket.emit(PANEL_UPDATE_EVENTS.status, resolve));
    assert.deepEqual(ack, { ok: false,
        code: "forbidden",
        msg: "authSessionExpired",
        msgi18n: true });
    assert.deepEqual(stub.calls, []);
});

test("only the owner sees the panel's container, whose mounts name host paths", async (t) => {
    t.after(() => setOwnContainerReader());
    setOwnContainerReader({
        mountinfo: async () => `1 0 0:1 /var/lib/docker/containers/${"c".repeat(64)}/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n`,
        hostname: () => "dockge",
        inspect: async () => JSON.stringify([{ Id: "c".repeat(64),
            Name: "/dockge-dockge-1",
            Config: { Image: "ghcr.io/example/dockge2:0.0.14",
                Labels: {} },
            Mounts: [{ Type: "bind",
                Source: "/srv/secret-place",
                Destination: "/app/data",
                RW: true }] }]),
        imageDigests: async () => "[]",
    });
    assert.equal(OPERATOR_EVENTS.has(PANEL_CONTAINER_EVENT), false);
    assert.equal(roleAllowsEvent("admin", PANEL_CONTAINER_EVENT, true), false, "never through an agent");

    await withDatabase(async () => {
        const ownerCookie = await createTestAccount();
        const owner = await resolveSocketIdentity({ cookie: ownerCookie });
        const own = await handlerFor(ownerCookie, owner.userID ?? "", new StubPanelUpdate())(PANEL_CONTAINER_EVENT) as unknown as { ok : boolean; container? : { mounts : { source : string }[] } };
        assert.equal(own.ok, true);
        assert.equal(own.container?.mounts[0]?.source, "/srv/secret-place");

        for (const role of [ "operator", "viewer" ] as const) {
            const user = await signIn(`${role}8`, role);
            const refused = await handlerFor(user.cookie, user.id, new StubPanelUpdate())(PANEL_CONTAINER_EVENT);
            assert.deepEqual(refused, { ok: false,
                msg: "authPermissionDenied",
                msgi18n: true }, role);
        }
    });
});
