import { mkdtemp, mkdir, symlink, writeFile, rm, cp } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page } from "@playwright/test";
import { Database } from "../backend/database";
import { initAuth, resetAuth } from "../backend/auth";
import { issueUser } from "../backend/auth-access";
import { Settings } from "../backend/settings";
import { soak, sampleScope, stopScope } from "./performance-soak";
import { preparePage, waitForFixture, verifyPagination, clockCost, filterPaints, snapshotChurn } from "./performance-browser";
import { launchBackend, fixtureSize } from "./performance-runtime";
import { optionalViewerScaling } from "./performance-viewers";
import { optionalVisibilityProbe } from "./performance-visibility";
import type { DockgeServer } from "../backend/dockge-server";

/** Reserve an available loopback port without reusing a developer's running server. */
async function availablePort() : Promise<number> {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const address = listener.address();
    if (!address || typeof address === "string") {
        throw new Error("No loopback port available");
    }
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    return address.port;
}

/** Force collection only at checkpoints; this is retained heap, not browser RSS. */
async function measure(page : Page, label : string) {
    const cdp = await page.context().newCDPSession(page);
    try {
        await cdp.send("Performance.enable");
        await cdp.send("Runtime.discardConsoleEntries");
        await cdp.send("HeapProfiler.collectGarbage");
        const values = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [ name, value ]));
        return { label,
            heapMiB: (values.JSHeapUsedSize ?? 0) / 1048576,
            dom: await cdp.send("Memory.getDOMCounters"),
            elements: await page.locator("*").count(),
            editors: await page.locator(".cm-editor").count(),
            terminals: await page.locator(".xterm").count() };
    } finally {
        await cdp.detach();
    }
}

/** Wait for this isolated child, never silently reuse an existing application. */
async function waitForServer(child : ReturnType<typeof spawn>, origin : string) : Promise<void> {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) {
            throw new Error("Isolated backend exited; inspect the performance server log");
        }
        try {
            ready = (await fetch(origin)).ok;
        } catch { /* The server is still starting. */ }
        if (ready) {
            break;
        }
        await delay(200);
    }
    if (!ready) {
        throw new Error("Isolated backend did not become ready");
    }
}

/**
 * Production navigation probe, isolated from the user's database and stack files.
 * Docker discovery is read-only; synthetic stacks are never deployed. Existing
 * host containers can affect row counts, which are recorded rather than hidden.
 */
async function main() : Promise<void> {
    const root = process.cwd();
    const output = path.resolve(process.env.DOCKGE_PERF_OUTPUT ?? "output/performance/latest");
    const stackCount = fixtureSize(process.env.DOCKGE_PERF_STACKS, 50);
    const cycles = fixtureSize(process.env.DOCKGE_PERF_CYCLES, 100);
    const fixture = process.env.DOCKGE_PERF_CONTAINERS;
    const work = await mkdtemp(path.join(os.tmpdir(), "dockge-performance-"));
    await mkdir(output, { recursive: true });
    const dataDir = path.join(work, "data");
    const stacksDir = path.join(work, "stacks");
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const scope = process.env.DOCKGE_PERF_LIMITS === "1" ? `dockge-perf-${port}` : "";
    const password = "performance-fixture-only-2026";
    let browser : Browser | undefined;
    let child : ReturnType<typeof spawn> | undefined;
    const log = createWriteStream(path.join(output, "server.log"), { mode: 0o600 });
    try {
        await mkdir(dataDir);
        await mkdir(stacksDir);
        for (let i = 0; i < stackCount; i++) {
            const dir = path.join(stacksDir, `perf-${String(i).padStart(3, "0")}`);
            await mkdir(dir);
            await writeFile(path.join(dir, "compose.yaml"), "services:\n  app:\n    image: busybox:1.37\n    command: [sleep, '600']\n");
        }
        const server = { config: { dataDir,
            stacksDir,
            port },
        isSSL: () => undefined,
        getBaseURL: () => origin } as unknown as DockgeServer;
        await Database.init(server);
        await initAuth(server);
        await issueUser({ username: "performance.owner",
            name: "Performance fixture",
            email: "performance@example.com",
            password,
            role: "admin" }, true);
        Settings.stopCacheCleaner();
        resetAuth();
        await Database.close();
        for (const dir of [ "backend", "node_modules" ]) {
            await symlink(path.join(root, dir), path.join(work, dir));
        }
        await cp(path.join(root, "frontend-dist"), path.join(work, "frontend-dist"), { recursive: true });
        child = await launchBackend({ root,
            work,
            output,
            scope,
            stackCount,
            port,
            dataDir,
            stacksDir });
        child.stdout?.pipe(log, { end: false });
        child.stderr?.pipe(log, { end: false });
        await waitForServer(child, origin);
        browser = await chromium.launch({ headless: true });
        const page = await preparePage(browser);
        const pageErrors : string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        await page.goto(origin);
        await page.getByRole("textbox", { name: /Username or email|Логин или email/i }).fill("performance@example.com");
        await page.getByLabel(/^Password$|^Пароль$/).fill(password);
        await page.getByRole("button", { name: /^Log in$|^Login$|^Sign in$|^Войти$/i }).click();
        await page.locator("a[href=\"/stack/perf-000\"]").first().waitFor();
        await waitForFixture(page, fixture);
        const churn = await snapshotChurn(page);
        const clock = await clockCost(page);
        const interactions = await filterPaints(page);
        const pagination = await verifyPagination(page, fixture);
        const rounds = async (count : number, files : boolean) => {
            for (let i = 0; i < count; i++) {
                await page.locator("a[href=\"/stack/perf-000\"]").first().click();
                if (files) {
                    await page.locator("a[href=\"/stack/perf-000/files\"]").first().click();
                    await page.locator(".cm-editor").waitFor();
                }
                await delay(250);
                await page.locator("a[href=\"/\"]").first().click();
                await page.locator(".stability-dashboard").waitFor();
                await delay(250);
            }
        };
        const measurements = [ await measure(page, "overview-initial") ];
        await rounds(5, true);
        measurements.push(await measure(page, "overview-warmed"));
        for (let completed = 0; completed < cycles;) {
            const block = Math.min(20, cycles - completed);
            await rounds(block, true);
            completed += block;
            measurements.push(await measure(page, `after-${completed}-files-roundtrips`));
        }
        await delay(4000);
        measurements.push(await measure(page, "settled"));
        await rounds(10, false);
        measurements.push(await measure(page, "inspector-only-control"));
        const viewers = await optionalViewerScaling(page, output);
        const visibility = await optionalVisibilityProbe(page);
        const result = { date: new Date().toISOString(),
            node: process.version,
            browser: browser.version(),
            stackCount,
            cycles,
            syntheticContainers: fixture ? Number(fixture) : null,
            viewers,
            visibility,
            clock,
            snapshotChurn: churn,
            pagination,
            filterToSecondFrameMs: interactions,
            cpuThrottling: Number(process.env.DOCKGE_PERF_CPU_RATE ?? 1),
            serverLimits: scope ? await sampleScope(scope) : null,
            productionBuild: true,
            pageErrors,
            existingWorkloadsModified: false,
            measurements };
        await writeFile(path.join(output, "navigation.json"), JSON.stringify(result, null, 4) + "\n");
        console.log(JSON.stringify(result, null, 4));
        if (pageErrors.length) {
            throw new Error("Browser errors invalidate the performance run; inspect navigation.json");
        }
        if (scope) {
            await soak(scope, origin, 30 * 60_000, path.join(output, "soak.json"));
        }
    } finally {
        await browser?.close();
        if (scope && child && child.exitCode === null) {
            await stopScope(scope);
        }
        if (child && child.exitCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            const deadline = setTimeout(() => child?.kill("SIGKILL"), 10_000);
            await exited;
            clearTimeout(deadline);
        }
        log.end();
        Settings.stopCacheCleaner();
        resetAuth();
        await Database.close();
        await rm(work, { recursive: true,
            force: true });
    }
}

await main();
