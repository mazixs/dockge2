import { strict as assert } from "node:assert";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { contentSecurityPolicy, securityHeaders } from "../../backend/security-headers";

test("scripts come only from the panel, and the page cannot be framed", () => {
    const policy = contentSecurityPolicy("dockge.example:5001");
    const directives = new Map(policy.split("; ").map((part) => {
        const [ name, ...sources ] = part.split(" ");
        return [ name, sources ];
    }));

    assert.deepEqual(directives.get("script-src"), [ "'self'" ]);
    assert.deepEqual(directives.get("frame-ancestors"), [ "'none'" ]);
    assert.deepEqual(directives.get("object-src"), [ "'none'" ]);
    assert.deepEqual(directives.get("connect-src"), [ "'self'", "ws://dockge.example:5001", "wss://dockge.example:5001" ]);
    assert.ok(!policy.includes("unsafe-eval"));
});

test("a host that could smuggle a source into the policy is left out of it", () => {
    for (const host of [ "evil.example; script-src *", "a.example 'unsafe-eval'", "x,y", "" ]) {
        const connect = contentSecurityPolicy(host).split("; ").find((part) => part.startsWith("connect-src"));
        assert.equal(connect, "connect-src 'self'", host);
    }
    assert.match(contentSecurityPolicy("[::1]:5001"), /connect-src 'self' ws:\/\/\[::1\]:5001 wss:\/\/\[::1\]:5001/);
});

test("every answer carries the headers, an error page included", async () => {
    const app = express();
    app.disable("x-powered-by");
    app.use(securityHeaders);
    app.get("/", (_request, response) => {
        response.send("ok");
    });
    const server = http.createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
        const { port } = server.address() as AddressInfo;
        for (const path of [ "/", "/missing" ]) {
            const response = await fetch(`http://127.0.0.1:${port}${path}`);
            assert.equal(response.headers.get("x-content-type-options"), "nosniff");
            assert.equal(response.headers.get("x-frame-options"), "DENY");
            assert.equal(response.headers.get("referrer-policy"), "same-origin");
            // Express answers a missing page with a stricter policy of its own, which is fine
            assert.match(response.headers.get("content-security-policy") ?? "", path === "/" ? /script-src 'self'/ : /^default-src 'none'/);
            assert.equal(response.headers.get("x-powered-by"), null);
        }
    } finally {
        server.close();
    }
});
