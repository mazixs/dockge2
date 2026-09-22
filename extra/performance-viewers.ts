import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";

/** Run the optional scaling phase only against a synthetic Docker fixture. */
export async function optionalViewerScaling(page : Page, output : string) {
    if (process.env.DOCKGE_PERF_CONTAINERS && process.env.DOCKGE_PERF_VIEWERS === "5") {
        return viewerScaling(page, path.join(output, "docker-commands.jsonl"));
    }
    return null;
}

/** Count steady-state synthetic Docker commands without including page bootstrap. */
async function sample(page : Page, file : string) {
    const start = Date.now();
    await page.waitForTimeout(30_000);
    const counts : Record<string, number> = {};
    for (const line of (await readFile(file, "utf8")).trim().split("\n")) {
        const entry = JSON.parse(line) as { at : number; operation : string };
        if (entry.at >= start) {
            counts[entry.operation] = (counts[entry.operation] ?? 0) + 1;
        }
    }
    return { intervalMs: Date.now() - start,
        counts };
}

/** Compare one and five visible dashboard clients of the isolated synthetic backend. */
export async function viewerScaling(page : Page, file : string) {
    const one = await sample(page, file);
    const pages : Page[] = [];
    try {
        for (let index = 0; index < 4; index++) {
            const extra = await page.context().newPage();
            pages.push(extra);
            await extra.goto(new URL("/", page.url()).href);
            await extra.locator("tr.managed-container").first().waitFor({ timeout: 45_000 });
        }
        await page.waitForTimeout(5000);
        const five = await sample(page, file);
        return { one,
            five,
            remoteAgents: 0 };
    } finally {
        await Promise.all(pages.map(extra => extra.close()));
    }
}
