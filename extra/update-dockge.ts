import { spawn } from "../backend/child-process";

export interface UpdateCommand {
    command : string;
    args : readonly string[];
}

export interface UpdateOptions {
    dryRun : boolean;
    forceRecreate : boolean;
    /** Branch to fast-forward to, must be a plain ref name */
    branch : string;
}

/** Default branch of this fork */
export const DEFAULT_BRANCH = "main";

/** A ref name without options, paths outside the repo or shell metacharacters */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Build the fixed list of commands used to update a Dockge deployment.
 * Every command is an argument array, so nothing is passed through a shell.
 * @param forceRecreate Recreate the container even when the image did not change
 * @param branch Branch to fast-forward to
 * @returns Commands in execution order
 */
export function buildUpdateCommands(forceRecreate : boolean, branch : string = DEFAULT_BRANCH) : readonly UpdateCommand[] {
    if (!SAFE_BRANCH.test(branch)) {
        throw new Error(`Invalid branch name: ${branch}`);
    }

    return [
        { command: "git",
            args: [ "pull", "--ff-only", "origin", branch ] },
        { command: "docker",
            args: [ "compose", "config", "--quiet" ] },
        {
            command: "docker",
            args: [
                "compose", "up", "-d", "--pull", "always",
                ...(forceRecreate ? [ "--force-recreate" ] : []),
                "--wait", "--wait-timeout", "60",
            ],
        },
    ];
}

/**
 * Parse the accepted command line arguments
 * @param argv Arguments without the node executable and script name
 * @returns Parsed options
 * @throws {Error} If an unknown argument is passed
 */
export function parseUpdateArgs(argv : readonly string[]) : UpdateOptions {
    const options : UpdateOptions = {
        dryRun: false,
        forceRecreate: false,
        branch: DEFAULT_BRANCH,
    };

    for (const arg of argv) {
        if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--force-recreate") {
            options.forceRecreate = true;
        } else if (arg.startsWith("--branch=")) {
            const branch = arg.slice("--branch=".length);

            if (!SAFE_BRANCH.test(branch)) {
                throw new Error(`Invalid branch name: ${branch}`);
            }

            options.branch = branch;
        } else {
            throw new Error(`Unknown argument: ${arg}. Only --dry-run, --force-recreate and --branch=<name> are supported.`);
        }
    }

    return options;
}

/**
 * Format a command for printing, without quoting tricks that could hide arguments
 * @param command Command to format
 * @returns Printable command line
 */
export function formatCommand(command : UpdateCommand) : string {
    return [ command.command, ...command.args ].join(" ");
}

/**
 * Fail when the working copy has local changes, so `git pull --ff-only` cannot be blocked
 * or silently mixed with uncommitted work
 * @throws {Error} If the working copy is not clean
 */
async function assertCleanWorkingCopy() : Promise<void> {
    const res = await spawn("git", [ "status", "--porcelain" ], {
        encoding: "utf-8",
        maxBuffer: 256 * 1024,
        timeoutMs: 30_000,
    });

    const output = res.stdout?.toString().trim() ?? "";

    if (output !== "") {
        throw new Error("The working copy has local changes. Commit or stash them before updating.");
    }
}

/**
 * Run the update, or only print it in dry-run mode
 * @param options Parsed options
 */
export async function runUpdate(options : UpdateOptions) : Promise<void> {
    const commands = buildUpdateCommands(options.forceRecreate, options.branch);

    if (options.dryRun) {
        console.log("Dry run, no command is executed:");
        for (const command of commands) {
            console.log("  " + formatCommand(command));
        }
        return;
    }

    await assertCleanWorkingCopy();

    for (const command of commands) {
        console.log("> " + formatCommand(command));
        const res = await spawn(command.command, command.args, {
            encoding: "utf-8",
            maxBuffer: 4 * 1024 * 1024,
            timeoutMs: 15 * 60 * 1000,
        });
        const stdout = res.stdout?.toString().trim();
        if (stdout) {
            console.log(stdout);
        }
    }

    console.log("Update finished. `--wait` returned, so the container passed its health check.");
}

// Only run when executed directly, so the module stays testable
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    try {
        await runUpdate(parseUpdateArgs(process.argv.slice(2)));
    } catch (e) {
        if (e instanceof Error) {
            console.error(e.message);
        }
        process.exit(1);
    }
}
