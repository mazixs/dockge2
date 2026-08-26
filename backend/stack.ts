import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml, { type Document, isMap, isSeq, parseDocument } from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import { emptyStackFileConfig, resolveStackFilePath, StackConfig } from "./stack-config";
import { classifyStackFile } from "../common/stack-files";
import type { SecretFileMeta, StackFileConfig, StackFileInventory } from "../common/types/stack";
import {
    ComposePsEntry,
    ContainerInstanceStatus,
    COMPOSE_PROJECT_LABEL,
    DockerPsRaw,
    fromDockerPs,
    normaliseInstance,
    readComposeServices,
    readOneShotServices,
    resolveComposePsStatus,
    resolveStackStatus,
    StackStatusIssue,
    StackStatusResult,
} from "../common/compose-status";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    CREATED_STACK,
    EXITED, getCombinedTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    RUNNING, TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import { spawn } from "./child-process";
import { Settings } from "./settings";

interface ComposeLsEntry {
    Name : string;
    Status : string;
    ConfigFiles? : string;
}

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    protected _composeYAML : string | undefined;
    protected _composeENV : string | undefined;
    protected _configFilePath?: string | undefined;
    protected _composeFileName: string = "compose.yaml";
    protected _issues : StackStatusIssue[] = [];
    protected _fileConfig : StackFileConfig = emptyStackFileConfig();
    protected _inventory? : StackFileInventory;
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

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
            return fs.existsSync(path.join(this.path, ".env")) ? [ ".env" ] : [];
        }

        return this._fileConfig.envFileNames.filter((fileName) => fs.existsSync(path.join(this.path, fileName)));
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

    async toJSON(endpoint : string) : Promise<object> {

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

        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
            // Only names, sizes and bindings of secrets, never their content
            files: {
                composeFileNames: inventory.composeFileNames,
                envFileNames: inventory.envFileNames,
                activeEnvFileName: this.activeEnvFileName,
                selectedEnvFileNames: inventory.config.envFileNames,
                secretFiles: inventory.secretFiles,
                needsComposeSelection: inventory.needsComposeSelection,
            },
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            issues: this._issues,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
        };
    }

    /**
     * Get the status of the stack from `docker compose ps --format json`
     */
    async ps() : Promise<object> {
        let res = await spawn("docker", this.getComposeOptions("ps", "--format", "json"), {
            cwd: this.path,
            encoding: "utf-8",
        });
        if (!res.stdout) {
            return {};
        }
        return JSON.parse(res.stdout.toString());
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
            try {
                this._composeYAML = fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, this.activeEnvFileName), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
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
     * Save the stack to the disk
     * @param isAdd
     */
    async save(isAdd : boolean) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
        }

        if (isAdd) {
            // A new stack starts with the compose file it was created with
            await StackConfig.setQuiet(this.name, {
                composeFileName: this._composeFileName,
                envFileNames: this.composeENV.trim() === "" ? [] : [ this.activeEnvFileName ],
                activeEnvFileName: this.composeENV.trim() === "" ? "" : this.activeEnvFileName,
                secretBindings: [],
            });
            await this.loadFileConfig();
        }

        // Write or overwrite the selected compose file
        fs.writeFileSync(await resolveStackFilePath(dir, this._composeFileName), this.composeYAML);

        // Write the active env file, but do not create an empty one for a stack that never had it
        const envPath = await resolveStackFilePath(dir, this.activeEnvFileName);
        const envContent = this.composeENV;
        const hasEnvFile = await fileExists(envPath);
        const shouldWriteEnv = hasEnvFile || envContent.trim() !== "";

        if (shouldWriteEnv) {
            await fsAsync.writeFile(envPath, envContent, "utf-8");
        }

        if (shouldWriteEnv && !this._fileConfig.envFileNames.includes(this.activeEnvFileName)) {
            // A newly created env file becomes part of the interpolation set
            const config = {
                ...this._fileConfig,
                envFileNames: [ ...this._fileConfig.envFileNames, this.activeEnvFileName ],
                activeEnvFileName: this.activeEnvFileName,
            };
            await StackConfig.setQuiet(this.name, config);
            this._fileConfig = config;
        }

        if (process.env.PUID && process.env.PGID) {
            const uid = Number(process.env.PUID);
            const gid = Number(process.env.PGID);
            fs.lchownSync(dir, uid, gid);
            fs.chownSync(path.join(dir, this._composeFileName), uid, gid);
            if (shouldWriteEnv) {
                fs.chownSync(envPath, uid, gid);
            }
        }
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to deploy, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async delete(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to delete, please check the terminal output for more information.");
        }

        // Remove the stack folder
        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        await StackConfig.removeQuiet(this.name);

        return exitCode;
    }

    async updateStatus() {
        let statusList = await Stack.getStatusList();
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
        let res = await spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return stackList;
        }

        let composeList : ComposeLsEntry[] = JSON.parse(res.stdout.toString());

        // Container states of every compose project, read in one Docker call
        const instanceMap = await this.getInstanceMap();

        for (let composeStack of composeList) {
            let stack = stackList.get(composeStack.Name);

            // This stack probably is not managed by Dockge, but we still want to show it
            if (!stack) {
                // Skip the dockge stack if it is not managed by Dockge
                if (composeStack.Name === "dockge") {
                    continue;
                }
                stack = new Stack(server, composeStack.Name);
                stackList.set(composeStack.Name, stack);
            }

            const detailed = this.resolveProjectStatus(composeStack, instanceMap, stack);
            stack._status = detailed.status;
            stack._issues = detailed.issues;
            stack._configFilePath = composeStack.ConfigFiles;
        }

        return stackList;
    }

    /**
     * Resolve the status of one compose project from the host wide container list
     * @param composeStack Entry of `docker compose ls`
     * @param instanceMap Containers grouped by project, null when Docker could not be read
     * @param stack Stack of the project, used to read its one-shot markings
     * @returns Status and issues of the project
     */
    static resolveProjectStatus(
        composeStack : ComposeLsEntry,
        instanceMap : Map<string, ComposePsEntry[]> | null,
        stack? : Stack,
    ) : StackStatusResult {
        if (!instanceMap) {
            // Docker output could not be trusted, do not claim the stack is stopped
            return { status: UNKNOWN,
                issues: [] };
        }

        const entries = instanceMap.get(composeStack.Name) ?? [];
        const composeYAML = stack?.isManagedByDockge ? stack.composeYAML : "";

        return resolveComposePsStatus(entries, readComposeServices(composeYAML), readOneShotServices(composeYAML));
    }

    /**
     * Get the status list, it will be used to update the status of the stacks
     * Not all status will be returned, only the stack that is deployed or created to `docker compose` will be returned
     */
    static async getStatusList() : Promise<Map<string, number>> {
        let statusList = new Map<string, number>();

        let res = await spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
            encoding: "utf-8",
        });

        if (!res.stdout) {
            return statusList;
        }

        let composeList : ComposeLsEntry[] = JSON.parse(res.stdout.toString());
        const instanceMap = await this.getInstanceMap();

        for (let composeStack of composeList) {
            statusList.set(composeStack.Name, this.resolveProjectStatus(composeStack, instanceMap).status);
        }

        return statusList;
    }

    /**
     * Convert the status string from `docker compose ls` to the status number
     * Input Example: "exited(1), running(1)"
     * @param status
     */
    static statusConvert(status : string) : number {
        if (status.startsWith("created")) {
            return CREATED_STACK;
        } else if (status.includes("exited")) {
            // If one of the service is exited, we consider the stack is exited
            return EXITED;
        } else if (status.startsWith("running")) {
            // If there is no exited services, there should be only running services
            return RUNNING;
        } else {
            return UNKNOWN;
        }
    }

    /**
     * Read every compose managed container of the host in a single Docker call.
     * One call keeps the 10 second status cron cheap even with many stacks.
     * @returns Entries grouped by compose project, or null when Docker output cannot be trusted
     */
    static async getInstanceMap() : Promise<Map<string, ComposePsEntry[]> | null> {
        try {
            const res = await spawn("docker", [
                "ps",
                "--all",
                "--filter",
                `label=${COMPOSE_PROJECT_LABEL}`,
                "--format",
                "json",
            ], {
                encoding: "utf-8",
                maxBuffer: 4 * 1024 * 1024,
                timeoutMs: 15_000,
            });

            if (!res.stdout) {
                return new Map();
            }

            const map = new Map<string, ComposePsEntry[]>();

            // Docker returns JSON Lines, one container per line
            for (const line of res.stdout.toString().split("\n")) {
                if (line.trim() === "") {
                    continue;
                }

                const entry = fromDockerPs(JSON.parse(line) as DockerPsRaw);
                if (!entry.project) {
                    continue;
                }

                const list = map.get(entry.project) ?? [];
                list.push(entry);
                map.set(entry.project, list);
            }

            return map;
        } catch (e) {
            if (e instanceof Error) {
                log.warn("getInstanceMap", `Failed to read containers: ${e.message}`);
            }
            return null;
        }
    }

    /**
     * Read the containers of this stack with the exact Compose fields, including Health and ExitCode
     * @returns Instances of the stack, or null when Docker output cannot be trusted
     */
    async getInstances() : Promise<ContainerInstanceStatus[] | null> {
        try {
            const res = await spawn("docker", this.getComposeOptions("ps", "--all", "--format", "json"), {
                cwd: this.path,
                encoding: "utf-8",
                maxBuffer: 4 * 1024 * 1024,
                timeoutMs: 15_000,
            });

            if (!res.stdout) {
                return [];
            }

            const entries : ComposePsEntry[] = [];

            // Compose writes either one JSON object per line or a single JSON array
            for (const line of res.stdout.toString().split("\n")) {
                if (line.trim() === "") {
                    continue;
                }

                const parsed = JSON.parse(line);
                if (Array.isArray(parsed)) {
                    entries.push(...parsed as ComposePsEntry[]);
                } else {
                    entries.push(parsed as ComposePsEntry);
                }
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
        const globalOptions : string[] = [];

        // The global env file stays the outermost source, stack files override it
        if (fs.existsSync(path.join(this.server.stacksDir, "global.env"))) {
            globalOptions.push("--env-file", "../global.env");
        }

        for (const fileName of this.envFileNames) {
            globalOptions.push("--env-file", "./" + fileName);
        }

        if (this._composeFileName) {
            globalOptions.push("-f", this._composeFileName);
        }

        const options = [ "compose", ...globalOptions, command, ...extraOptions ];
        log.debug("getComposeOptions", options);
        return options;
    }

    async start(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to start, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("stop"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to stop, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("restart"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
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
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("pull"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }

        // If the stack is not running, we don't need to restart it
        await this.updateStatus();
        log.debug("update", "Status: " + this.status);
        if (this.status !== RUNNING) {
            return exitCode;
        }

        exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
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

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            terminal = new InteractiveTerminal(this.server, terminalName, "docker", this.getComposeOptions("exec", serviceName, shell), this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    /**
     * Group the containers of this stack by service, with the typed state of every instance
     * @returns Instances grouped by service name
     */
    async getServiceStatusList() : Promise<Map<string, ContainerInstanceStatus[]>> {
        const statusList = new Map<string, ContainerInstanceStatus[]>();
        const instances = await this.getInstances();

        if (!instances) {
            return statusList;
        }

        for (const instance of instances) {
            const list = statusList.get(instance.service) ?? [];
            list.push(instance);
            statusList.set(instance.service, list);
        }

        return statusList;
    }

    /**
     * Apply a new file selection after validating it against the directory
     * @param config Selection coming from the UI
     * @returns The stored selection
     */
    async setFileConfig(config : StackFileConfig) : Promise<StackFileConfig> {
        const dir = this.path;
        const validated = await StackConfig.validate(dir, config);

        await StackConfig.set(this.name, validated);
        await this.loadFileConfig();

        // Drop cached texts, the selected files may be different now
        this._composeYAML = undefined;
        this._composeENV = undefined;

        return validated;
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

        const filePath = await resolveStackFilePath(this.path, fileName);
        await fsAsync.writeFile(filePath, content, "utf-8");

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
     * Read the content of a secret file.
     * The caller has to authorise this separately, it is not part of the stack response.
     * @param fileName Secret file inside the stack directory
     * @returns File content
     */
    async readSecretFile(fileName : string) : Promise<string> {
        if (classifyStackFile(fileName) !== "secret") {
            throw new ValidationError("Not a secret file: " + fileName);
        }

        const filePath = await resolveStackFilePath(this.path, fileName);

        try {
            return await fsAsync.readFile(filePath, "utf-8");
        } catch (e) {
            throw new ValidationError("Secret file not found: " + fileName);
        }
    }

    /**
     * Create or replace a secret file with restrictive permissions
     * @param fileName Secret file inside the stack directory
     * @param content New content
     */
    async writeSecretFile(fileName : string, content : string) : Promise<void> {
        if (classifyStackFile(fileName) !== "secret") {
            throw new ValidationError("Not a secret file: " + fileName);
        }

        const filePath = await resolveStackFilePath(this.path, fileName);

        // mode is applied on creation, chmod covers an existing file
        await fsAsync.writeFile(filePath, content, {
            encoding: "utf-8",
            mode: 0o600,
        });

        if (process.platform !== "win32") {
            await fsAsync.chmod(filePath, 0o600);

            if (process.env.PUID && process.env.PGID) {
                const uid = Number(process.env.PUID);
                const gid = Number(process.env.PGID);
                if (Number.isInteger(uid) && Number.isInteger(gid)) {
                    await fsAsync.chown(filePath, uid, gid);
                }
            }
        } else {
            log.warn("writeSecretFile", "File permissions cannot be restricted on Windows, the file inherits the directory ACL");
        }
    }

    /**
     * Delete a secret file and its binding
     * @param fileName Secret file inside the stack directory
     */
    async deleteSecretFile(fileName : string) : Promise<void> {
        if (classifyStackFile(fileName) !== "secret") {
            throw new ValidationError("Not a secret file: " + fileName);
        }

        const filePath = await resolveStackFilePath(this.path, fileName);
        await fsAsync.rm(filePath, { force: true });

        const binding = this._fileConfig.secretBindings.find((item) => item.fileName === fileName);
        if (binding) {
            await this.unbindSecret(binding.name);
        }
    }

    /**
     * Serialise a compose document after an explicit structural edit.
     * `flowCollectionPadding` is disabled so untouched inline arrays such as
     * `["sh", "-c", "..."]` keep the spacing Compose files normally use.
     * Task 5 of the plan replaces this with real source preservation.
     * @param doc Parsed compose document
     * @returns YAML text
     */
    protected serialiseComposeDocument(doc : Document) : string {
        return doc.toString({ flowCollectionPadding: false });
    }

    /**
     * Reference a secret file from the compose file, only on an explicit user action.
     * The compose document is edited in place, so comments and formatting survive.
     * @param secretName Compose secret name
     * @param fileName Secret file inside the stack directory
     * @param services Services that get access to the secret
     */
    async bindSecret(secretName : string, fileName : string, services : readonly string[]) : Promise<void> {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(secretName)) {
            throw new ValidationError("Invalid secret name: " + secretName);
        }

        if (classifyStackFile(fileName) !== "secret") {
            throw new ValidationError("Not a secret file: " + fileName);
        }

        const filePath = await resolveStackFilePath(this.path, fileName);
        await fsAsync.access(filePath).catch(() => {
            throw new ValidationError("Secret file not found: " + fileName);
        });

        const doc = parseDocument(this.composeYAML);
        const declaredServices = readComposeServices(this.composeYAML);

        for (const service of services) {
            if (!declaredServices.includes(service)) {
                throw new ValidationError("Unknown service: " + service);
            }
        }

        doc.setIn([ "secrets", secretName, "file" ], "./" + fileName);

        for (const service of services) {
            const current = doc.getIn([ "services", service, "secrets" ]);
            const list = isSeq(current) ? current.toJSON() as string[] : [];

            if (!list.includes(secretName)) {
                list.push(secretName);
            }

            doc.setIn([ "services", service, "secrets" ], list);
        }

        const composeYAML = this.serialiseComposeDocument(doc);
        fs.writeFileSync(await resolveStackFilePath(this.path, this._composeFileName), composeYAML);
        this._composeYAML = composeYAML;

        const bindings = this._fileConfig.secretBindings.filter((item) => item.name !== secretName);
        bindings.push({
            name: secretName,
            fileName,
            services: [ ...services ],
        });

        const config = {
            ...this._fileConfig,
            secretBindings: bindings,
        };
        await StackConfig.set(this.name, config);
        this._fileConfig = config;
    }

    /**
     * Remove a secret reference from the compose file and from the stored bindings
     * @param secretName Compose secret name
     */
    async unbindSecret(secretName : string) : Promise<void> {
        const doc = parseDocument(this.composeYAML);
        let changed = false;

        if (doc.hasIn([ "secrets", secretName ])) {
            doc.deleteIn([ "secrets", secretName ]);
            changed = true;
        }

        const secretsNode = doc.getIn([ "secrets" ]);
        if (isMap(secretsNode) && secretsNode.items.length === 0) {
            doc.deleteIn([ "secrets" ]);
        }

        for (const service of readComposeServices(this.composeYAML)) {
            const current = doc.getIn([ "services", service, "secrets" ]);
            if (!isSeq(current)) {
                continue;
            }

            const list = (current.toJSON() as string[]).filter((item) => item !== secretName);

            if (list.length === (current.toJSON() as string[]).length) {
                continue;
            }

            changed = true;

            if (list.length === 0) {
                doc.deleteIn([ "services", service, "secrets" ]);
            } else {
                doc.setIn([ "services", service, "secrets" ], list);
            }
        }

        if (changed) {
            const composeYAML = this.serialiseComposeDocument(doc);
            fs.writeFileSync(await resolveStackFilePath(this.path, this._composeFileName), composeYAML);
            this._composeYAML = composeYAML;
        }

        const config = {
            ...this._fileConfig,
            secretBindings: this._fileConfig.secretBindings.filter((item) => item.name !== secretName),
        };
        await StackConfig.set(this.name, config);
        this._fileConfig = config;
    }

    async startService(socket: DockgeSocket, serviceName: string) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", serviceName ], this.path);
        if (exitCode !== 0) {
            throw new Error(`Failed to start service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async stopService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "stop", serviceName ], this.path);
        if (exitCode !== 0) {
            throw new Error(`Failed to stop service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async restartService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "restart", serviceName ], this.path);
        if (exitCode !== 0) {
            throw new Error(`Failed to restart service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }
}
