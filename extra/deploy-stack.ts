import path from "path";
import { spawn } from "../backend/child-process";
import { classifyStackFile } from "../common/stack-files";

export interface DeployCommand {
    command : string;
    args : readonly string[];
}

export interface DeployOptions {
    /** Stack directory name inside the stacks directory */
    stack : string;
    /** Directory holding the stacks */
    stacksDir : string;
    /** Compose file to use, always passed explicitly */
    composeFile : string;
    /** Ordered env files for interpolation */
    envFiles : string[];
    /** Branch to fast-forward to */
    branch : string;
    dryRun : boolean;
    forceRecreate : boolean;
    /** Skip the git step for a stack that is not a checkout */
    skipGit : boolean;
}

/** Same rule the server uses for stack directory names */
const SAFE_STACK_NAME = /^[a-z0-9_-]+$/;

/** A plain git ref name, so no option, path or shell syntax can be smuggled in */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export const DEFAULT_BRANCH = "main";
const DEFAULT_COMPOSE_FILE = "compose.yaml";

/**
 * Build the commands that update one stack from Git and redeploy it.
 * Compose always receives the selected file and env files explicitly, and the
 * configuration is validated before anything is started.
 * @param options Deployment options
 * @returns Commands in execution order
 */
export function buildDeployCommands(options : DeployOptions) : readonly DeployCommand[] {
    if (!SAFE_STACK_NAME.test(options.stack)) {
        throw new Error(`Invalid stack name: ${options.stack}`);
    }

    if (!SAFE_BRANCH.test(options.branch)) {
        throw new Error(`Invalid branch name: ${options.branch}`);
    }

    if (classifyStackFile(options.composeFile) !== "compose") {
        throw new Error(`Invalid compose file: ${options.composeFile}`);
    }

    for (const envFile of options.envFiles) {
        if (classifyStackFile(envFile) !== "env") {
            throw new Error(`Invalid env file: ${envFile}`);
        }
    }

    const stackDir = path.join(options.stacksDir, options.stack);
    const commands : DeployCommand[] = [];

    if (!options.skipGit) {
        // A dirty tree means somebody edited files on the server, stop instead of overwriting
        commands.push({ command: "git",
            args: [ "-C", stackDir, "status", "--porcelain" ] });
        commands.push({ command: "git",
            args: [ "-C", stackDir, "pull", "--ff-only", "origin", options.branch ] });
    }

    const composeArgs = [ "compose" ];

    for (const envFile of options.envFiles) {
        composeArgs.push("--env-file", "./" + envFile);
    }

    composeArgs.push("-f", options.composeFile);

    commands.push({ command: "docker",
        args: [ ...composeArgs, "config", "--quiet" ] });

    commands.push({
        command: "docker",
        args: [
            ...composeArgs, "up", "-d", "--pull", "always",
            ...(options.forceRecreate ? [ "--force-recreate" ] : []),
            "--wait", "--wait-timeout", "60",
        ],
    });

    return commands;
}

/**
 * Parse the accepted command line arguments
 * @param argv Arguments without the node executable and script name
 * @returns Parsed options
 * @throws {Error} If an argument is unknown or unsafe
 */
export function parseDeployArgs(argv : readonly string[]) : DeployOptions {
    const options : DeployOptions = {
        stack: "",
        stacksDir: process.env.DOCKGE_STACKS_DIR || "/opt/stacks",
        composeFile: DEFAULT_COMPOSE_FILE,
        envFiles: [],
        branch: DEFAULT_BRANCH,
        dryRun: false,
        forceRecreate: false,
        skipGit: false,
    };

    for (const arg of argv) {
        if (arg === "--dry-run") {
            options.dryRun = true;
        } else if (arg === "--force-recreate") {
            options.forceRecreate = true;
        } else if (arg === "--skip-git") {
            options.skipGit = true;
        } else if (arg.startsWith("--stack=")) {
            options.stack = arg.slice("--stack=".length);
        } else if (arg.startsWith("--stacks-dir=")) {
            options.stacksDir = arg.slice("--stacks-dir=".length);
        } else if (arg.startsWith("--file=")) {
            options.composeFile = arg.slice("--file=".length);
        } else if (arg.startsWith("--env-file=")) {
            options.envFiles.push(arg.slice("--env-file=".length));
        } else if (arg.startsWith("--branch=")) {
            options.branch = arg.slice("--branch=".length);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (options.stack === "") {
        throw new Error("Missing --stack=<name>");
    }

    // Validate everything before any command is built or run
    buildDeployCommands(options);

    return options;
}

/**
 * Format a command for printing
 * @param command Command to format
 * @returns Printable command line
 */
export function formatCommand(command : DeployCommand) : string {
    return [ command.command, ...command.args ].join(" ");
}

/**
 * Run the deployment, or only print it in dry-run mode
 * @param options Parsed options
 */
export async function runDeploy(options : DeployOptions) : Promise<void> {
    const commands = buildDeployCommands(options);
    const stackDir = path.join(options.stacksDir, options.stack);

    if (options.dryRun) {
        console.log(`Dry run for ${options.stack} in ${stackDir}, no command is executed:`);
        for (const command of commands) {
            console.log("  " + formatCommand(command));
        }
        return;
    }

    for (const command of commands) {
        console.log("> " + formatCommand(command));

        const res = await spawn(command.command, command.args, {
            cwd: stackDir,
            encoding: "utf-8",
            maxBuffer: 4 * 1024 * 1024,
            timeoutMs: 15 * 60 * 1000,
        });

        const stdout = res.stdout?.toString().trim() ?? "";

        // `git status --porcelain` prints the dirty files, that is a stop condition
        if (command.args.includes("--porcelain")) {
            if (stdout !== "") {
                throw new Error(`The stack directory has local changes:\n${stdout}`);
            }
            continue;
        }

        if (stdout) {
            console.log(stdout);
        }
    }

    console.log("Deployment finished. `--wait` returned, so the services passed their health checks.");
}

// Only run when executed directly, so the module stays testable
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    try {
        await runDeploy(parseDeployArgs(process.argv.slice(2)));
    } catch (e) {
        if (e instanceof Error) {
            console.error(e.message);
        }
        process.exit(1);
    }
}
