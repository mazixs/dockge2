import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `allowJs` without `checkJs` compiles a single file component but never looks inside its
 * own methods, so a call to an agent event could name an event that does not exist, forget
 * its arguments or read a field the answer does not carry, and the check would still pass.
 * What turns checking on is `// @ts-check` at the top of the script block, one file at a
 * time. These tests hold both halves: that the components which write stacks still ask for
 * the check, and that the check really fails on a defect placed in a real component.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Where a wrong agent call has to be caught: the inspector, the editor and the writing screens */
const CHECKED_COMPONENTS = [
    "frontend/src/pages/StackInspector.vue",
    "frontend/src/pages/Compose.vue",
    "frontend/src/pages/NewStack.vue",
    "frontend/src/pages/StackGitChanges.vue",
    "frontend/src/components/CreateStackSheet.vue",
];

/** The component the defects are placed in: it reads the stack, writes it and calls agent events */
const MUTATED_COMPONENT = "frontend/src/pages/Compose.vue";

/** A copy of a real component with one defect in it */
interface Probe {
    /** Part of the file name, and what the failure is called in the report */
    name : string;
    /** Text taken from the component as it is written now */
    from : string;
    /** What replaces it, which is what the check has to refuse */
    to : string;
}

const PROBES : Probe[] = [
    { name: "MissingArgs",
        from: "emitAgentRequest(this.endpoint, \"dockerStats\", [])",
        to: "emitAgentRequest(this.endpoint, \"dockerStats\")" },
    { name: "WrongEvent",
        from: "emitAgentRequest(this.endpoint, \"dockerStats\", [])",
        to: "emitAgentRequest(this.endpoint, \"dockerStatsList\", [])" },
    { name: "IncompatibleAnswer",
        from: "this.dockerStats = res.dockerStats;",
        to: "this.serviceStatusList = res.dockerStats;" },
];

/** The untouched copy, which has to stay clean while the others fail */
const CONTROL = "Control";

const PROBE_DIR = "frontend/src/pages/";
const PROBE_PREFIX = "TypeCheckProbe";
const PROBE_CONFIG = "tsconfig.vue.probe.json";

/**
 * The file a probe of this name is written to.
 *
 * The copies live next to the original because the component reaches its imports by
 * relative path: from any other directory the copy would fail to compile for a reason that
 * has nothing to do with the defect under test.
 * @param name The name of the probe
 * @returns The path of the file, relative to the repository
 */
function probeFile(name : string) : string {
    return `${PROBE_DIR}${PROBE_PREFIX}${name}.vue`;
}

/** One error as the compiler reports it */
interface Reported {
    /** The file the error was reported in, empty when the compiler named none */
    file : string;
    /** The whole line, so a failure says what was actually wrong */
    line : string;
}

/**
 * The errors of a compiler run, without the indented explanations under them.
 * @param output Everything the compiler wrote
 * @returns One entry per reported error
 */
function reportedErrors(output : string) : Reported[] {
    const errors : Reported[] = [];

    for (const line of output.split("\n")) {
        if (/^\s/.test(line) || !/error TS\d+/.test(line)) {
            continue;
        }

        const location = /^(.+?)\(\d+,\d+\): error TS/.exec(line);
        errors.push({ file: location ? location[1]! : "",
            line: line.trim() });
    }

    return errors;
}

test("the components that read and write stacks ask for their own script to be checked", () => {
    for (const file of CHECKED_COMPONENTS) {
        const source = readFileSync(root + file, "utf8");
        const script = source.split("\n<script>\n")[1];

        assert.ok(script, `${file}: a plain <script> block is what // @ts-check applies to`);

        const firstLine = script.split("\n").find((line) => line.trim() !== "");

        assert.equal(firstLine?.trim(), "// @ts-check",
            `${file}: without // @ts-check its own methods are compiled but never checked`);
    }
});

test("a wrong agent call placed in a real component fails the check", { timeout: 300_000 }, async (t) => {
    const source = readFileSync(root + MUTATED_COMPONENT, "utf8");
    const written = [ root + PROBE_CONFIG ];

    t.after(() => {
        for (const file of written) {
            rmSync(file, { force: true });
        }
    });

    // The copies are only meaningful while they still match the component they came from:
    // a rename there has to fail loudly rather than quietly test nothing
    for (const probe of PROBES) {
        assert.ok(source.includes(probe.from),
            `${MUTATED_COMPONENT} no longer contains ${probe.from}: the probe would change nothing`);
    }

    for (const name of [ CONTROL, ...PROBES.map((probe) => probe.name) ]) {
        const probe = PROBES.find((candidate) => candidate.name === name);
        const file = root + probeFile(name);

        assert.equal(existsSync(file), false, `${probeFile(name)} is left over from an interrupted run`);
        writeFileSync(file, probe ? source.replace(probe.from, probe.to) : source);
        written.push(file);
    }

    // The same settings the project is checked with, over the copies only
    writeFileSync(root + PROBE_CONFIG, `${JSON.stringify({
        extends: "./tsconfig.vue.json",
        include: [
            `${PROBE_DIR}${PROBE_PREFIX}*.vue`,
            "frontend/**/*.d.ts",
            "common/**/*.d.ts",
        ],
    }, null, 4)}\n`);

    const run = spawnSync(process.execPath, [
        "node_modules/vue-tsc/bin/vue-tsc.js",
        "--noEmit",
        "-p",
        PROBE_CONFIG,
    ], { cwd: root,
        encoding: "utf8" });

    assert.equal(run.error, undefined, `the compiler did not run: ${run.error?.message}`);

    const output = `${run.stdout}${run.stderr}`;
    const errors = reportedErrors(output);
    const probeFiles = [ CONTROL, ...PROBES.map((probe) => probe.name) ].map(probeFile);

    // An error outside the copies means the run said nothing about the defects: that is how
    // a broken configuration looks, and it must not be read as the check having worked
    for (const error of errors) {
        assert.ok(probeFiles.includes(error.file),
            `the check failed for a reason of its own: ${error.line}`);
    }

    assert.notEqual(run.status, 0, `a defective component has to end the check with a non-zero code:\n${output}`);

    await t.test("the copy without a defect stays clean", () => {
        assert.deepEqual(errors.filter((error) => error.file === probeFile(CONTROL)), [],
            `the untouched component has to compile:\n${output}`);
    });

    for (const probe of PROBES) {
        await t.test(`${probe.name} is reported`, () => {
            const own = errors.filter((error) => error.file === probeFile(probe.name));

            assert.ok(own.length > 0, `${probe.to} was accepted:\n${output}`);
        });
    }
});
