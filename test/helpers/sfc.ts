import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/**
 * Evaluate the options object of a single file component, with its imports replaced.
 *
 * The methods under test are the component's own, run against a context the test
 * controls; only what the options mention while they are built has to be passed in.
 * A `<script lang="ts">` block is transpiled first, so a component keeps its tests when
 * it moves to TypeScript, and `defineComponent` is the identity it is at run time.
 * @param file Location of the component
 * @param globals Identifiers the script refers to in place of its imports
 * @returns The options the component exports
 */
export function componentOptions<T = Record<string, unknown>>(file : URL, globals : Record<string, unknown> = {}) : T {
    const source = readFileSync(file, "utf8");
    const block = /<script( lang="ts")?>\n([\s\S]*?)<\/script>/.exec(source);

    if (!block?.[2]) {
        throw new Error(`${file.pathname}: no script block`);
    }

    const script = block[1] ? ts.transpileModule(block[2], {
        compilerOptions: { target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext },
    }).outputText : block[2];

    const context : Record<string, unknown> = { result: null,
        defineComponent: <O>(options : O) => options,
        ...globals };

    runInNewContext(script
        .replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];?$/gm, "")
        .replace(/^import\s+["'][^"']+["'];?$/gm, "")
        .replace("export default", "result ="), context);

    return context.result as T;
}
