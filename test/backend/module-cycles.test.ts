import { strict as assert } from "node:assert";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Every TypeScript file of a directory of the server
 * @param dir Directory relative to the project root
 * @returns Absolute paths, declaration files left out
 */
function sources(dir : string) : string[] {
    const found : string[] = [];

    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const relative = `${dir}/${entry.name}`;

        if (entry.isDirectory()) {
            found.push(...sources(relative));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
            found.push(path.join(root, relative));
        }
    }
    return found;
}

/**
 * Modules a compiled file really imports.
 *
 * The compiler drops an import whose names are only ever used as types, so the answer
 * has to come from what it emits rather than from the text that was written. Dynamic
 * imports are deliberately not counted: they run when they are called, which is how a
 * cycle is broken on purpose.
 * @param emitted JavaScript the compiler produced for one file
 * @param from Absolute path of the file that was compiled
 * @param known Every file of the graph
 * @returns Absolute paths this file loads when it is loaded
 */
function importsOf(emitted : string, from : string, known : Set<string>) : string[] {
    const statement = /^\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
    const targets : string[] = [];

    for (const match of emitted.matchAll(statement)) {
        const specifier = match[1] ?? match[2] ?? "";

        if (!specifier.startsWith(".")) {
            continue;
        }

        const base = path.resolve(path.dirname(from), specifier).replace(/\.js$/, "");

        for (const candidate of [ `${base}.ts`, path.join(base, "index.ts") ]) {
            if (known.has(candidate)) {
                targets.push(candidate);
                break;
            }
        }
    }
    return targets;
}

/**
 * Groups of modules that can reach each other
 * @param graph What every module imports
 * @returns Every strongly connected component of more than one module
 */
function cycles(graph : Map<string, string[]>) : string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack : string[] = [];
    const found : string[][] = [];
    let counter = 0;

    const visit = (node : string) : void => {
        index.set(node, counter);
        low.set(node, counter);
        counter += 1;
        stack.push(node);
        onStack.add(node);

        for (const next of graph.get(node) ?? []) {
            if (!index.has(next)) {
                visit(next);
                low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
            } else if (onStack.has(next)) {
                low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
            }
        }

        if (low.get(node) === index.get(node)) {
            const group : string[] = [];

            for (;;) {
                const member = stack.pop() as string;

                onStack.delete(member);
                group.push(member);
                if (member === node) {
                    break;
                }
            }
            if (group.length > 1 || (graph.get(node) ?? []).includes(node)) {
                found.push(group);
            }
        }
    };

    for (const node of graph.keys()) {
        if (!index.has(node)) {
            visit(node);
        }
    }
    return found;
}

test("no module of the server is loaded through itself", () => {
    const files = [ ...sources("backend"), ...sources("common") ];
    const known = new Set(files);
    const program = ts.createProgram(files, {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: false,
        types: [ "node" ],
    });
    const graph = new Map<string, string[]>();

    for (const file of files) {
        let emitted = "";

        program.emit(program.getSourceFile(file), (_name, text) => {
            emitted += text;
        });
        graph.set(file, importsOf(emitted, file, known));
    }

    // A cycle here is an order of loading that has to be guessed rather than read: one of
    // the two modules runs while the other is still empty, and which one that is depends
    // on who was imported first
    const named = cycles(graph).map((group) => group.map((file) => path.relative(root, file)).sort());

    assert.deepEqual(named, [], `Modules that import each other back:\n${named.map((group) => group.join(" <-> ")).join("\n")}`);
});
