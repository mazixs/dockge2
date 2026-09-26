import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Every TypeScript file of a directory, declaration files left out
 * @param dir Directory relative to the project root
 * @returns Absolute paths
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
 * Import specifiers of every file of the server, as compiled.
 *
 * The answer comes from what the compiler emits, because an import whose names are only
 * ever used as types is dropped: it never reaches Node, and a package of types alone -
 * `type-fest` here - has nothing for Node to load in the first place. Dynamic imports are
 * deliberately not counted: they run when they are called, which is how a cycle is broken
 * on purpose.
 * @returns Specifiers per absolute file path
 */
function compileServer() : Map<string, string[]> {
    const files = [ ...sources("backend"), ...sources("common") ];
    const program = ts.createProgram(files, {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: false,
        types: [ "node" ],
    });
    const statement = /^\s*(?:import|export)\b[^;]*?from\s*["']([^"'\n]+)["']|^\s*import\s*["']([^"']+)["']/gm;
    const imports = new Map<string, string[]>();

    for (const file of files) {
        let emitted = "";

        program.emit(program.getSourceFile(file), (_name, text) => {
            emitted += text;
        });
        imports.set(file, [ ...emitted.matchAll(statement) ].map((match) => match[1] ?? match[2] ?? ""));
    }
    return imports;
}

let compiled : Map<string, string[]> | undefined;

/**
 * The server compiled once, shared by both checks
 * @returns Specifiers per absolute file path
 */
function serverImports() : Map<string, string[]> {
    compiled ??= compileServer();
    return compiled;
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

/**
 * What Node itself makes of these imports.
 *
 * The check runs in a separate process on purpose. These tests are executed through
 * `tsx`, which installs its own resolver and puts a missing extension back, so asking
 * here would only ever measure `tsx`. `NODE_OPTIONS` is cleared for the same reason.
 * @param pairs The file an import was written in, and the specifier
 * @returns One line per import Node cannot load
 */
function unresolvable(pairs : [ string, string ][]) : string[] {
    const script = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const missing = [];

for (const [ where, specifier ] of ${JSON.stringify(pairs)}) {
    let resolved = "";

    try {
        resolved = import.meta.resolve(specifier);
    } catch {
        missing.push(where + ": " + specifier + " resolves to nothing");
        continue;
    }

    // A built-in module is not a file, and a package that declares no "exports" map is
    // answered with a URL whether or not anything is there, so the file decides
    if (resolved.startsWith("node:")) {
        continue;
    }

    if (!resolved.startsWith("file:") || !existsSync(fileURLToPath(resolved))) {
        missing.push(where + ": " + specifier + " names " + resolved + ", which is not there");
    }
}

console.log(JSON.stringify(missing));
`;
    const clean = { ...process.env };

    // `tsx` is asked for on the command line here, but a NODE_OPTIONS inherited from
    // outside would install it in the child too, and the check would measure it again
    delete clean.NODE_OPTIONS;

    const run = spawnSync(process.execPath, [ "--input-type=module", "--eval", script ], {
        cwd: root,
        encoding: "utf8",
        env: clean,
    });

    assert.equal(run.status, 0, `Node could not answer:\n${run.stdout}${run.stderr}`);
    return JSON.parse(run.stdout) as string[];
}

test("no module of the server is loaded through itself", () => {
    const imports = serverImports();
    const graph = new Map<string, string[]>();

    for (const [ file, specifiers ] of imports) {
        const targets : string[] = [];

        for (const specifier of specifiers.filter((value) => value.startsWith("."))) {
            const base = path.resolve(path.dirname(file), specifier).replace(/\.js$/, "");
            const target = [ `${base}.ts`, path.join(base, "index.ts") ].find((candidate) => imports.has(candidate));

            if (target) {
                targets.push(target);
            }
        }
        graph.set(file, targets);
    }

    // A cycle here is an order of loading that has to be guessed rather than read: one of
    // the two modules runs while the other is still empty, and which one that is depends
    // on who was imported first
    const named = cycles(graph).map((group) => group.map((file) => path.relative(root, file)).sort());

    assert.deepEqual(named, [], `Modules that import each other back:\n${named.map((group) => group.join(" <-> ")).join("\n")}`);
});

test("every package the server loads is one Node can resolve on its own", () => {
    const pairs : [ string, string ][] = [];

    for (const [ file, specifiers ] of serverImports()) {
        for (const specifier of specifiers.filter((value) => !value.startsWith("."))) {
            pairs.push([ path.relative(root, file), specifier ]);
        }
    }

    assert.ok(pairs.length > 0, "nothing was read: the check would pass without looking");

    // A bundler and a TypeScript runner both put a missing extension back, so an import
    // written without one works wherever the sources are compiled first and fails exactly
    // where they are not: Playwright loading a backend module through its own loader
    const missing = unresolvable(pairs);

    assert.deepEqual(missing, [], `Imports Node cannot resolve:\n${missing.join("\n")}`);
});
