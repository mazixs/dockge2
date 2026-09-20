import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { checkGroups, readLcov } from "../../extra/check-coverage";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Build an LCOV record for one file
 * @param file Path of the file relative to the project root
 * @param hits How many times each line was executed
 * @returns The record as an LCOV report writes it
 */
function record(file : string, hits : number[]) : string {
    const lines = hits.map((count, index) => `DA:${index + 1},${count}`).join("\n");

    return `SF:${path.join(root, file)}\n${lines}\nend_of_record\n`;
}

test("the report is read as the share of lines that ran", () => {
    const files = readLcov(record("backend/auth.ts", [ 1, 0, 3, 0 ]) + record("common/util-common.ts", [ 2 ]), root);

    assert.deepEqual(files, [
        { file: "backend/auth.ts",
            lines: 4,
            covered: 2 },
        { file: "common/util-common.ts",
            lines: 1,
            covered: 1 },
    ]);
});

test("a subsystem below its floor fails, and the others are still reported", () => {
    // Every group is given one well covered file, so only the deliberate gap decides
    const good = [ 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 ];
    const report = record("backend/auth.ts", [ 1, 0, 0, 0, 0, 0, 0, 0, 0, 0 ])
        + record("backend/stack-write.ts", good)
        + record("common/compose-status.ts", good)
        + record("backend/agent-manager.ts", good);
    const { report: lines, ok } = checkGroups(readLcov(report, root));

    assert.equal(ok, false);
    assert.equal(lines.length, 4);
    assert.match(lines[0] ?? "", /^FAIL Access and sessions: 10\.00% of lines, floor 80%/);
    assert.ok(lines.slice(1).every((line) => line.startsWith("ok  ")), lines.join("\n"));
});

test("a group nothing measures is a failure, not a silent pass", () => {
    // A file dropped from the coverage configuration would otherwise leave its
    // subsystem unmeasured and green at the same time
    const { report, ok } = checkGroups(readLcov(record("backend/auth.ts", [ 1 ]), root));

    assert.equal(ok, false);
    assert.equal(report.filter((line) => line.includes("no measured file")).length, 3);
});
