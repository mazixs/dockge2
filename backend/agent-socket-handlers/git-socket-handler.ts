import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentSocketHandler } from "../agent-socket-handler";
import type { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, type DockgeSocket } from "../util-server";
import { Stack } from "../stack";
import { StackConfig, emptyStackFileConfig } from "../stack-config";
import { StackGitError, StackGitWorkflow } from "../stack-git";
import { spawn } from "../child-process";
import { composeArgs } from "../compose-args";
import type { AgentSocket } from "../../common/agent-socket";
import type { AgentRequestContract } from "../../common/agent-events";
import type { GitApplyInput, GitCloneInput, GitMessage, GitSaveResult } from "../../common/types/stack-git";
import type { StackFileConfig } from "../../common/types/stack";
import { runInBackground } from "../background";
import { log } from "../log";

const workflows = new WeakMap<DockgeServer, StackGitWorkflow>();

/**
 * Names Compose reports as missing, read out of its own error text.
 *
 * Only the names are taken, never the surrounding sentence: a value can be a secret, a
 * name is what the user has to go and set. The pattern accepts a shell identifier and
 * nothing else, so no part of the message can travel out inside a name.
 */
const MISSING_VARIABLE = /required variable ([A-Za-z_][A-Za-z0-9_]{0,62}) is missing a value/g;

/** At most this many names are named; the rest is a list nobody reads anyway. */
const MAX_REPORTED_VARIABLES = 12;

/**
 * Compose is complete but the environment it reads is not filled in yet.
 *
 * A repository almost never carries its own `.env` - it is in `.gitignore`, next to an
 * `.env.example`. A compose file that reads `${VAR:?}` therefore cannot pass a check
 * immediately after cloning, and that is an unfinished environment rather than a broken
 * file. The files are worth keeping: the variables are set in them.
 */
export class ComposeEnvironmentError extends StackGitError {
    /** Saving may go ahead. Only starting the stack has to wait for the variables. */
    readonly deferrable = true;

    constructor(readonly variables: string[]) {
        super("gitComposeNeedsVariables");
    }
}

/** Read the missing variable names out of a failed `docker compose config`. */
export function missingVariables(error: unknown): string[] {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr !== "string") {
        return [];
    }
    const names = new Set<string>();
    for (const [ , name ] of stderr.matchAll(MISSING_VARIABLE)) {
        names.add(name as string);
        if (names.size >= MAX_REPORTED_VARIABLES) {
            break;
        }
    }
    return [ ...names ];
}

/**
 * Make the reason of a failed Docker command fit for the server log.
 *
 * The browser only ever gets a message key, and the owner reading the log needs the
 * reason itself. What an address carries before `@` is masked, and the text is cut
 * short so one failure cannot flood the log.
 */
export function logSafeReason(error: unknown): string {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error);
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@").trim().slice(0, 2000);
}

/** Validate in isolation; Docker output can contain credentials, so never return it. */
async function validate(directory: string, config: StackFileConfig, stacksDir: string): Promise<void> {
    try {
        await StackConfig.validate(directory, config);
        let globalEnvFile = "";
        const globalEnv = path.join(stacksDir, "global.env");
        try {
            const stat = await fs.lstat(globalEnv);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new StackGitError("gitGlobalEnvMustBeRegularFile");
            }
            globalEnvFile = globalEnv;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        // A project name of its own: the check must not touch the user's containers
        const args = composeArgs({ composeFileName: config.composeFileName,
            envFileNames: config.envFileNames,
            globalEnvFile,
            projectName: "dockge-git-validation" }, "config", "--quiet");
        await spawn("docker", args, { cwd: directory,
            encoding: "utf-8",
            maxBuffer: 256 * 1024,
            timeoutMs: 60_000 });
    } catch (error) {
        if (error instanceof StackGitError) {
            throw error;
        }
        const missing = missingVariables(error);
        if (missing.length) {
            throw new ComposeEnvironmentError(missing);
        }
        log.warn("git", `The compose check refused the files: ${logSafeReason(error)}`);
        throw new StackGitError("gitComposeInvalid");
    }
}

export function getStackGitWorkflow(server: DockgeServer): StackGitWorkflow {
    let value = workflows.get(server);
    if (!value) {
        value = new StackGitWorkflow({ validate: (directory, config) => validate(directory, config, server.stacksDir) });
        workflows.set(server, value);
    }
    return value;
}

function safeError(error: unknown): Error {
    return error instanceof StackGitError ? error : new StackGitError("gitOperationFailed");
}

/** Report saving and deploying separately: a deployment failure does not undo saved files. */
async function result(server: DockgeServer, socket: DockgeSocket, name: string, deploy: boolean, notStarted?: GitMessage): Promise<GitSaveResult> {
    let deployed = false;
    let deploymentError: GitMessage | undefined = notStarted;
    if (deploy && !notStarted) {
        try {
            const stack = await Stack.getStack(server, name);
            await stack.deploy(socket);
            deployed = true;
        } catch (error) {
            log.warn("git", `Deploying ${name} after saving failed: ${logSafeReason(error)}`);
            deploymentError = { key: "gitDeployFailedAfterSave" };
        }
    }
    runInBackground("stack list", () => server.sendStackList());
    return { stackName: name,
        saved: true,
        deployed,
        ...(deploymentError ? { deploymentError } : {}) };
}

/** Git events use the same agent routing and role gates as other stack mutations. */
export class GitSocketHandler extends AgentSocketHandler {
    create(socket: DockgeSocket, server: DockgeServer, agentSocket : AgentSocket<AgentRequestContract>): void {
        agentSocket.on("gitCloneStack", async (payload: unknown, callback) => {
            try {
                const input = payload as GitCloneInput;
                checkLogin(socket);
                if (!input || typeof input.name !== "string" || typeof input.deploy !== "boolean" || typeof input.composeFile !== "string" || (input.envFiles !== undefined && (!Array.isArray(input.envFiles) || !input.envFiles.every((name) => typeof name === "string")))) {
                    throw new StackGitError("gitCloneInvalidParameters");
                }
                Stack.validateNewName(input.name);
                const dir = Stack.getSafePath(server, input.name);
                const config = emptyStackFileConfig();
                config.composeFileName = input.composeFile;
                config.envFileNames = input.envFiles ?? [];
                config.activeEnvFileName = config.envFileNames[0] ?? "";
                const { pending } = await getStackGitWorkflow(server).clone(dir, input, config);
                try {
                    await StackConfig.set(input.name, config);
                } catch {
                    const saved = await result(server, socket, input.name, false, { key: "gitSelectionNotStored" });
                    callbackResult({ ok: true,
                        ...saved }, callback);
                    return;
                }
                // The checkout is on the server either way. Starting it is what waits for
                // the variables, and they are set in the files that were just saved.
                const notStarted = pending instanceof ComposeEnvironmentError
                    ? { key: "gitSavedNeedsVariables",
                        values: { variables: pending.variables.join(", ") } }
                    : undefined;
                callbackResult({ ok: true,
                    ...await result(server, socket, input.name, input.deploy, notStarted) }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
        // Listing branches is a button, not a side effect of typing the address: it is a
        // network request to someone else's server, and one per keystroke is not acceptable
        agentSocket.on("gitListBranches", async (repository: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof repository !== "string" || !repository.trim()) {
                    throw new StackGitError("gitRepositoryRequired");
                }
                const branches = await getStackGitWorkflow(server).listBranches(repository.trim());
                callbackResult({ ok: true,
                    branches }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
        agentSocket.on("gitPreviewUpdate", async (stackName: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new StackGitError("gitStackNameRequired");
                }
                const dir = Stack.getSafePath(server, stackName);
                const { config } = await StackConfig.inventory(dir, stackName);
                const preview = await getStackGitWorkflow(server).preview(dir, config);
                callbackResult({ ok: true,
                    preview }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
        agentSocket.on("gitDiscardPreview", async (stackName: unknown, previewId: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string" || typeof previewId !== "string" || previewId.length > 100) {
                    throw new StackGitError("gitApplyInvalidParameters");
                }
                const dir = Stack.getSafePath(server, stackName);
                getStackGitWorkflow(server).discard(dir, previewId);
                callbackResult({ ok: true }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
        agentSocket.on("gitApplyUpdate", async (payload: unknown, callback) => {
            try {
                const input = payload as GitApplyInput;
                checkLogin(socket);
                if (!input || typeof input.stackName !== "string" || typeof input.previewId !== "string" || typeof input.deploy !== "boolean") {
                    throw new StackGitError("gitApplyInvalidParameters");
                }
                const dir = Stack.getSafePath(server, input.stackName);
                const { config } = await StackConfig.inventory(dir, input.stackName);
                await getStackGitWorkflow(server).apply(dir, input, config);
                callbackResult({ ok: true,
                    ...await result(server, socket, input.stackName, input.deploy) }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
    }
}
