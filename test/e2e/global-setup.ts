import { request } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUTH_STATE_PATH, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, FRONTEND_ORIGIN } from "./constants";

/**
 * Sign in once and keep the session cookie for the whole run.
 *
 * The account is created by the seed and authentication stays on, so the suite exercises
 * the same code path a real installation uses. Only the auth spec starts without this
 * state, because it is the one that drives the login form itself.
 */
export default async function globalSetup() : Promise<void> {
    const context = await request.newContext({ baseURL: "http://localhost:5001" });

    const response = await context.post("/api/auth/sign-in/email", {
        headers: {
            "content-type": "application/json",
            // A credentialed cross origin request is only answered for a trusted origin
            origin: FRONTEND_ORIGIN,
        },
        data: {
            email: E2E_ADMIN_EMAIL,
            password: E2E_ADMIN_PASSWORD,
        },
    });

    if (!response.ok()) {
        throw new Error(`Could not sign in for the e2e run: ${response.status()} ${await response.text()}`);
    }

    await mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
    const state = await context.storageState();

    if (!state.cookies.some((cookie) => cookie.name.includes("session_token"))) {
        throw new Error("The sign-in did not return a session cookie");
    }

    await writeFile(AUTH_STATE_PATH, JSON.stringify(state));
    await context.dispose();
}
