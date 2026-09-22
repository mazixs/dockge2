// Real HTTP account continuity across upgrade and restore. Only invented CI credentials.
import { readFileSync } from "node:fs";
const [ operation, data, port ] = process.argv.slice(2);
const origin = `http://localhost:${port}`;
const credentials = { email: "upgrade.owner@example.invalid", password: "Fixture-only-Upgrade-Password-42!" };
const body = operation === "bootstrap"
    ? { ...credentials, token: readFileSync(`${data}/bootstrap-token`, "utf8").trim(), username: "upgrade.owner", name: "Upgrade fixture" }
    : credentials;
const response = await fetch(`${origin}/api/auth/${operation === "bootstrap" ? "bootstrap" : "sign-in/email"}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
});
if (!response.ok || operation !== "bootstrap" && !response.headers.get("set-cookie")?.includes("session_token")) {
    throw new Error(`Account continuity failed (${operation}): HTTP ${response.status}`);
}

if (operation === "bootstrap") {
    const login = await fetch(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { "content-type": "application/json", origin },
        body: JSON.stringify(credentials), signal: AbortSignal.timeout(10000),
    });
    if (!login.ok || !login.headers.get("set-cookie")?.includes("session_token")) {
        throw new Error(`New owner cannot sign in: HTTP ${login.status}`);
    }
}
