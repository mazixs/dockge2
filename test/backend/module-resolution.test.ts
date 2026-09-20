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
 * The packages a compiled file really loads.
 *
 * The answer comes from what the compiler emits, because an import whose names are only
 * ever used as types is dropped: it never reaches Node, and a package of types alone -
 * `type-fest` here - has nothing for Node to load in the first place.
 * @param emitted JavaScript the compiler produced for one file
 * @returns One entry per package specifier that survives compilation
 */
function packageImports(emitted : string) : string[] {
    const statement = /^\s*(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;
    const specifiers : string[] = [];

    for (const match of emitted.matchAll(statement)) {
        const specifier = match[1] ?? match[2] ?? "";

        if (specifier.startsWith(".")) {
            continue;
        }
        specifiers.push(specifier);
    }
    return specifiers;
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

test("every package the server loads is one Node can resolve on its own", () => {
    const files = [ ...sources("backend"), ...sources("common") ];
    const program = ts.createProgram(files, {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: false,
        types: [ "node" ],
    });
    const pairs : [ string, string ][] = [];

    for (const file of files) {
        let emitted = "";

        program.emit(program.getSourceFile(file), (_name, text) => {
            emitted += text;
        });

        for (const specifier of packageImports(emitted)) {
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
