import { expect, test } from "@playwright/test";
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, E2E_STACK_NAME, FRONTEND_ORIGIN } from "./constants";

// This spec drives the login form itself, so it must start without a session
test.use({ storageState: {
    cookies: [],
    origins: [],
} });

const SESSION_URL = "http://localhost:5001/api/auth/get-session";

test.describe("signing in and out", () => {
    test("the login form opens a session and the session survives a reload", async ({ page, context }) => {
        await page.goto("/");

        // Without a session the UI shows the login form, not the stack list
        const email = page.locator("#floatingInput");
        await expect(page.locator(".form-container")).toBeVisible();
        await expect(email).toBeVisible();
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toHaveCount(0);

        await email.fill(E2E_ADMIN_EMAIL);
        await page.locator("#floatingPassword").fill(E2E_ADMIN_PASSWORD);
        await page.locator("form button[type=submit]").click();

        // The dashboard is only reachable with a session behind the socket handshake
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toBeVisible();

        const sessionCookie = (await context.cookies()).find((cookie) => cookie.name.includes("session_token"));
        expect(sessionCookie, "the sign-in has to set a session cookie").toBeTruthy();
        expect(sessionCookie?.httpOnly, "script must not be able to read the session").toBe(true);
        expect(sessionCookie?.sameSite).toBe("Lax");

        // The session lives in that cookie alone: no copy of it in browser storage,
        // and the page itself cannot see it either
        const stored = await page.evaluate(() => JSON.stringify({
            local: Object.entries(localStorage),
            session: Object.entries(sessionStorage),
            cookie: document.cookie,
        }));
        expect(stored).not.toContain(sessionCookie?.value ?? "no-cookie");
        expect(stored).not.toContain("session_token");

        await page.reload();
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toBeVisible();
    });

    test("wrong credentials keep the login form and say so", async ({ page }) => {
        await page.goto("/");

        await page.locator("#floatingInput").fill(E2E_ADMIN_EMAIL);
        await page.locator("#floatingPassword").fill("definitely-not-the-password");

        const refused = page.waitForResponse((response) => response.url().includes("/sign-in/email"));
        await page.locator("form button[type=submit]").click();
        expect((await refused).status()).toBe(401);

        await expect(page.locator(".alert-danger")).toBeVisible();
        await expect(page.locator(".alert-danger")).toContainText(/wrong|invalid|incorrect/i);
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toHaveCount(0);
    });

    test("logging out ends the session on the server as well", async ({ page, context }) => {
        await page.goto("/");
        await page.locator("#floatingInput").fill(E2E_ADMIN_EMAIL);
        await page.locator("#floatingPassword").fill(E2E_ADMIN_PASSWORD);
        await page.locator("form button[type=submit]").click();
        await expect(page.locator(".item", { hasText: E2E_STACK_NAME })).toBeVisible();

        const sessionCookie = (await context.cookies()).find((cookie) => cookie.name.includes("session_token"));
        expect(sessionCookie, "the sign-in has to set a session cookie").toBeTruthy();
        const cookieHeader = `${sessionCookie?.name}=${sessionCookie?.value}`;

        // Positive control: that same request has to work before the sign-out, otherwise
        // the check below would pass for the wrong reason
        const before = await page.request.get(SESSION_URL, {
            headers: {
                cookie: cookieHeader,
                origin: FRONTEND_ORIGIN,
            },
        });
        expect(before.status()).toBe(200);
        expect(await before.text()).toContain(E2E_ADMIN_EMAIL);

        await page.goto("/settings/security");
        await page.locator("#logout-btn").click();

        // Back at the login form, and the cookie of that session identifies nobody
        await expect(page.locator("#floatingPassword")).toBeVisible();

        const after = await page.request.get(SESSION_URL, {
            headers: {
                cookie: cookieHeader,
                origin: FRONTEND_ORIGIN,
            },
        });
        expect(after.status()).toBe(200);
        expect(await after.text()).not.toContain(E2E_ADMIN_EMAIL);
    });
});
