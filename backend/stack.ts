import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import { emptyStackFileConfig, resolveStackFilePath, resolveStackFilePathSync, StackConfig } from "./stack-config";
import { classifyStackFile } from "../common/stack-files";
import type { SecretFileMeta, StackDTO, StackFileBaseline, StackFileConfig, StackFileInventory, StackFileReadIssue, StackSummaryDTO } from "../common/types/stack";
import { hashStackFileContent, StackSelectionConflictError, type StackFileTarget, type StackWriteMetadata, StackWriteConflictError, writeStackFiles } from "./stack-write";
import {
    bindSecret, deleteSecretFile, readSecretFile, type SecretHost, unbindSecret, writeSecretFile,
} from "./stack-secrets";
import {
    ComposePsEntry,
    ContainerInstanceStatus,
    COMPOSE_WORKING_DIR_LABEL,
    DockerPsRaw,
    fromDockerPs,
    hasBuildServices,
    readComposeImages,
    normaliseInstance,
    readComposeServices,
    readOneShotServices,
    resolveStackStatus,
    StackStatusIssue,
    StackStatusResult,
    summariseServices,
    type ServiceSummary,
} from "../common/compose-status";
import {
    acceptedComposeFileNames,
    ATTENTION,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    getCombinedTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    type ContainerShell, isContainerShell,
    MAX_STACK_NAME_LENGTH,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import { spawn } from "./child-process";
import { readStackSource, type StackSource } from "./stack-source";
import { composeArgs } from "./compose-args";
import { removeStackContainers } from "./stack-delete";
import { readAvailability } from "./observations";
import type { Availability } from "../common/availability";
import { Settings } from "./settings";
import { withStackLock } from "./stack-lock";
import { clearImageUpdateCache } from "./image-updates";
import {
    type ComposeLsEntry, readComposeProjects, readInstanceMap, readOwnProjectName, readStatusList,
    resolveProjectStatus,
} from "./stack-state";

/**
 * Read a stack file, telling an absent file from one that cannot be read.
 *
 * A missing optional env file is an ordinary state and reads as empty. Anything else -
 * a permission problem, an I/O error, a name the directory refuses - is reported, because
 * an editor that is handed an empty text would save that emptiness over the real file.
 * @param filePath Absolute path inside the stack directory
 * @returns Content of the file, or the error code that prevented reading it
 */
function readStackFileSync(filePath : string) : { content : string, code? : string, missing? : boolean } {
    try {
        return { content: fs.readFileSync(filePath, "utf-8") };
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "EIO";
        if (code === "ENOENT") {
            return { content: "",
                missing: true };
        }
        return { content: "",
            code };
    }
}

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML : string | undefined;
    protected _composeENV : string | undefined;
    protected _configFilePath?: string | undefined;
    protected _composeFileName: string = "compose.yaml";
    protected _issues : StackStatusIssue[] = [];
    /** Services of this stack with their own state, filled by the list scan */
    protected _services : ServiceSummary[] = [];
    /** Where the directory comes from, filled by the list scan */
    protected _source : StackSource | null = null;
    /** Availability over the last day, filled by the list scan */
    protected _availability : Availability | null = null;
    protected _fileConfig : StackFileConfig = emptyStackFileConfig();
    /** Files the panel failed to read, by file name and error code */
    protected _readIssues : Map<string, string> = new Map();
    /** Selected files that do not exist, told apart from files that are empty */
    protected _missingFiles : Set<string> = new Set();
    protected _inventory? : StackFileInventory;
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    /**
     * Compose project this panel itself runs as, or "" when it is not in a container.
     * Read once: the answer cannot change while the process lives.
     */
    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (!skipFSOperations) {
            const dir = this.safePath;

            // Check if compose file name is different from compose.yaml
            if (dir) {
                for (const filename of acceptedComposeFileNames) {
                    if (fs.existsSync(path.join(dir, filename))) {
                        this._composeFileName = filename;
                        break;
                    }
                }
            }
        }
    }

    /**
     * Load the file selection of this stack from the settings and the directory.
     * Called before any Compose command so `-f` and `--env-file` are explicit.
     * @returns Inventory of the stack files
     */
    async loadFileConfig() : Promise<StackFileInventory> {
        const dir = this.safePath;

        if (!dir) {
            // A stack that is not managed by Dockge has no directory to inspect
            this._inventory = {
                config: emptyStackFileConfig(),
                composeFileNames: [],
                envFileNames: [],
                secretFiles: [],
                needsComposeSelection: false,
                unsupportedFileNames: [],
            };
            return this._inventory;
        }

        const inventory = await StackConfig.inventory(dir, this.name);

        this._inventory = inventory;
        this._fileConfig = inventory.config;

        if (inventory.config.composeFileName) {
            this._composeFileName = inventory.config.composeFileName;
        }

        return inventory;
    }

    get fileConfig() : StackFileConfig {
        return this._fileConfig;
    }

    get composeFileName() : string {
        return this._composeFileName;
    }

    /**
     * Env files passed to compose for interpolation, in order and only when they exist
     * @returns File names inside the stack directory
     */
    get envFileNames() : string[] {
        // A stack whose config was never loaded keeps the historic behaviour of using .env
        if (!this._inventory && this._fileConfig.envFileNames.length === 0) {
            return this.isUsableStackFile(".env") ? [ ".env" ] : [];
        }

        return this._fileConfig.envFileNames.filter((fileName) => this.isUsableStackFile(fileName));
    }

    /**
     * Whether a file of this stack exists and is a regular file inside the stack directory
     * @param fileName File name inside the stack directory
     * @returns True when the file can be handed to Compose
     */
    protected isUsableStackFile(fileName : string) : boolean {
        try {
            return fs.existsSync(resolveStackFilePathSync(this.path, fileName));
        } catch (e) {
            return false;
        }
    }

    /**
     * Env file shown and edited in the UI
     * @returns File name, or ".env" for a stack that has no selection yet
     */
    get activeEnvFileName() : string {
        return this._fileConfig.activeEnvFileName || ".env";
    }

    /**
     * Check that a stack name can be used as a directory name inside the stacks directory
     * @param name Stack name
     * @throws {ValidationError} If the name is not allowed
     */
    static validateName(name : string) : void {
        if (!name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }
    }

    /**
     * Check a name that is about to become a new stack directory.
     *
     * The length is checked here and not in validateName, which every read of an existing
     * stack goes through: a stack that was created before this limit has to stay reachable,
     * or the panel would hide a running stack it cannot rename.
     *
     * The limit is the name people will read back. It is the directory name, and Compose
     * puts it in front of every container, network and volume it creates, so a name longer
     * than this is unreadable everywhere it appears. The filesystem itself only gives up at
     * 255 bytes, which is far past the point where the name stops being usable.
     * @param name Stack name requested for a new stack
     * @throws {ValidationError} If the name is not allowed or is too long
     */
    static validateNewName(name : string) : void {
        Stack.validateName(name);
        if (name.length > MAX_STACK_NAME_LENGTH) {
            throw new ValidationError("stackNameTooLong", { max: String(MAX_STACK_NAME_LENGTH) });
        }
    }

    /**
     * Resolve the directory of a stack and make sure it stays inside the stacks directory.
     * This is the single barrier that must be passed before any filesystem or Docker operation.
     * @param server Dockge server holding the stacks directory
     * @param name Stack name
     * @returns Absolute path of the stack directory
     * @throws {ValidationError} If the name is not allowed or escapes the stacks directory
     */
    static getSafePath(server : DockgeServer, name : string) : string {
        Stack.validateName(name);

        const base = path.resolve(server.stacksDir);
        const resolved = path.resolve(base, name);
        const relative = path.relative(base, resolved);

        if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new ValidationError("Stack path is outside the stacks directory");
        }

        return resolved;
    }

    /**
     * Reject a stack directory that is a symbolic link, so a valid name cannot point outside
     * @param dir Stack directory returned by getSafePath()
     * @throws {ValidationError} If the directory itself is a symbolic link
     */
    static async assertNotSymlink(dir : string) : Promise<void> {
        try {
            const stat = await fsAsync.lstat(dir);
            if (stat.isSymbolicLink()) {
                throw new ValidationError("Stack path is outside the stacks directory");
            }
        } catch (e) {
            if (e instanceof ValidationError) {
                throw e;
            }
            // Not existing yet is not a traversal problem, the caller handles it
        }
    }

    /**
     * Stack directory, or undefined when the stack name cannot be used on the filesystem.
     * Used for display-only code paths that must not fail for stacks created outside Dockge.
     */
    protected get safePath() : string | undefined {
        try {
            return this.path;
        } catch (e) {
            return undefined;
        }
    }

    async toJSON(endpoint : string) : Promise<StackDTO> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        const inventory = this._inventory ?? await this.loadFileConfig();

        const composeYAML = this.composeYAML;
        const composeENV = this.composeENV;

        return {
            ...obj,
            composeYAML,
            composeENV,
            // What the editor loaded, so a save can tell the server which version it changed
            // and which files it was looking at while it did
            fileHashes: {
                compose: this._readIssues.has(this._composeFileName) ? null : hashStackFileContent(composeYAML),
                env: this._readIssues.has(this.activeEnvFileName) || this._missingFiles.has(this.activeEnvFileName) ? null : hashStackFileContent(composeENV),
                composeFileName: this._composeFileName,
                envFileName: this.activeEnvFileName,
            },
            // Files the panel could not read: an editor must not save over them
            readIssues: this.readIssues,
            primaryHostname,
            // Only names, sizes and bindings of secrets, never their content
            files: {
                composeFileNames: inventory.composeFileNames,
                envFileNames: inventory.envFileNames,
                activeEnvFileName: this.activeEnvFileName,
                selectedEnvFileNames: inventory.config.envFileNames,
                secretFiles: inventory.secretFiles,
                needsComposeSelection: inventory.needsComposeSelection,
                unsupportedFileNames: inventory.unsupportedFileNames,
            },
        };
    }

    toSimpleJSON(endpoint : string) : StackSummaryDTO {
        return {
            name: this.name,
            status: this._status,
            issues: this._issues,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
            // The list row shows what a stack consists of and where it comes from,
            // so both travel with the row instead of one request per stack
            services: this._services,
            source: this._source,
            // Directory of the stack: the header shows where its files live
            dir: this.isManagedByDockge ? this.path : "",
            // What is known about the last day, computed from recorded status changes
            availability: this._availability,
        };
    }

    get isManagedByDockge() : boolean {
        const dir = this.safePath;
        if (!dir) {
            return false;
        }
        return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    }

    get status() : number {
        return this._status;
    }

    validate() {
        // Check name, allows [a-z][0-9] _ - only
        Stack.validateName(this.name);

        // Check YAML format
        yaml.parse(this.composeYAML);

        const lines = this.composeENV.split("\n");
        const firstLine = lines[0] ?? "";

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !firstLine.includes("=") && firstLine.length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            this._composeYAML = this.readSelectedFile(this._composeFileName);
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            this._composeENV = this.readSelectedFile(this.activeEnvFileName);
        }
        return this._composeENV;
    }

    /**
     * Read one of the selected files and remember a failure instead of hiding it.
     *
     * The getters cannot throw: the stack list shows every directory, including the ones
     * whose files this process may not read. What they must not do is let a caller treat
     * an unreadable file as an empty one, so the failure is kept and reported separately.
     * @param fileName Selected compose or env file
     * @returns Content, or an empty text when the file is absent or unreadable
     */
    protected readSelectedFile(fileName : string) : string {
        let result : { content : string, code? : string, missing? : boolean };

        try {
            result = readStackFileSync(resolveStackFilePathSync(this.path, fileName));
        } catch (e) {
            // The name or the directory itself is not usable: not an empty file either
            result = { content: "",
                code: "EINVAL" };
        }

        if (result.code) {
            this._readIssues.set(fileName, result.code);
        } else {
            this._readIssues.delete(fileName);
        }

        if (result.missing) {
            this._missingFiles.add(fileName);
        } else {
            this._missingFiles.delete(fileName);
        }

        return result.content;
    }

    /**
     * Files of this stack that could not be read, after the texts were loaded.
     * @returns One entry per file the panel failed to read
     */
    get readIssues() : StackFileReadIssue[] {
        return [ ...this._readIssues.entries() ].map(([ fileName, code ]) => ({ fileName,
            code }));
    }

    /**
     * Whether every selected file was read, so an editor may safely save over them.
     * @returns True when nothing failed to read
     */
    get filesAreReadable() : boolean {
        return this._readIssues.size === 0;
    }

    get path() : string {
        return Stack.getSafePath(this.server, this.name);
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk.
     *
     * The compose file and the env file are written as one transaction: either both hold
     * the new text or both hold the old one, and an interrupted process finishes or undoes
     * the write on the next start. When the caller states what it read, a file that has
     * changed meanwhile is reported as a conflict instead of being overwritten.
     * @param isAdd Whether the stack directory has to be created
     * @param baseline What the editor read before it started changing the files
     * @returns Hashes of the saved files, so the editor can keep saving from them
     * @throws {StackWriteConflictError} If a file no longer holds what the caller read
     */
    async save(isAdd : boolean, baseline? : StackFileBaseline) : Promise<StackFileBaseline> {
        this.validate();

        const dir = this.path;

        // The selection is read, checked against the baseline and written inside one
        // lock. Held only around the file transaction, the check and the change were two
        // operations: a selection changed in between was read as unchanged here and then
        // written back by this save, losing a confirmed decision. `writeStackFiles` takes
        // the same lock and passes straight through, because a lock already held by this
        // operation is not taken twice
        return withStackLock(dir, () => this.writeSaved(isAdd, baseline));
    }

    /**
     * The body of a save, running with the stack directory locked
     * @param isAdd Whether the stack directory has to be created
     * @param baseline What the editor read before it started changing the files
     * @returns Hashes of the saved files
     * @throws {StackWriteConflictError} If a file no longer holds what the caller read
     */
    private async writeSaved(isAdd : boolean, baseline? : StackFileBaseline) : Promise<StackFileBaseline> {
        const dir = this.path;

        await this.prepareDirectory(isAdd);
        const previousConfig = isAdd ? null : structuredClone(this._fileConfig);

        try {
            if (isAdd) {
                // A new stack starts with the compose file it was created with
                await StackConfig.setQuiet(this.name, {
                    composeFileName: this._composeFileName,
                    envFileNames: this.composeENV.trim() === "" ? [] : [ this.activeEnvFileName ],
                    activeEnvFileName: this.composeENV.trim() === "" ? "" : this.activeEnvFileName,
                    secretBindings: [],
                });
            }

            // Always load the stored selection before writing: the socket handlers build a
            // Stack directly, so without this the write would fall back to compose.yaml and .env
            await this.loadFileConfig();

            const envFileName = this.activeEnvFileName;
            const envPath = await resolveStackFilePath(dir, envFileName);
            const shouldWriteEnv = await fileExists(envPath) || this.composeENV.trim() !== "";

            // The hashes say the bytes are still the ones the editor read; this says they
            // are still the bytes of the file it had open
            this.assertBaselineSelection(baseline, envFileName, shouldWriteEnv);

            const adoption = await this.envAdoption(envFileName, shouldWriteEnv);
            const written = await writeStackFiles(dir, this.writeTargets(envFileName, shouldWriteEnv, baseline), { journalRoot: this.server.config.dataDir,
                ...(adoption ? { metadata: adoption } : {}) });

            if (adoption) {
                this._fileConfig = adoption.after;
            }
            this.applyOwnership(dir, envPath, shouldWriteEnv);

            // The names travel back with the hashes, so the editor that saves again is
            // still held to the files it has open rather than to whichever ones the
            // stack points at by then
            return { compose: written.hashes[this._composeFileName] ?? null,
                env: shouldWriteEnv ? (written.hashes[envFileName] ?? null) : null,
                composeFileName: this._composeFileName,
                envFileName };
        } catch (e) {
            // A stack that was never created must not leave a directory and a stored
            // selection behind: the next attempt would be refused as an existing name
            if (isAdd) {
                await StackConfig.removeQuiet(this.name).catch(() => undefined);
                await fsAsync.rmdir(dir).catch(() => undefined);
            } else if (previousConfig) {
                this._fileConfig = previousConfig;
            }
            throw e;
        }
    }

    /**
     * Make sure the directory is the one this save expects
     * @param isAdd Whether the stack directory has to be created
     * @returns {void}
     * @throws {ValidationError} If the name is taken, or the stack is not there at all
     */
    private async prepareDirectory(isAdd : boolean) : Promise<void> {
        const exists = await fileExists(this.path);

        if (isAdd && exists) {
            throw new ValidationError("Stack name already exists");
        }
        if (isAdd) {
            await fsAsync.mkdir(this.path);
            return;
        }
        if (!exists) {
            throw new ValidationError("Stack not found");
        }
    }

    /**
     * Which files this save writes, and what each of them is expected to hold now.
     *
     * A baseline travels per file: the caller says what it read, and a file that changed
     * since is a conflict rather than something to overwrite.
     * @param envFileName Env file of the stack
     * @param shouldWriteEnv Whether the env file is written at all
     * @param baseline What the editor read before it started changing the files
     * @returns The files to write, in order
     * @throws {StackWriteConflictError} If the env file the editor read is gone
     */
    private writeTargets(envFileName : string, shouldWriteEnv : boolean, baseline? : StackFileBaseline) : StackFileTarget[] {
        const targets : StackFileTarget[] = [{ name: this._composeFileName,
            content: this.composeYAML,
            ...(baseline && "compose" in baseline ? { expectedHash: baseline.compose } : {}) }];

        if (shouldWriteEnv) {
            targets.push({ name: envFileName,
                content: this.composeENV,
                ...(baseline && "env" in baseline ? { expectedHash: baseline.env } : {}) });
        } else if (baseline && "env" in baseline && baseline.env !== null) {
            // The editor believed it was changing an env file that is no longer there
            throw new StackWriteConflictError(envFileName);
        }
        return targets;
    }

    /**
     * Refuse a save whose editor had other files open than the ones this stack writes now.
     *
     * The selection lives in the settings, so it can change between the moment an editor
     * read a stack and the moment it saves: another tab, another user, the files screen.
     * Two files may hold the same text, so the hashes alone would let such a save land in
     * a file the editor never showed. The caller is told to re-read instead.
     * @param baseline What the editor read before it started changing the files
     * @param envFileName Env file this save would write
     * @param shouldWriteEnv Whether the env file is written at all
     * @returns {void}
     * @throws {StackSelectionConflictError} If the selection is no longer the one that was read
     */
    private assertBaselineSelection(baseline : StackFileBaseline | undefined, envFileName : string, shouldWriteEnv : boolean) : void {
        if (!baseline) {
            return;
        }

        if (baseline.composeFileName !== undefined && baseline.composeFileName !== this._composeFileName) {
            throw new StackSelectionConflictError(baseline.composeFileName, this._composeFileName);
        }

        if (shouldWriteEnv && baseline.envFileName !== undefined && baseline.envFileName !== envFileName) {
            throw new StackSelectionConflictError(baseline.envFileName, envFileName);
        }
    }

    /**
     * The selection change that belongs to this save, when the env file is a new one.
     *
     * Writing the file and noting that compose interpolates it is one decision, so the
     * change travels into the file transaction instead of being stored afterwards: a
     * settings store that is unavailable then fails the save rather than leaving a file
     * nothing refers to. What was stored before is read from the settings themselves, so
     * an undo puts back exactly that, including "there was nothing".
     * @param envFileName Env file this save writes
     * @param shouldWriteEnv Whether the env file is written at all
     * @returns The selection change, or nothing when the file is already in the set
     */
    private async envAdoption(envFileName : string, shouldWriteEnv : boolean) : Promise<StackWriteMetadata | undefined> {
        if (!shouldWriteEnv || this._fileConfig.envFileNames.includes(envFileName)) {
            return undefined;
        }

        return {
            stack: this.name,
            before: await StackConfig.get(this.name),
            after: {
                ...this._fileConfig,
                envFileNames: [ ...this._fileConfig.envFileNames, envFileName ],
                activeEnvFileName: envFileName,
            },
        };
    }

    /**
     * Hand the written files to the account the container runs as, when one is configured
     * @param dir Stack directory
     * @param envPath Path of the env file
     * @param shouldWriteEnv Whether the env file was written
     * @returns {void}
     */
    private applyOwnership(dir : string, envPath : string, shouldWriteEnv : boolean) : void {
        if (!process.env.PUID || !process.env.PGID) {
            return;
        }
        const uid = Number(process.env.PUID);
        const gid = Number(process.env.PGID);

        fs.lchownSync(dir, uid, gid);
        fs.chownSync(path.join(dir, this._composeFileName), uid, gid);
        if (shouldWriteEnv) {
            fs.chownSync(envPath, uid, gid);
        }
    }

    /**
     * Let Docker Compose validate the selected file and env files before anything is started.
     * The canonical output of `config` is never written back, only the exit code is used.
     * @throws {ValidationError} If Compose refuses the project
     */
    async validateComposeConfig() : Promise<void> {
        try {
            await spawn("docker", this.getComposeOptions("config", "--quiet"), {
                cwd: this.path,
                encoding: "utf-8",
                maxBuffer: 256 * 1024,
                timeoutMs: 60_000,
            });
        } catch (e) {
            const stderr = (e as { stderr? : string | Buffer }).stderr?.toString().trim() ?? "";
            const reason = stderr === "" ? (e instanceof Error ? e.message : String(e)) : stderr;

            // Compose normally reports keys and paths, but the message is redacted anyway:
            // a secret value must never reach the client through an error
            throw new ValidationError("Invalid compose configuration: " + (await this.redactSecrets(reason)).slice(0, 2000));
        }
    }

    /**
     * Replace secret values with a placeholder before a text leaves the server
     * @param text Text that may quote file content
     * @returns Text with secret values removed
     */
    async redactSecrets(text : string) : Promise<string> {
        let result = text;

        for (const meta of this._fileConfig.secretBindings) {
            try {
                const content = (await fsAsync.readFile(path.join(this.path, meta.fileName), "utf-8")).trim();

                // Very short values would match too much, they are not usable secrets anyway
                if (content.length >= 4 && result.includes(content)) {
                    result = result.split(content).join("[secret]");
                }
            } catch (e) {
                // A secret that cannot be read cannot leak either
            }
        }

        return result;
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        return this.control("deploy", (args, cwd) => Terminal.exec(this.server, socket, getComposeTerminalName(socket.endpoint, this.name), "docker", args, cwd));
    }

    /** Delete even an unconfigured stack, without asking broken Compose files to clean it up. */
    async delete(socket: DockgeSocket) : Promise<number> {
        return withStackLock(this.path, async () => {
            await Stack.assertNotSymlink(this.path);
            const terminalName = getComposeTerminalName(socket.endpoint, this.name);
            if (Terminal.getTerminal(terminalName)) {
                throw new ValidationError("Another operation is already running, please try again later.");
            }
            const execute = (args : string[]) => Terminal.exec(this.server, socket, terminalName, "docker", args, this.path);
            let valid = true;
            try {
                await this.validateComposeConfig();
            } catch (e) {
                if (!(e instanceof ValidationError)) {
                    throw e;
                }
                valid = false;
            }

            if (valid && await execute(this.getComposeOptions("down", "--remove-orphans")) !== 0) {
                throw new Error("stackDeleteContainersFailed");
            }
            // Also catches containers deployed before a later edit changed the project name.
            await removeStackContainers(this.path, execute);

            await fsAsync.rm(this.path, { recursive: true,
                force: true });
            await StackConfig.removeQuiet(this.name);
            return 0;
        });
    }

    async updateStatus() {
        let statusList = await readStatusList();
        let status = statusList.get(this.name);

        if (status) {
            this._status = status;
        } else {
            this._status = UNKNOWN;
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0) {
            stackList = this.managedStackList;
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // Get the project list and config paths from docker compose ls
        let composeList : ComposeLsEntry[];

        try {
            composeList = await readComposeProjects();
        } catch (e) {
            // Docker is unreachable. The managed stacks are still listed, but their status
            // becomes UNKNOWN instead of keeping the last known green value.
            if (e instanceof Error) {
                log.warn("getStackList", "Cannot read the compose project list: " + e.message);
            }

            for (const stack of stackList.values()) {
                stack._status = UNKNOWN;
                stack._issues = [];
            }

            await this.fillStackDetails(stackList);

            return stackList;
        }

        if (composeList.length === 0) {
            await this.fillStackDetails(stackList);
            return stackList;
        }

        // Container states of every compose project, read in one Docker call
        const instanceMap = await readInstanceMap();

        // The panel's own project, so it does not list itself as a stack it cannot touch.
        // "dockge" is kept beside it for an installation carried over from upstream, where
        // that was the project name
        const ownProject = await readOwnProjectName();

        for (let composeStack of composeList) {
            let stack = stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Hide the panel itself: stopping or redeploying it from inside would take
                // away the very thing showing the buttons. A copy the user has deliberately
                // put in the stacks directory is a different matter - that one is managed,
                // so it was found above and never reaches this branch
                if (composeStack.Name === ownProject || composeStack.Name === "dockge") {
                    continue;
                }
                stack = new Stack(server, composeStack.Name);
                stackList.set(composeStack.Name, stack);
            }

            const detailed = resolveProjectStatus(composeStack, instanceMap, stack);
            stack._status = detailed.status;
            stack._issues = detailed.issues;
            stack._configFilePath = composeStack.ConfigFiles;
            stack._services = summariseServices(
                detailed.instances,
                readComposeServices(stack.isManagedByDockge ? stack.composeYAML : ""),
                readOneShotServices(stack.isManagedByDockge ? stack.composeYAML : ""),
            );
        }

        await this.fillStackDetails(stackList);

        return stackList;
    }

    /**
     * Fill the availability of every stack over the last day.
     *
     * One query per stack is enough here: the history holds only status changes, so a
     * stack that has been running for a month answers with a single row. The queries
     * are started together rather than one after the other - they do not depend on each
     * other, and awaiting each in turn made the first screen wait for as many database
     * round trips as there are stacks.
     * @param stackList Stacks of this scan
     * @returns void
     */
    static async fillAvailability(stackList : Map<string, Stack>) : Promise<void> {
        const day = 24 * 3_600_000;

        await Promise.all([ ...stackList.values() ].map(async (stack) => {
            try {
                stack._availability = await readAvailability(stack.name, "", day);
            } catch (e) {
                // No history is a normal answer, an error here must not drop the list
                if (e instanceof Error) {
                    log.debug("getStackList", `Cannot read the history of ${stack.name}: ${e.message}`);
                }
            }
        }));
    }

    /**
     * Fill the parts of a row that Docker does not answer: the services a stack declares
     * and where its directory comes from.
     *
     * A stack that was never deployed has no containers, so without this its row would
     * show nothing but a name - and that is exactly the stack whose services the owner
     * wants to see before pressing start.
     * @param stackList Stacks of this scan
     * @returns void
     */
    protected static async fillStackDetails(stackList : Map<string, Stack>) : Promise<void> {
        // Started together for the same reason as the availability above: every stack
        // is described from its own directory and none of them waits on another
        await Promise.all([ ...stackList.values() ].map(async (stack) => {
            if (!stack.isManagedByDockge) {
                return;
            }

            try {
                if (stack._services.length === 0) {
                    stack._services = summariseServices(
                        [],
                        readComposeServices(stack.composeYAML),
                        readOneShotServices(stack.composeYAML),
                    );
                }

                stack._source = await readStackSource(stack.path);
            } catch (e) {
                // A broken file or an unreadable directory must not drop the whole list
                if (e instanceof Error) {
                    log.debug("getStackList", `Cannot describe ${stack.name}: ${e.message}`);
                }
            }
        }));
    }

    /**
     * Read the containers of this stack with the exact Compose fields, including Health and ExitCode
     * @returns Instances of the stack, or null when Docker output cannot be trusted
     */
    async getInstances() : Promise<ContainerInstanceStatus[] | null> {
        try {
            // Filter by the working directory of this stack instead of trusting the project
            // name: a `.env` with COMPOSE_PROJECT_NAME renames the project, and then a name
            // based lookup finds nothing while the containers are running.
            const res = await spawn("docker", [
                "ps",
                "--all",
                "--filter",
                `label=${COMPOSE_WORKING_DIR_LABEL}=${this.path}`,
                "--format",
                "json",
            ], {
                cwd: this.path,
                encoding: "utf-8",
                maxBuffer: 4 * 1024 * 1024,
                timeoutMs: 15_000,
            });

            if (!res.stdout) {
                return [];
            }

            const entries : ComposePsEntry[] = [];

            // Docker writes one JSON object per line
            for (const line of res.stdout.toString().split("\n")) {
                if (line.trim() === "") {
                    continue;
                }

                entries.push(fromDockerPs(JSON.parse(line) as DockerPsRaw));
            }

            const oneShotServices = readOneShotServices(this.composeYAML);
            return entries.map((entry) => normaliseInstance(entry, oneShotServices));
        } catch (e) {
            if (e instanceof Error) {
                log.warn("getInstances", `Failed to read containers of ${this.name}: ${e.message}`);
            }
            return null;
        }
    }

    /**
     * Resolve the status of this stack and the reasons behind it, based on its containers
     * @returns Status, issues and instances
     */
    async getDetailedStatus() : Promise<StackStatusResult & { instances : ContainerInstanceStatus[] }> {
        const instances = await this.getInstances();

        if (!instances) {
            return { status: UNKNOWN,
                issues: [],
                instances: [] };
        }

        const composeYAML = this.composeYAML;
        const result = resolveStackStatus(instances, readComposeServices(composeYAML));

        return { ...result,
            instances };
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        // Validate the name and resolve the directory before any filesystem or Docker access
        let dir = Stack.getSafePath(server, stackName);

        if (!skipFSOperations) {
            await Stack.assertNotSymlink(dir);

            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                // Maybe it is a stack managed by docker compose directly
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);

        if (!skipFSOperations) {
            await stack.loadFileConfig();
        }

        return stack;
    }

    /**
     * Build the argument array of a `docker compose` call.
     * The compose file is always explicit, so the UI and Compose can never disagree about it,
     * and env files are passed in the configured order.
     * @param command Compose sub command
     * @param extraOptions Arguments of the sub command
     * @returns Argument array, never a shell string
     */
    getComposeOptions(command : string, ...extraOptions : string[]) {
        const options = composeArgs({ composeFileName: this._composeFileName,
            envFileNames: this.envFileNames,
            globalEnvFile: fs.existsSync(path.join(this.server.stacksDir, "global.env")) ? "../global.env" : "" },
        command, ...extraOptions);

        log.debug("getComposeOptions", options);
        return options;
    }

    /** Run bounded lifecycle operations through the same command selection for UI and MCP. */
    async control(action: "start" | "stop" | "restart" | "deploy" | "update", execute: (args: string[], cwd: string) => Promise<number>): Promise<number> {
        if (![ "start", "stop", "restart", "deploy", "update" ].includes(action)) {
            throw new Error("Unsupported stack control action");
        }
        if ([ "start", "deploy", "update", "restart" ].includes(action)) {
            await this.validateComposeConfig();
        }
        // Стек, который собирает свой образ сам, иначе не увидел бы ни одной правки:
        // готовый образ уже лежит на машине, и `compose up` берет его как есть.
        // Повторная сборка без изменений ничего не стоит - слои берутся из кеша,
        // и контейнер не пересоздается
        const builds = hasBuildServices(this.composeYAML);

        if (action === "update") {
            // Для собираемых сервисов `pull` тянуть нечего, и он их пропускает,
            // а вот базовый образ из их Dockerfile обновляет только `build --pull`
            const pullCode = await execute(this.getComposeOptions("pull"), this.path);
            if (pullCode !== 0) {
                throw new Error("Stack image update failed; check the operation output.");
            }
            if (builds) {
                const buildCode = await execute(this.getComposeOptions("build", "--pull"), this.path);
                if (buildCode !== 0) {
                    throw new Error("Stack image update failed; check the operation output.");
                }
            }
            // The local images are now the ones the registry served, so an answer read
            // before the pull would keep announcing the update that just happened
            clearImageUpdateCache(readComposeImages(this.composeYAML));
            await this.updateStatus();
            if (this.status !== RUNNING && this.status !== ATTENTION) {
                return pullCode;
            }
        }
        const upOptions = builds && action !== "update"
            ? this.getComposeOptions("up", "-d", "--build", "--remove-orphans")
            : this.getComposeOptions("up", "-d", "--remove-orphans");
        const options = action === "restart"
            ? this.getComposeOptions("up", "-d", "--force-recreate")
            : [ "start", "deploy", "update" ].includes(action) ? upOptions : this.getComposeOptions(action);
        const exitCode = await execute(options, this.path);
        if (exitCode !== 0) {
            throw new Error("Stack control failed; check the operation output.");
        }
        return exitCode;
    }

    async start(socket: DockgeSocket) {
        return this.control("start", (args, cwd) => Terminal.exec(this.server, socket, getComposeTerminalName(socket.endpoint, this.name), "docker", args, cwd));
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        return this.control("stop", (args, cwd) => Terminal.exec(this.server, socket, getComposeTerminalName(socket.endpoint, this.name), "docker", args, cwd));
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        return this.control("restart", (args, cwd) => Terminal.exec(this.server, socket, getComposeTerminalName(socket.endpoint, this.name), "docker", args, cwd));
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to down, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async update(socket: DockgeSocket) {
        return this.control("update", (args, cwd) => Terminal.exec(this.server, socket, getComposeTerminalName(socket.endpoint, this.name), "docker", args, cwd));
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", this.getComposeOptions("logs", "-f", "--tail", "100"), this.path);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    /**
     * Attach a client to an interactive shell of one service.
     * The service has to exist in the selected compose file and the shell has to exist
     * in the image, both are checked before a PTY is started.
     * @param socket Client socket
     * @param serviceName Service of this stack
     * @param shell Allowed shell
     * @param index Session index for the same service and shell
     * @returns Name of the terminal the client joined
     * @throws {ValidationError} If the service or the shell cannot be used
     */
    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : ContainerShell = "sh", index: number = 0) : Promise<string> {
        if (!isContainerShell(shell)) {
            throw new ValidationError("Unsupported shell: " + shell);
        }

        this.assertServiceExists(serviceName);

        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, shell, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            await this.assertShellExists(serviceName, shell);

            terminal = new InteractiveTerminal(this.server, terminalName, "docker", this.getComposeOptions("exec", serviceName, shell), this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();

        return terminalName;
    }

    /**
     * Refuse a service that the selected compose file does not declare
     * @param serviceName Service name from the client
     * @throws {ValidationError} If the service is unknown
     */
    assertServiceExists(serviceName : string) : void {
        if (serviceName.startsWith("-")) {
            throw new ValidationError("Unknown service: " + serviceName);
        }

        const services = readComposeServices(this.composeYAML);

        if (services.length === 0) {
            // The compose file could not be read, so nothing can be confirmed
            throw new ValidationError("Cannot read the compose file of this stack");
        }

        if (!services.includes(serviceName)) {
            throw new ValidationError("Unknown service: " + serviceName);
        }
    }

    /**
     * Check that the requested shell exists in the running container
     * @param serviceName Service of this stack
     * @param shell Allowed shell
     * @throws {ValidationError} If the shell is missing or the container is not running
     */
    async assertShellExists(serviceName : string, shell : ContainerShell) : Promise<void> {
        try {
            await spawn("docker", this.getComposeOptions("exec", "-T", serviceName, "sh", "-c", `command -v ${shell}`), {
                cwd: this.path,
                encoding: "utf-8",
                maxBuffer: 64 * 1024,
                timeoutMs: 20_000,
            });
        } catch (e) {
            log.debug("assertShellExists", `${shell} is not usable in ${serviceName}: ${e instanceof Error ? e.message : String(e)}`);
            throw new ValidationError(`${shell} is not available in this container`);
        }
    }

    /**
     * Apply a new file selection after validating it against the directory
     * @param config Selection coming from the UI
     * @returns The stored selection
     */
    async setFileConfig(config : StackFileConfig) : Promise<StackFileConfig> {
        const dir = this.path;

        // The same lock a save takes: otherwise this change could land between the moment
        // a save reads the selection and the moment it writes its own, and the save would
        // put the old selection back over this one
        return withStackLock(dir, async () => {
            const validated = await StackConfig.validate(dir, config);

            await StackConfig.set(this.name, validated);
            await this.loadFileConfig();

            // Drop cached texts, the selected files may be different now
            this._composeYAML = undefined;
            this._composeENV = undefined;

            return validated;
        });
    }

    /**
     * Write an env file of the stack
     * @param fileName Env file inside the stack directory
     * @param content New content
     */
    async writeEnvFile(fileName : string, content : string) : Promise<void> {
        if (classifyStackFile(fileName) !== "env") {
            throw new ValidationError("Not an env file: " + fileName);
        }

        await writeStackFiles(this.path, [{ name: fileName,
            content }], { journalRoot: this.server.config.dataDir });

        if (fileName === this.activeEnvFileName) {
            this._composeENV = content;
        }
    }

    /**
     * Metadata of the secret files, without any content
     * @returns Secret file metadata
     */
    async listSecretFiles() : Promise<SecretFileMeta[]> {
        const inventory = await this.loadFileConfig();
        return inventory.secretFiles;
    }

    /**
     * The stack as the secret operations see it.
     * The compose text is read through a call, so nothing is loaded from disk for an
     * operation that never touches it.
     * @returns Port the functions of `stack-secrets` write through
     */
    private get secretHost() : SecretHost {
        return {
            name: this.name,
            path: this.path,
            journalRoot: this.server.config.dataDir,
            composeFileName: this._composeFileName,
            composeText: () => this.composeYAML,
            fileConfig: () => this._fileConfig,
            rememberCompose: (content : string) => {
                this._composeYAML = content;
            },
            rememberConfig: (config : StackFileConfig) => {
                this._fileConfig = config;
            },
        };
    }

    /**
     * Read the content of a secret file.
     * The caller has to authorise this separately, it is not part of the stack response.
     * @param fileName Secret file inside the stack directory
     * @returns File content
     */
    async readSecretFile(fileName : string) : Promise<string> {
        return readSecretFile(this.secretHost, fileName);
    }

    /**
     * Create or replace a secret file with restrictive permissions
     * @param fileName Secret file inside the stack directory
     * @param content New content
     */
    async writeSecretFile(fileName : string, content : string) : Promise<void> {
        await writeSecretFile(this.secretHost, fileName, content);
    }

    /**
     * Delete a secret file and its binding
     * @param fileName Secret file inside the stack directory
     */
    async deleteSecretFile(fileName : string) : Promise<void> {
        await deleteSecretFile(this.secretHost, fileName);
    }

    /**
     * Reference a secret file from the compose file, only on an explicit user action
     * @param secretName Compose secret name
     * @param fileName Secret file inside the stack directory
     * @param services Services that get access to the secret
     */
    async bindSecret(secretName : string, fileName : string, services : readonly string[]) : Promise<void> {
        await bindSecret(this.secretHost, secretName, fileName, services);
    }

    /**
     * Remove a secret reference from the compose file and from the stored bindings
     * @param secretName Compose secret name
     */
    async unbindSecret(secretName : string) : Promise<void> {
        await unbindSecret(this.secretHost, secretName);
    }

    /**
     * Run a compose command for one service of this stack.
     * The service name is checked against the compose file first, because Compose accepts
     * its own flags in the service position: "--remove-orphans" would act on the whole stack.
     * @param socket Client socket
     * @param command Compose sub command
     * @param serviceName Service of this stack
     * @param extraOptions Arguments of the sub command
     * @returns Exit code
     * @throws {ValidationError} If the service is unknown
     */
    protected async execServiceCommand(socket : DockgeSocket, command : string, serviceName : string, ...extraOptions : string[]) : Promise<number> {
        this.assertServiceExists(serviceName);

        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        return Terminal.exec(
            this.server,
            socket,
            terminalName,
            "docker",
            this.getComposeOptions(command, ...extraOptions, serviceName),
            this.path,
        );
    }

    async startService(socket: DockgeSocket, serviceName: string) {
        const exitCode = await this.execServiceCommand(socket, "up", serviceName, "-d");
        if (exitCode !== 0) {
            throw new Error(`Failed to start service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async stopService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const exitCode = await this.execServiceCommand(socket, "stop", serviceName);
        if (exitCode !== 0) {
            throw new Error(`Failed to stop service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async restartService(socket: DockgeSocket, serviceName: string): Promise<number> {
        this.assertServiceExists(serviceName);
        await this.validateComposeConfig();
        const exitCode = await this.execServiceCommand(socket, "up", serviceName, "-d", "--no-deps", "--force-recreate");
        if (exitCode !== 0) {
            throw new Error(`Failed to restart service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    /** Update only the selected service image and recreate its container. */
    async updateService(socket: DockgeSocket, serviceName: string): Promise<number> {
        this.assertServiceExists(serviceName);
        await this.validateComposeConfig();
        const definition = yaml.parse(this.composeYAML).services[serviceName];
        const builds = Boolean(definition.build);
        const code = builds
            ? await this.execServiceCommand(socket, "build", serviceName, "--pull")
            : await this.execServiceCommand(socket, "pull", serviceName);
        if (code !== 0) {
            throw new Error("Service image update failed; check the operation output.");
        }
        clearImageUpdateCache(readComposeImages(this.composeYAML));
        const exitCode = await this.execServiceCommand(socket, "up", serviceName, "-d", "--no-deps", "--force-recreate");
        if (exitCode !== 0) {
            throw new Error("Service update failed; check the operation output.");
        }
        return exitCode;
    }
}
