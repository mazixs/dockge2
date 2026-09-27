import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentSocketHandler } from "../agent-socket-handler";
import type { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, type DockgeSocket } from "../util-server";
import { Stack } from "../stack";
import { StackConfig, emptyStackFileConfig, findEnvExample } from "../stack-config";
import { StackGitError, StackGitWorkflow } from "../stack-git";
import { GitDeployKeys } from "../git-deploy-key";
import { spawn } from "../child-process";
import { composeArgs } from "../compose-args";
import type { AgentSocket } from "../../common/agent-socket";
import type { AgentRequestContract } from "../../common/agent-events";
import type { GitApplyInput, GitCloneInput, GitDeployKeySource, GitEnvExample, GitMessage, GitSaveResult } from "../../common/types/stack-git";
import { classifyStackFile } from "../../common/stack-files";
import type { StackFileConfig } from "../../common/types/stack";
import { runInBackground } from "../background";
import { log } from "../log";

const workflows = new WeakMap<DockgeServer, StackGitWorkflow>();
const deployKeys = new WeakMap<DockgeServer, GitDeployKeys>();

/**
 * Deploy keys of one server, kept in its data directory.
 * @param server Server the stacks live on
 * @returns Its keys
 */
export function getGitDeployKeys(server: DockgeServer): GitDeployKeys {
    let value = deployKeys.get(server);
    if (!value) {
        value = new GitDeployKeys(path.join(server.config.dataDir, "git-keys"));
        deployKeys.set(server, value);
    }
    return value;
}

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

/** A service's `env_file` that is not there. Compose names it by its absolute path. */
const MISSING_ENV_FILE = /env file (\/[^\n]*?) not found|couldn't find env file: (\/[^\n]*)/g;

/** A plain relative name inside the checkout, the only form reported to the browser. */
const REPORTABLE_FILE = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

/**
 * Compose is complete but the environment it reads is not filled in yet.
 *
 * A repository almost never carries its own `.env` - it is in `.gitignore`, next to an
 * `.env.example`. A compose file that reads `${VAR:?}`, or a service with `env_file: .env`,
 * therefore cannot pass a check immediately after cloning, and that is an unfinished
 * environment rather than a broken file. The files are worth keeping: the variables are set
 * in them.
 */
export class ComposeEnvironmentError extends StackGitError {
    /** Saving may go ahead. Only starting the stack has to wait for the variables. */
    readonly deferrable = true;

    /**
     * @param variables Variables the compose file requires and nothing sets
     * @param envFiles Files services read with `env_file` that are not there
     * @param examples Examples the repository carries for those files
     */
    constructor(readonly variables: string[], readonly envFiles: string[] = [], readonly examples: GitEnvExample[] = []) {
        super(envFiles.length ? "gitComposeNeedsEnvFile" : "gitComposeNeedsVariables", envFiles.length ? { files: envFiles.join(", ") } : undefined);
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
 * Env files services read with `env_file` that the checkout does not have.
 *
 * Only a name inside the checkout is taken, so the path of the staging directory stays on
 * the server.
 * @param error Failure of `docker compose config`
 * @param directory The checkout Compose was run in
 * @returns Names relative to the checkout
 */
export async function missingEnvFiles(error: unknown, directory: string): Promise<string[]> {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr !== "string") {
        return [];
    }
    // Compose may print the directory with its symlinks resolved
    const roots = [ directory, await fs.realpath(directory).catch(() => directory) ];
    const names = new Set<string>();
    for (const [ , serviceFile, selectedFile ] of stderr.matchAll(MISSING_ENV_FILE)) {
        const file = (serviceFile ?? selectedFile) as string;
        const name = roots.map((root) => path.relative(root, file))
            .find((relative) => relative.length <= 200 && REPORTABLE_FILE.test(relative) && !relative.split("/").some((part) => part === "." || part === ".."));
        if (name) {
            names.add(name);
        }
        if (names.size >= MAX_REPORTED_VARIABLES) {
            break;
        }
    }
    return [ ...names ];
}

/** The example the checkout carries for each missing env file that has one. */
async function examplesOf(directory: string, files: string[]): Promise<GitEnvExample[]> {
    const found: GitEnvExample[] = [];
    for (const file of files) {
        const example = await findEnvExample(directory, file);
        if (example) {
            found.push({ file,
                example });
        }
    }
    return found;
}

/** Examples the stack page can copy: only env files at the root of the stack qualify. */
function copyableExamples(pending: StackGitError | undefined): GitEnvExample[] {
    return pending instanceof ComposeEnvironmentError ? pending.examples.filter(({ file }) => classifyStackFile(file) === "env") : [];
}

/** What the result card says about a stack saved without its environment. */
function environmentMessage(pending: ComposeEnvironmentError): GitMessage {
    if (!pending.envFiles.length) {
        return { key: "gitSavedNeedsVariables",
            values: { variables: pending.variables.join(", ") } };
    }
    const files = pending.envFiles.join(", ");
    return pending.examples.length
        ? { key: "gitSavedNeedsEnvFileFromExample",
            values: { files,
                example: pending.examples.map(({ example }) => example).join(", ") } }
        : { key: "gitSavedNeedsEnvFile",
            values: { files } };
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
        const variables = missingVariables(error);
        const envFiles = await missingEnvFiles(error, directory);
        if (variables.length || envFiles.length) {
            throw new ComposeEnvironmentError(variables, envFiles, await examplesOf(directory, envFiles));
        }
        log.warn("git", `The compose check refused the files: ${logSafeReason(error)}`);
        throw new StackGitError("gitComposeInvalid");
    }
}

export function getStackGitWorkflow(server: DockgeServer): StackGitWorkflow {
    let value = workflows.get(server);
    if (!value) {
        const keys = getGitDeployKeys(server);
        value = new StackGitWorkflow({ validate: (directory, config) => validate(directory, config, server.stacksDir),
            deployKey: (repository) => keys.keyFile(repository) });
        workflows.set(server, value);
    }
    return value;
}

function safeError(error: unknown): Error {
    return error instanceof StackGitError ? error : new StackGitError("gitOperationFailed");
}

/** Report saving and deploying separately: a deployment failure does not undo saved files, and files waiting for their environment are not started. */
async function result(server: DockgeServer, socket: DockgeSocket, name: string, deploy: boolean, notStarted?: GitMessage, envExamples: GitEnvExample[] = []): Promise<GitSaveResult> {
    let deployed = false;
    let deploymentError: GitMessage | undefined;
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
        ...(deploymentError ? { deploymentError } : {}),
        ...(notStarted ? { notStarted } : {}),
        ...(envExamples.length ? { envExamples } : {}) };
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
                    const saved = await result(server, socket, input.name, false);
                    callbackResult({ ok: true,
                        ...saved,
                        deploymentError: { key: "gitSelectionNotStored" } }, callback);
                    return;
                }
                // The checkout is on the server either way. Starting it is what waits for
                // the variables, and they are set in the files that were just saved.
                const notStarted = pending instanceof ComposeEnvironmentError ? environmentMessage(pending) : undefined;
                callbackResult({ ok: true,
                    ...await result(server, socket, input.name, input.deploy, notStarted, copyableExamples(pending)) }, callback);
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
        // Only the public half ever leaves: the private key stays in the data directory
        agentSocket.on("gitDeployKey", async (source: unknown, create: unknown, callback) => {
            try {
                checkLogin(socket);
                const input = source as GitDeployKeySource | null;
                if (!input || typeof input !== "object" || typeof create !== "boolean") {
                    throw new StackGitError("gitDeployKeyInvalidParameters");
                }
                let repository: string;
                if ("repository" in input && typeof input.repository === "string") {
                    repository = input.repository.trim();
                } else if ("stackName" in input && typeof input.stackName === "string") {
                    repository = await getStackGitWorkflow(server).remote(Stack.getSafePath(server, input.stackName));
                } else {
                    throw new StackGitError("gitDeployKeyInvalidParameters");
                }
                const keys = getGitDeployKeys(server);
                const key = create ? await keys.create(repository) : await keys.get(repository);
                callbackResult({ ok: true,
                    key }, callback);
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
                const { pending } = await getStackGitWorkflow(server).apply(dir, input, config);
                const notStarted = pending instanceof ComposeEnvironmentError ? environmentMessage(pending) : undefined;
                callbackResult({ ok: true,
                    ...await result(server, socket, input.stackName, input.deploy, notStarted, copyableExamples(pending)) }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
    }
}
