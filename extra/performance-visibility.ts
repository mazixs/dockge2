import type { Page } from "@playwright/test";

const requests = new WeakMap<Page, string[]>();

/** Record only event names, never arguments or response payloads. */
export function watchRequests(page : Page) : void {
    const names : string[] = [];
    requests.set(page, names);
    page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
        const message = String(payload);
        if (!message.startsWith("42")) {
            return;
        }
        const data = JSON.parse(message.slice(message.indexOf("["))) as unknown[];
        if (data[0] === "agent" && typeof data[2] === "string" && names.length < 10_000) {
            names.push(data[2]);
        }
    }));
}

/** Inject visibility because Playwright keeps headless tabs focused; this is not OS minimization. */
async function visibility(page : Page, hidden : boolean) : Promise<void> {
    await page.evaluate(value => {
        Object.defineProperty(document, "hidden", { configurable: true,
            value });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
}

/** Verify real outgoing requests during simulated hide/resume of both polling views. */
export async function optionalVisibilityProbe(page : Page) {
    if (process.env.DOCKGE_PERF_VISIBILITY !== "1") {
        return null;
    }
    const names = requests.get(page)!;
    const sample = async (hiddenMs : number) => {
        await visibility(page, true);
        const start = names.length;
        await page.waitForTimeout(hiddenMs);
        const hidden = names.slice(start);
        await visibility(page, false);
        const resume = names.length;
        await page.waitForTimeout(1000);
        // The first refresh is synchronous with visibilitychange, so include it.
        return { hiddenMs,
            hidden,
            resumed: names.slice(start + hidden.length),
            resumedSynchronously: resume > start + hidden.length };
    };
    await page.waitForTimeout(2000);
    const overview = await sample(35_000);
    await page.locator("a[href=\"/stack/perf-000\"]").first().click();
    await page.locator(".inspector").waitFor();
    await page.waitForTimeout(8000);
    const inspector = await sample(12_000);
    await page.locator("a[href=\"/\"]").first().click();
    return { simulatedVisibility: true,
        overview,
        inspector };
}
