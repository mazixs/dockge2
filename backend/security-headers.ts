import type { NextFunction, Request, Response } from "express";

/**
 * A Host header that may go into a policy. Anything else - a comma, a quote, a space - could
 * add a source of its own, so such a header gets no WebSocket source and `'self'` alone.
 */
const SAFE_HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/**
 * The Content Security Policy of the panel.
 *
 * Scripts come only from the panel itself: the build has no inline script and no `eval`, so
 * injected markup cannot run code. Styles keep `'unsafe-inline'`, because the terminal
 * (xterm) writes `<style>` elements and offers no nonce, and the page carries one inline
 * rule for `<noscript>`. The socket is named by host as well as by `'self'`, for browsers
 * that do not count `ws:` as the same origin.
 * @param host Host header of the request
 * @returns The policy
 */
export function contentSecurityPolicy(host : string | undefined) : string {
    const socket = host && SAFE_HOST.test(host) ? ` ws://${host} wss://${host}` : "";

    return [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self'${socket}`,
        "worker-src 'self' blob:",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join("; ");
}

/**
 * Set the headers every answer of the panel carries.
 *
 * The panel drives the Docker socket, so a page that frames it could trick an owner into
 * clicking through a deployment; framing is refused twice, by `X-Frame-Options` for old
 * browsers and `frame-ancestors` for current ones.
 * @param request Incoming request
 * @param response Outgoing response
 * @param next Next handler
 * @returns {void}
 */
export function securityHeaders(request : Request, response : Response, next : NextFunction) : void {
    response.setHeader("Content-Security-Policy", contentSecurityPolicy(request.headers.host));
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
}
