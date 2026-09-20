import { strict as assert } from "node:assert";
import test from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { MainRouter } from "../../backend/routers/main-router";
import type { DockgeServer } from "../../backend/dockge-server";

/**
 * Serve the main router and answer one request
 * @param path What to ask for
 * @param indexHTML What the server would send as the application page
 * @returns Status, headers and body of the answer
 */
async function request(path : string, indexHTML = "<!doctype html><title>Dockge</title>") : Promise<{ status : number, body : string, cacheControl : string | null, contentType : string | null }> {
    const app = express();
    const server = { indexHTML } as unknown as DockgeServer;

    app.use(new MainRouter().create(app, server));

    const listener = app.listen(0);

    try {
        await new Promise((resolve) => listener.once("listening", resolve));
        const port = (listener.address() as AddressInfo).port;
        const response = await fetch(`http://127.0.0.1:${port}${path}`);

        return { status: response.status,
            body: await response.text(),
            cacheControl: response.headers.get("cache-control"),
            contentType: response.headers.get("content-type") };
    } finally {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
}

test("the application page is served without being cached", async () => {
    const page = await request("/");

    assert.equal(page.status, 200);
    assert.match(page.body, /Dockge/);

    // The page keeps its address while the assets it points at are renamed by every
    // build, so a cached page would send the browser after files that are gone
    assert.equal(page.cacheControl, "no-cache");
});

test("the panel asks search engines to stay away", async () => {
    const robots = await request("/robots.txt");

    assert.equal(robots.status, 200);
    assert.equal(robots.body, "User-agent: *\nDisallow: /");
    assert.match(robots.contentType ?? "", /text\/plain/);
});
