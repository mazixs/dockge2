import { createAuthClient } from "better-auth/client";
import { twoFactorClient, usernameClient } from "better-auth/client/plugins";

/**
 * Where the auth endpoints live.
 * In development the UI runs on the Vite port while the backend is on 5001, so the
 * client needs the absolute origin; in production both are the same origin.
 */
function resolveBaseURL() : string {
    const env = process.env.NODE_ENV || "production";

    if (env === "development" || readDevFlag()) {
        return `${location.protocol}//${location.hostname}:5001`;
    }

    return `${location.protocol}//${location.host}`;
}

/**
 * Read the manual development switch.
 * Browsers can refuse access to storage entirely, and this module is imported while
 * the application starts, so a throw here would leave a blank page.
 * @returns Whether the development backend should be used
 */
function readDevFlag() : boolean {
    try {
        return localStorage.dev === "dev";
    } catch {
        return false;
    }
}

/**
 * Auth client of the UI.
 * The session lives in an httpOnly cookie, so no token is ever stored in the browser
 * and `credentials: include` is required for the cross origin development setup.
 */
export const authClient = createAuthClient({
    baseURL: resolveBaseURL(),
    basePath: "/api/auth",
    plugins: [ twoFactorClient(), usernameClient() ],
    fetchOptions: {
        credentials: "include",
    },
});

export type AuthSession = Awaited<ReturnType<typeof authClient.getSession>>;

/** Create the first owner with the one-use credential held on the server. */
export function bootstrapOwner(body : { token : string; username : string; email : string; password : string; name : string }) {
    return authClient.$fetch<{ ok : boolean }>("/bootstrap", { method: "POST",
        body });
}
