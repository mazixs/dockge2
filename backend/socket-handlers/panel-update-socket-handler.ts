import { SocketHandler } from "../socket-handler";
import type { DockgeServer } from "../dockge-server";
import { authorizeSocketEvent } from "../auth-access";
import { log } from "../log";
import { callbackError, callbackResult, checkLogin, doubleCheckPassword, ValidationError, type DockgeSocket } from "../util-server";
import { describePanelContainer } from "../own-container";
import { PANEL_CONTAINER_EVENT, type PanelContainerAck } from "../../common/types/panel-container";
import { PanelUpdateError, redactPanelUpdateStatus, requirePanelUpdateRequest, requirePanelVersion } from "../panel-update";
import { PANEL_UPDATE_EVENTS, type PanelUpdateAck, type PanelUpdateErrorCode, type PanelUpdateStatus } from "../../common/panel-update";

/**
 * Updating the panel from the browser. Direct events, never agent events: a panel updates
 * itself, not the panel it is connected to.
 *
 * None of them runs a command the browser composed. The browser names a version, which
 * has to match the version pattern, and request ids, which only become labels.
 */
export class PanelUpdateSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {
        socket.on(PANEL_UPDATE_EVENTS.status, async (callback : unknown) => {
            await answer(socket, PANEL_UPDATE_EVENTS.status, callback, "unreadable", () => server.panelUpdate.status());
        });

        socket.on(PANEL_UPDATE_EVENTS.preview, async (requestId : unknown, version : unknown, callback : unknown) => {
            await answer(socket, PANEL_UPDATE_EVENTS.preview, callback, "start-failed", () => server.panelUpdate.preview(requestId, version));
        });

        socket.on(PANEL_UPDATE_EVENTS.apply, async (requestId : unknown, previewRequestId : unknown, version : unknown, password : unknown, callback : unknown) => {
            await answer(socket, PANEL_UPDATE_EVENTS.apply, callback, "start-failed", async () => {
                // Checked before the password, so a malformed request never counts as an attempt
                requirePanelUpdateRequest(requestId);
                requirePanelUpdateRequest(previewRequestId);
                requirePanelVersion(version);
                if (typeof password !== "string") {
                    throw new PanelUpdateError("invalid");
                }
                await confirmPassword(socket, password);
                return server.panelUpdate.apply(requestId, previewRequestId, version);
            });
        });

        socket.on(PANEL_UPDATE_EVENTS.cancel, async (requestId : unknown, callback : unknown) => {
            await answer(socket, PANEL_UPDATE_EVENTS.cancel, callback, "unreadable", () => server.panelUpdate.cancel(requestId));
        });

        socket.on(PANEL_UPDATE_EVENTS.dismiss, async (requestId : unknown, callback : unknown) => {
            await answer(socket, PANEL_UPDATE_EVENTS.dismiss, callback, "unreadable", () => server.panelUpdate.dismiss(requestId));
        });

        // The container being updated, read only: its mounts show the host paths, so owners only
        socket.on(PANEL_CONTAINER_EVENT, async (callback : (ack : PanelContainerAck) => void) => {
            try {
                checkLogin(socket);
                await authorizeSocketEvent(socket, PANEL_CONTAINER_EVENT);
                callbackResult({ ok: true,
                    container: await describePanelContainer() }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });
    }
}

/**
 * Check the session and the role again, run the action and acknowledge with the status
 * as this user may see it
 * @param socket Socket of the browser
 * @param event Event being answered
 * @param callback Acknowledgement of the event
 * @param fallback Code for a failure the action did not describe itself
 * @param action The action; resolves to the full status after it
 */
async function answer(socket : DockgeSocket, event : string, callback : unknown, fallback : PanelUpdateErrorCode, action : () => Promise<PanelUpdateStatus>) : Promise<void> {
    if (typeof callback !== "function") {
        return;
    }
    let ack : PanelUpdateAck;
    try {
        await authorize(socket, event);
        const status = await action();
        ack = { ok: true,
            status: redactPanelUpdateStatus(status, socket.userRole === "admin") };
    } catch (error) {
        if (!(error instanceof PanelUpdateError)) {
            log.error("panel-update", `${event} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const failure = error instanceof PanelUpdateError ? error : new PanelUpdateError(fallback);
        ack = { ok: false,
            code: failure.code,
            msg: failure.message,
            msgi18n: true };
    }
    callback(ack);
}

/**
 * The transport already refused what the role does not allow; asked again here, because
 * a handler must not rely on being reached only through that check
 * @param socket Socket of the browser
 * @param event Event being answered
 * @throws {PanelUpdateError} forbidden, with the key of the authorization failure
 */
async function authorize(socket : DockgeSocket, event : string) : Promise<void> {
    try {
        checkLogin(socket);
        await authorizeSocketEvent(socket, event);
    } catch (error) {
        const key = error instanceof Error && error.message.startsWith("auth") ? error.message : "authSessionExpired";
        throw new PanelUpdateError("forbidden", key);
    }
}

/**
 * The owner's password, counted against the same attempt limit as every other confirmation
 * @param socket Socket of the browser
 * @param password Password the owner typed
 * @throws {PanelUpdateError} password
 */
async function confirmPassword(socket : DockgeSocket, password : string) : Promise<void> {
    try {
        await doubleCheckPassword(socket, password);
    } catch (error) {
        if (error instanceof ValidationError && error.message === "tooManyPasswordAttempts") {
            throw new PanelUpdateError("password", "tooManyPasswordAttempts");
        }
        if (error instanceof ValidationError) {
            throw new PanelUpdateError("password");
        }
        throw error;
    }
}
