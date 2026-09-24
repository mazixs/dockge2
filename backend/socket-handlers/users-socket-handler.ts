import { SocketHandler } from "../socket-handler";
import type { DockgeServer } from "../dockge-server";
import { authorizeSocketEvent, changeUserAccess, issueUser, listUsers, resetUserPassword } from "../auth-access";
import { callbackError, callbackResult, doubleCheckPassword, type DockgeSocket } from "../util-server";
import { runInBackground } from "../background";
import { Terminal } from "../terminal";

/**
 * Account issuance is available to the owner only, never through public signup.
 * Every change asks for the owner's password: an unattended signed-in browser must not be
 * enough to hand out accounts or lock the others out.
 */
export class UsersSocketHandler extends SocketHandler {
    create(socket : DockgeSocket, server : DockgeServer) {
        socket.on("usersList", async (callback : unknown) => {
            try {
                await authorizeSocketEvent(socket, "usersList");
                callbackResult({ ok: true,
                    users: await listUsers() }, callback);
            } catch (error) {
                callbackError(error, callback);
            }
        });
        socket.on("usersCreate", async (data : unknown, currentPassword : unknown, callback : unknown) => {
            try {
                await authorizeSocketEvent(socket, "usersCreate");
                await doubleCheckPassword(socket, currentPassword);
            } catch (error) {
                callbackError(error, callback);
                return;
            }
            try {
                await issueUser(data);
                callbackResult({ ok: true }, callback);
            } catch (error) {
                const safeError = error instanceof Error && error.message.startsWith("auth") ? error : new Error("authAccountExists");
                callbackError(safeError, callback);
            }
        });
        for (const event of [ "usersUpdate", "usersResetPassword", "usersDelete" ]) {
            socket.on(event, async (data : { id? : unknown; role? : unknown; suspended? : unknown; password? : unknown } | null, currentPassword : unknown, callback : unknown) => {
                try {
                    await authorizeSocketEvent(socket, event);
                    if (!data || typeof data.id !== "string") {
                        throw new Error("authInvalidUserData");
                    }
                    await doubleCheckPassword(socket, currentPassword);
                    if (event === "usersResetPassword") {
                        await resetUserPassword(data.id, data.password);
                    } else {
                        await changeUserAccess(data.id, { role: data.role,
                            suspended: data.suspended,
                            remove: event === "usersDelete" });
                    }
                    callbackResult({ ok: true }, callback);
                    server.disconnectAllSocketClients(data.id);
                    // Cutting the connections leaves the shells running; the account may
                    // have just lost the right to them
                    const userID = data.id;
                    runInBackground("terminals", () => Terminal.endOwnedBy(userID));
                } catch (error) {
                    callbackError(error, callback);
                }
            });
        }
    }
}
