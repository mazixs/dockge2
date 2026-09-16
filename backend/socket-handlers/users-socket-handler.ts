import { SocketHandler } from "../socket-handler";
import type { DockgeServer } from "../dockge-server";
import { authorizeSocketEvent, changeUserAccess, issueUser, listUsers, resetUserPassword } from "../auth-access";
import { callbackError, callbackResult, type DockgeSocket } from "../util-server";

/** Account issuance is available to the owner only, never through public signup. */
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
        socket.on("usersCreate", async (data : unknown, callback : unknown) => {
            try {
                await authorizeSocketEvent(socket, "usersCreate");
                await issueUser(data);
                callbackResult({ ok: true }, callback);
            } catch (error) {
                const safeError = error instanceof Error && error.message.startsWith("auth") ? error : new Error("authAccountExists");
                callbackError(safeError, callback);
            }
        });
        for (const event of [ "usersUpdate", "usersResetPassword", "usersDelete" ]) {
            socket.on(event, async (data : { id? : unknown; role? : unknown; suspended? : unknown; password? : unknown } | null, callback : unknown) => {
                try {
                    await authorizeSocketEvent(socket, event);
                    if (!data || typeof data.id !== "string") {
                        throw new Error("authInvalidUserData");
                    }
                    if (event === "usersResetPassword") {
                        await resetUserPassword(data.id, data.password);
                    } else {
                        await changeUserAccess(data.id, { role: data.role,
                            suspended: data.suspended,
                            remove: event === "usersDelete" });
                    }
                    callbackResult({ ok: true }, callback);
                    server.disconnectAllSocketClients(data.id);
                } catch (error) {
                    callbackError(error, callback);
                }
            });
        }
    }
}
