import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Budget of the first load, in kilobytes.
 *
 * What the browser fetches before it can draw anything is the entry script and every
 * module preloaded beside it. Everything else - the compose editor, the terminals, the
 * settings, the rarely opened screens - is fetched when it is opened, and is not
 * counted here.
 *
 * A budget is set slightly above what the interface costs today. Raising it hides a
 * regression, exactly as raising the warning limit of the bundler would: when a screen
 * genuinely belongs in the first load, move something else out of it instead.
 */
const BUDGET = {
    raw: 780,
    gzip: 250,
};

/** One file of the first load */
export interface BundleFile {
    name : string;
    raw : number;
    gzip : number;
}

/**
 * Read the assets the browser fetches before the first render
 * @param html Built `index.html`
 * @returns Asset paths as the page refers to them, entry script first
 */
export function readEntryAssets(html : string) : string[] {
    const assets : string[] = [];
    const script = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html);

    if (script?.[1]) {
        assets.push(script[1]);
    }

    for (const match of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)) {
        if (match[1]) {
            assets.push(match[1]);
        }
    }

    return assets;
}

/**
 * Measure the first load against its budget
 * @param files Assets of the first load
 * @returns One line per asset and the totals, and whether the budget holds
 */
export function checkBudget(files : readonly BundleFile[]) : { report : string[], ok : boolean } {
    const report : string[] = [];

    if (!files.length) {
        return { report: [ "No entry asset found in index.html, the build or this check is wrong" ],
            ok: false };
    }

    for (const file of files) {
        report.push(`     ${file.name}: ${(file.raw / 1024).toFixed(2)} kB, gzip ${(file.gzip / 1024).toFixed(2)} kB`);
    }

    const raw = files.reduce((total, file) => total + file.raw, 0) / 1024;
    const gzip = files.reduce((total, file) => total + file.gzip, 0) / 1024;
    const ok = raw <= BUDGET.raw && gzip <= BUDGET.gzip;

    report.push(`${ok ? "ok  " : "FAIL"} first load: ${raw.toFixed(2)} kB of ${BUDGET.raw} kB, gzip ${gzip.toFixed(2)} kB of ${BUDGET.gzip} kB (${files.length} files)`);
    return { report,
        ok };
}

/**
 * Measure one built asset
 * @param dist Directory of the build
 * @param asset Path as the page refers to it
 * @returns Its size as it is served, compressed and not
 */
async function measure(dist : string, asset : string) : Promise<BundleFile> {
    const name = asset.replace(/^\/+/, "");
    const file = path.join(dist, name);
    const raw = (await stat(file)).size;
    let gzip : number;

    try {
        // The build writes the compressed files the server actually sends
        gzip = (await stat(`${file}.gz`)).size;
    } catch {
        gzip = gzipSync(await readFile(file)).length;
    }

    return { name,
        raw,
        gzip };
}

/**
 * Check the first load of the built interface against its budget
 * @returns Nothing; the process ends with 1 when the budget is exceeded
 */
async function main() : Promise<void> {
    const dist = path.resolve(import.meta.dirname, "..", "frontend-dist");
    let html = "";

    try {
        html = await readFile(path.join(dist, "index.html"), "utf8");
    } catch {
        console.error(`No build at ${dist}. Run "npm run build:frontend" first.`);
        process.exit(1);
    }

    const assets = readEntryAssets(html);
    const files = await Promise.all(assets.map((asset) => measure(dist, asset)));
    const { report, ok } = checkBudget(files);

    console.log(report.join("\n"));

    if (!ok) {
        const others = (await readdir(path.join(dist, "assets")))
            .filter((file) => file.endsWith(".js") && !assets.some((asset) => asset.endsWith(file)));

        console.error(`The first load is over budget. Move a screen behind a lazy boundary instead of raising the budget. Loaded on demand today: ${others.length} chunks.`);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    await main();
}
