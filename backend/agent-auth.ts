import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

interface AgentSession {
    cookie? : string;
    expiresAt : number;
    pending? : Promise<string>;
}

// Shared by all browser sockets. Opening tabs must not consume remote login attempts.
const sessions = new Map<string, AgentSession>();

/** Credential changes produce a different cache key without retaining plaintext here. */
function sessionKey(url : string, username : string, password : string) {
    const base = new URL(url);
    if (![ "http:", "https:" ].includes(base.protocol) || base.username || base.password) {
        throw new Error("authInvalidAgentUrl");
    }
    return createHash("sha256").update(JSON.stringify([ base.origin, username.toLowerCase(), password ])).digest("hex");
}

/** Invalidate only the rejected cookie, so concurrent tabs cannot discard a fresh login. */
export function invalidateAgentSession(url : string, username : string, password : string, rejectedCookie? : string) {
    const key = sessionKey(url, username, password);
    const current = sessions.get(key);
    if (!rejectedCookie || current?.cookie === rejectedCookie) {
        sessions.delete(key);
    }
}

/** Reuse a valid remote session and coalesce simultaneous logins for that account. */
export async function signInAgent(url : string, username : string, password : string) : Promise<string> {
    const key = sessionKey(url, username, password);
    const cached = sessions.get(key);
    if (cached?.pending) {
        return cached.pending;
    }
    if (cached?.cookie && cached.expiresAt > Date.now()) {
        return cached.cookie;
    }
    const session : AgentSession = { expiresAt: 0 };
    sessions.set(key, session);
    session.pending = requestAgentSession(url, username, password).then((result) => {
        session.cookie = result.cookie;
        session.expiresAt = result.expiresAt;
        delete session.pending;
        return result.cookie;
    }).catch((error) => {
        if (sessions.get(key) === session) {
            sessions.delete(key);
        }
        throw error;
    });
    return session.pending;
}

/** Establish a remote better-auth session without exposing credentials in errors. */
async function requestAgentSession(url : string, username : string, password : string) {
    const base = new URL(url);
    const emailLogin = username.includes("@");
    let response : Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        response = await fetch(new URL(`/api/auth/sign-in/${emailLogin ? "email" : "username"}`, base), {
            method: "POST",
            headers: { "content-type": "application/json",
                origin: base.origin },
            body: JSON.stringify(emailLogin ? { email: username,
                password } : { username,
                password }),
            redirect: "error",
            signal: AbortSignal.timeout(10000),
        });
        if (response.status !== 429 || attempt === 2) {
            break;
        }
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter === null ? 60 : Number(retryAfter);
        const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? "") - Date.now();
        await response.body?.cancel();
        // Do not retry earlier than a longer server-requested cooldown.
        if (wait > 60000) {
            throw new Error("authAgentRateLimited");
        }
        // A bounded retry honors the remote limiter; all waiting tabs share it.
        await delay(Math.max(100, Number.isFinite(wait) ? wait : 60000));
    }
    if (!response || response.status === 429) {
        throw new Error("authAgentRateLimited");
    }
    const body = await response.json().catch(() => null) as { twoFactorRedirect? : boolean } | null;
    if (body?.twoFactorRedirect) {
        throw new Error("authAgentTwoFactor");
    }
    if (!response.ok) {
        throw new Error("authAgentLoginFailed");
    }
    const cookies = response.headers.getSetCookie().filter((cookie) => /^(?:__Secure-)?better-auth\.session_token=/.test(cookie));
    if (!cookies.length) {
        throw new Error("authAgentLoginFailed");
    }
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookies[0] ?? "")?.[1]);
    return {
        cookie: cookies.map((cookie) => cookie.split(";")[0]).join("; "),
        // Unknown lifetimes get a short cache; never assume an unbounded session.
        expiresAt: Date.now() + (Number.isFinite(maxAge) ? Math.max(0, maxAge - 30) : 300) * 1000,
    };
}
