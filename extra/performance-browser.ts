import type { Browser, Page } from "@playwright/test";
import { fixtureSize } from "./performance-runtime";
import { watchRequests } from "./performance-visibility";

/** Create a shareable browser context and optionally emulate a slower CPU. */
export async function preparePage(browser : Browser) : Promise<Page> {
    const context = await browser.newContext({ locale: "en-US" });
    const page = await context.newPage();
    watchRequests(page);
    if (process.env.DOCKGE_PERF_CPU_RATE) {
        const rate = fixtureSize(process.env.DOCKGE_PERF_CPU_RATE, 1);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    }
    await instrumentPage(page);
    return page;
}

/** The first collector round may occur after login and the next dashboard refresh. */
export async function waitForFixture(page : Page, count : string | undefined) : Promise<void> {
    if (count) {
        await page.waitForFunction(size => document.querySelectorAll("tr.managed-container").length === Math.min(50, size), Number(count), { timeout: 45_000 });
    }
}

/** Exercise real keyboard pagination and verify the previous page restores its first row. */
export async function verifyPagination(page : Page, count : string | undefined) {
    if (!count || Number(count) <= 50) {
        return null;
    }
    const first = page.locator("tr.managed-container").first();
    const before = await first.innerText();
    const previousText = await first.textContent();
    const next = page.locator(".container-pages button").last();
    await next.focus();
    await next.press("Enter");
    await page.waitForFunction(text => document.querySelector("tr.managed-container")?.textContent !== text, previousText);
    const after = await first.innerText();
    if (after === before || await page.locator("tr.managed-container").count() > 50) {
        throw new Error("Pagination did not advance within the row budget");
    }
    await page.locator(".container-pages button").first().click();
    if (await first.innerText() !== before) {
        throw new Error("Pagination did not restore the previous page");
    }
    return { keyboardNext: true,
        previousRestored: true,
        maximumRows: 50 };
}

interface Counters {
    formats : number;
    longTasks : number[];
}

/** Count formatting and long tasks in the page without retaining DOM nodes. */
export async function instrumentPage(page : Page) : Promise<void> {
    await page.addInitScript(() => {
        const counters : Counters = { formats: 0,
            longTasks: [] };
        Object.assign(window, { dockgePerformance: counters });
        const format = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format")!;
        Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
            configurable: true,
            get() {
                const original = format.get!.call(this) as (value : number) => string;
                return (value : number) => {
                    counters.formats++;
                    return original(value);
                };
            },
        });
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                if (counters.longTasks.length < 1000) {
                    counters.longTasks.push(entry.duration);
                }
            }
        }).observe({ type: "longtask",
            buffered: true });
    });
}

/** Probe a pure age-clock interval before the next 30 second snapshot refresh. */
export async function clockCost(page : Page) {
    const counters = () => page.evaluate(() => {
        const state = (window as unknown as { dockgePerformance : Counters }).dockgePerformance;
        return { formats: state.formats,
            longTasks: state.longTasks.slice() };
    });
    const before = await counters();
    await page.waitForTimeout(6000);
    const after = await counters();
    return { intervalMs: 6000,
        formatCalls: after.formats - before.formats,
        longTasksMs: after.longTasks.slice(before.longTasks.length) };
}

/** Scripted filter interaction to the second animation frame; this is not field INP. */
export async function filterPaints(page : Page) : Promise<number[]> {
    const samples : number[] = [];
    for (let index = 0; index < 20; index++) {
        samples.push(await page.evaluate(async (i) => {
            const link = document.querySelector<HTMLAnchorElement>(`.counts a:nth-child(${i % 2 + 1})`)!;
            const start = performance.now();
            link.click();
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            return performance.now() - start;
        }, index));
    }
    return samples.sort((a, b) => a - b);
}

interface Churn {
    region : string;
    rows : number;
    addedNodes : number;
    removedNodes : number;
    attributes : number;
    text : number;
}

/**
 * Count what the stack list and the overview rebuild while fresh snapshots of an unchanged
 * host arrive: 32 seconds cover three stack list rounds and one overview reload. A keyed
 * render touches the few cells whose age moved; rows added and removed mean it rebuilt them.
 */
export async function snapshotChurn(page : Page) : Promise<Churn[]> {
    await page.evaluate(() => {
        const regions : Record<string, string> = { stackList: ".list-box",
            overview: ".stability-dashboard" };
        const counts : Record<string, { addedNodes : number, removedNodes : number, attributes : number, text : number }> = {};
        for (const [ name, selector ] of Object.entries(regions)) {
            const element = document.querySelector(selector);
            if (!element) {
                continue;
            }
            const count = { addedNodes: 0,
                removedNodes: 0,
                attributes: 0,
                text: 0 };
            counts[name] = count;
            new MutationObserver(records => {
                for (const record of records) {
                    count.addedNodes += record.addedNodes.length;
                    count.removedNodes += record.removedNodes.length;
                    count.attributes += record.type === "attributes" ? 1 : 0;
                    count.text += record.type === "characterData" ? 1 : 0;
                }
            }).observe(element, { subtree: true,
                childList: true,
                attributes: true,
                characterData: true });
        }
        Object.assign(window, { dockgeChurn: counts });
    });
    await page.waitForTimeout(32_000);
    return page.evaluate(() => {
        const counts = (window as unknown as { dockgeChurn : Record<string, Omit<Churn, "region" | "rows">> }).dockgeChurn;
        const rows : Record<string, number> = { stackList: document.querySelectorAll(".list-box .item").length,
            overview: document.querySelectorAll(".stability-dashboard tbody tr").length };
        return Object.entries(counts).map(([ region, count ]) => ({ region,
            rows: rows[region] ?? 0,
            ...count }));
    });
}
