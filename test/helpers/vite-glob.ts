import { readdirSync } from "node:fs";
import { register } from "node:module";

/**
 * Let a module that calls `import.meta.glob` load under tsx, as Vite builds it.
 *
 * Vite replaces the call at build time with an object of lazy loaders keyed by relative
 * path; tsx leaves it in place, where it does not exist. A load hook rewrites the call in
 * that one module to a global of the same length, so the source map and therefore the
 * coverage still point at the right columns, and the global builds the same object from
 * the directory. Only JSON globs of one directory are supported, which is all the
 * frontend uses.
 * @param moduleUrl The module whose glob is emulated
 * @returns The relative paths of the files loaded so far, in order
 */
export function emulateImportMetaGlob(moduleUrl : URL) : string[] {
    const loads : string[] = [];
    const hook = `export async function load(url, context, nextLoad) {
        const result = await nextLoad(url, context);
        if (url === ${JSON.stringify(moduleUrl.href)}) {
            return { ...result, source: String(result.source).replaceAll("import.meta.glob", "globalThis.$glob") };
        }
        return result;
    }`;
    register(`data:text/javascript,${encodeURIComponent(hook)}`);

    Object.assign(globalThis, {
        $glob(pattern : string) {
            const match = /^(.*\/)\*\.json$/.exec(pattern);
            if (!match?.[1]) {
                throw new Error(`Unsupported glob in the test emulation: ${pattern}`);
            }
            const prefix = match[1];
            const directory = new URL(prefix, moduleUrl);
            return Object.fromEntries(readdirSync(directory)
                .filter((name) => name.endsWith(".json"))
                .map((name) => [ prefix + name, () => {
                    loads.push(prefix + name);
                    return import(new URL(name, directory).href, { with: { type: "json" } });
                } ]));
        },
    });
    return loads;
}
