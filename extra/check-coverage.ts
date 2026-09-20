import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Coverage floors of the parts that must not quietly get worse.
 *
 * The overall percentage of the project says nothing about a single subsystem: a large
 * well covered area carries a small badly covered one, and the number stays green while
 * the code that decides who may write a file loses its tests. Each group here is checked
 * on its own, so that trade is not available.
 *
 * A floor is set below what the group has today, with room for an honest change, and is
 * raised when the group improves. Lowering one to make a run pass defeats the purpose of
 * having it.
 */
interface CoverageGroup {
    name : string;
    /** Why this group is measured separately */
    reason : string;
    /** Lowest share of lines, in percent, that this group may cover */
    floor : number;
    /** Whether a file of the project belongs to this group */
    holds : (file : string) => boolean;
}

const GROUPS : CoverageGroup[] = [
    {
        name: "Access and sessions",
        reason: "decides who may do anything at all",
        floor: 80,
        holds: (file) => /^backend\/(auth|auth-access|agent-auth|util-server)\.ts$/.test(file) || /^backend\/mcp-(access|policy|keys|delegation)\.ts$/.test(file),
    },
    {
        name: "Stack files",
        reason: "writes what the user would lose",
        floor: 80,
        holds: (file) => /^backend\/stack-(write|lock|config|source|git|secrets)\.ts$/.test(file) || /^common\/(stack-files|stack-source|compose-editor)\.ts$/.test(file),
    },
    {
        name: "State of containers",
        reason: "says what is running, and must fail closed",
        floor: 85,
        holds: (file) => /^common\/(compose-status|compose-progress|stability|availability|image-digest|util-common)\.ts$/.test(file) || /^backend\/(stability|observations|image-updates|stack-state)\.ts$/.test(file),
    },
    {
        name: "Agent transport",
        reason: "carries every operation of a remote panel",
        floor: 70,
        holds: (file) => /^backend\/(agent-manager|agent-socket-handler)\.ts$/.test(file) || /^backend\/socket-handlers\//.test(file) || /^backend\/agent-socket-handlers\//.test(file) || /^common\/agent-(socket|events)\.ts$/.test(file),
    },
];

/** One file as the report describes it */
interface FileCoverage {
    file : string;
    lines : number;
    covered : number;
}

/**
 * Read the line coverage of every file out of an LCOV report
 * @param report Contents of `lcov.info`
 * @param root Directory the paths are made relative to
 * @returns One entry per file of the report
 */
export function readLcov(report : string, root : string) : FileCoverage[] {
    const files : FileCoverage[] = [];
    let file = "";
    let lines = 0;
    let covered = 0;

    for (const line of report.split("\n")) {
        if (line.startsWith("SF:")) {
            file = path.relative(root, line.slice(3).trim()).split(path.sep).join("/");
            lines = 0;
            covered = 0;
        } else if (line.startsWith("DA:")) {
            const hits = Number(line.slice(3).split(",")[1]);

            lines += 1;
            covered += hits > 0 ? 1 : 0;
        } else if (line.startsWith("end_of_record") && file) {
            files.push({ file,
                lines,
                covered });
            file = "";
        }
    }
    return files;
}

/**
 * Measure every group against its floor
 * @param files Coverage of each file
 * @returns One line per group and whether all of them hold
 */
export function checkGroups(files : FileCoverage[]) : { report : string[], ok : boolean } {
    const report : string[] = [];
    let ok = true;

    for (const group of GROUPS) {
        const members = files.filter((entry) => group.holds(entry.file));
        const lines = members.reduce((total, entry) => total + entry.lines, 0);
        const covered = members.reduce((total, entry) => total + entry.covered, 0);

        if (!members.length || !lines) {
            report.push(`${group.name}: no measured file, the group or the coverage configuration is wrong`);
            ok = false;
            continue;
        }

        const percent = covered / lines * 100;
        const holds = percent >= group.floor;

        ok = ok && holds;
        report.push(`${holds ? "ok  " : "FAIL"} ${group.name}: ${percent.toFixed(2)}% of lines, floor ${group.floor}% (${members.length} files, ${group.reason})`);
    }
    return { report,
        ok };
}

/**
 * Check the floors against the report of the last run
 * @returns Nothing; the process ends with 1 when a group is below its floor
 */
async function main() : Promise<void> {
    const root = path.resolve(import.meta.dirname, "..");
    const reportPath = path.join(root, "coverage", "lcov.info");
    let report = "";

    try {
        report = await readFile(reportPath, "utf8");
    } catch {
        console.error(`No coverage report at ${reportPath}. Run "npm run test" first.`);
        process.exit(1);
    }

    const { report: lines, ok } = checkGroups(readLcov(report, root));

    console.log(lines.join("\n"));

    if (!ok) {
        console.error("A subsystem is below its coverage floor. Add the missing tests instead of lowering the floor.");
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
    await main();
}
