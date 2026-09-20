import fs, { promises as fsAsync } from "fs";
import path from "path";
import { classifyStackFile, isSafeNameSegment, isSafeStackFileName, looksLikeStackFile, pickDefaultComposeFile } from "../common/stack-files";
import type { SecretFileMeta, StackFileConfig, StackFileInventory } from "../common/types/stack";
import { log } from "./log";
import { Settings } from "./settings";
import { ValidationError } from "./util-server";

/** Settings key holding the file selection of every stack */
export const STACK_FILES_SETTING_KEY = "stackFiles";

/** Settings type, so the general settings screen cannot overwrite this entry */
export const STACK_FILES_SETTING_TYPE = "stackFiles";

/** Control characters never reach the screen: a name only ever becomes text there */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * Resolve a file of a stack directory and make sure it stays inside it.
 * This is the single barrier for every read, write and Compose argument.
 * @param stackDir Directory of the stack, already validated by Stack.getSafePath()
 * @param fileName Plain file name inside the directory
 * @returns Absolute path of the file
 * @throws {ValidationError} If the name is not accepted or escapes the directory
 */
export async function resolveStackFilePath(stackDir : string, fileName : string) : Promise<string> {
    const resolved = resolveStackFilePathLexically(stackDir, fileName);

    // The directory itself must not be a symlink either, otherwise a write inside it
    // lands wherever the link points
    try {
        const dirStat = await fsAsync.lstat(path.resolve(stackDir));
        if (dirStat.isSymbolicLink()) {
            throw new ValidationError("The stack directory is a symbolic link");
        }
    } catch (e) {
        if (e instanceof ValidationError) {
            throw e;
        }
        // A directory that does not exist yet is created by the caller
    }

    // A symlink could point anywhere, so an existing one is rejected
    try {
        const stat = await fsAsync.lstat(resolved);
        assertRegularFile(stat.isSymbolicLink(), stat.isDirectory(), fileName);
    } catch (e) {
        if (e instanceof ValidationError) {
            throw e;
        }
        // Not existing yet is fine, the caller decides whether it has to exist
    }

    return resolved;
}

/**
 * Same barrier as resolveStackFilePath(), for the synchronous read paths.
 * @param stackDir Directory of the stack
 * @param fileName Plain file name inside the directory
 * @returns Absolute path of the file
 * @throws {ValidationError} If the name is not accepted or a symlink is involved
 */
export function resolveStackFilePathSync(stackDir : string, fileName : string) : string {
    const resolved = resolveStackFilePathLexically(stackDir, fileName);

    try {
        const dirStat = fs.lstatSync(path.resolve(stackDir));
        if (dirStat.isSymbolicLink()) {
            throw new ValidationError("The stack directory is a symbolic link");
        }
    } catch (e) {
        if (e instanceof ValidationError) {
            throw e;
        }
    }

    try {
        const stat = fs.lstatSync(resolved);
        assertRegularFile(stat.isSymbolicLink(), stat.isDirectory(), fileName);
    } catch (e) {
        if (e instanceof ValidationError) {
            throw e;
        }
    }

    return resolved;
}

/**
 * Check the name and build the path without touching the filesystem
 * @param stackDir Directory of the stack
 * @param fileName Plain file name inside the directory
 * @returns Absolute path of the file
 * @throws {ValidationError} If the name is not accepted or escapes the directory
 */
function resolveStackFilePathLexically(stackDir : string, fileName : string) : string {
    if (!isSafeStackFileName(fileName)) {
        throw new ValidationError("Invalid file name: " + fileName);
    }

    const base = path.resolve(stackDir);
    const resolved = path.resolve(base, fileName);
    const relative = path.relative(base, resolved);

    if (relative !== fileName || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new ValidationError("File is outside the stack directory: " + fileName);
    }

    return resolved;
}

/**
 * Reject anything that is not a regular file
 * @param isSymbolicLink Whether the entry is a symlink
 * @param isDirectory Whether the entry is a directory
 * @param fileName Name used in the error message
 * @throws {ValidationError} If the entry cannot be used as a stack file
 */
function assertRegularFile(isSymbolicLink : boolean, isDirectory : boolean, fileName : string) : void {
    if (isSymbolicLink) {
        throw new ValidationError("File is outside the stack directory: " + fileName);
    }

    if (isDirectory) {
        throw new ValidationError("Expected a file, not a directory: " + fileName);
    }
}

/**
 * Empty configuration used before anything is known about a stack
 * @returns Empty config
 */
export function emptyStackFileConfig() : StackFileConfig {
    return {
        composeFileName: "",
        envFileNames: [],
        activeEnvFileName: "",
        secretBindings: [],
    };
}

export class StackConfig {

    /**
     * Read the stored selection of every stack
     * @returns Config per stack name
     */
    static async getAll() : Promise<Record<string, StackFileConfig>> {
        let stored : unknown;

        try {
            stored = await Settings.get(STACK_FILES_SETTING_KEY);
        } catch (e) {
            // The files on disk are the source of truth, missing metadata must not break a stack
            if (e instanceof Error) {
                log.debug("stack-config", "Cannot read the stack file selection: " + e.message);
            }
            return {};
        }

        if (!stored || typeof stored !== "object") {
            return {};
        }

        // Settings.get() hands out the cached object, so a copy is made before anyone edits it
        return structuredClone(stored) as Record<string, StackFileConfig>;
    }

    /**
     * Read the stored selection of one stack
     * @param stackName Stack name
     * @returns Stored config, or null when the stack has none yet
     */
    static async get(stackName : string) : Promise<StackFileConfig | null> {
        const all = await this.getAll();
        return all[stackName] ?? null;
    }

    /**
     * Store the selection of one stack
     * @param stackName Stack name
     * @param config Selection to store
     */
    static async set(stackName : string, config : StackFileConfig) : Promise<void> {
        const all = await this.getAll();
        all[stackName] = config;
        await Settings.set(STACK_FILES_SETTING_KEY, all, STACK_FILES_SETTING_TYPE);
    }

    /**
     * Forget the selection of a stack, used when the stack is deleted
     * @param stackName Stack name
     */
    static async remove(stackName : string) : Promise<void> {
        const all = await this.getAll();

        if (!(stackName in all)) {
            return;
        }

        delete all[stackName];
        await Settings.set(STACK_FILES_SETTING_KEY, all, STACK_FILES_SETTING_TYPE);
    }

    /**
     * Store a selection without failing when the database is unavailable.
     * Used by paths whose real goal is writing files, not metadata.
     * @param stackName Stack name
     * @param config Selection to store
     * @returns Whether the selection could be stored
     */
    static async setQuiet(stackName : string, config : StackFileConfig) : Promise<boolean> {
        try {
            await this.set(stackName, config);
            return true;
        } catch (e) {
            if (e instanceof Error) {
                log.warn("stack-config", `Cannot store the file selection of ${stackName}: ${e.message}`);
            }
            return false;
        }
    }

    /**
     * Forget a selection without failing when the database is unavailable
     * @param stackName Stack name
     * @returns Whether the selection could be removed
     */
    static async removeQuiet(stackName : string) : Promise<boolean> {
        try {
            await this.remove(stackName);
            return true;
        } catch (e) {
            if (e instanceof Error) {
                log.warn("stack-config", `Cannot forget the file selection of ${stackName}: ${e.message}`);
            }
            return false;
        }
    }

    /**
     * Validate a selection against the files that really exist in the directory
     * @param stackDir Stack directory
     * @param config Selection to validate
     * @returns The validated selection with duplicates removed
     * @throws {ValidationError} If a name is unsafe, of the wrong kind or missing on disk
     */
    static async validate(stackDir : string, config : StackFileConfig) : Promise<StackFileConfig> {
        const composePath = await resolveStackFilePath(stackDir, config.composeFileName);

        if (classifyStackFile(config.composeFileName) !== "compose") {
            throw new ValidationError("Not a compose file: " + config.composeFileName);
        }

        await fsAsync.access(composePath).catch(() => {
            throw new ValidationError("Compose file not found: " + config.composeFileName);
        });

        const envFileNames : string[] = [];

        for (const fileName of config.envFileNames) {
            if (classifyStackFile(fileName) !== "env") {
                throw new ValidationError("Not an env file: " + fileName);
            }

            const envPath = await resolveStackFilePath(stackDir, fileName);
            await fsAsync.access(envPath).catch(() => {
                throw new ValidationError("Env file not found: " + fileName);
            });

            if (!envFileNames.includes(fileName)) {
                envFileNames.push(fileName);
            }
        }

        let activeEnvFileName = config.activeEnvFileName;

        if (activeEnvFileName !== "") {
            if (classifyStackFile(activeEnvFileName) !== "env") {
                throw new ValidationError("Not an env file: " + activeEnvFileName);
            }
            await resolveStackFilePath(stackDir, activeEnvFileName);

            // Editing a file that compose never reads would silently do nothing
            if (!envFileNames.includes(activeEnvFileName)) {
                envFileNames.push(activeEnvFileName);
            }
        }

        const secretBindings = [];

        for (const binding of config.secretBindings) {
            if (classifyStackFile(binding.fileName) !== "secret") {
                throw new ValidationError("Not a secret file: " + binding.fileName);
            }
            await resolveStackFilePath(stackDir, binding.fileName);

            if (!isSafeNameSegment(binding.name)) {
                throw new ValidationError("Invalid secret name: " + binding.name);
            }

            secretBindings.push({
                name: binding.name,
                fileName: binding.fileName,
                services: [ ...binding.services ],
            });
        }

        return {
            composeFileName: config.composeFileName,
            envFileNames,
            activeEnvFileName,
            secretBindings,
        };
    }

    /**
     * What lies in the stack directory, by kind.
     *
     * A symlink is never a stack file: it could point anywhere. A name that was refused
     * is reported rather than dropped, because the file is visible on disk and a screen
     * that never mentions it looks broken.
     * @param stackDir Stack directory
     * @returns The names found, sorted, in four groups
     */
    private static async scan(stackDir : string) : Promise<{ composeFileNames : string[]; envFileNames : string[]; secretFileNames : string[]; unsupportedFileNames : string[] }> {
        const composeFileNames : string[] = [];
        const envFileNames : string[] = [];
        const secretFileNames : string[] = [];
        const unsupportedFileNames : string[] = [];
        let entries : string[] = [];

        try {
            entries = await fsAsync.readdir(stackDir);
        } catch (e) {
            // A stack that is not managed by Dockge has no directory here
        }

        for (const entry of entries) {
            let stat;

            try {
                stat = await fsAsync.lstat(path.join(stackDir, entry));

                if (stat.isSymbolicLink()) {
                    continue;
                }
            } catch (e) {
                continue;
            }

            switch (classifyStackFile(entry)) {
                case "compose":
                    composeFileNames.push(entry);
                    break;
                case "env":
                    envFileNames.push(entry);
                    break;
                case "secret":
                    secretFileNames.push(entry);
                    break;
                default:
                    // Control characters are stripped, the name only ever becomes text
                    if (stat.isFile() && looksLikeStackFile(entry)) {
                        unsupportedFileNames.push(entry.replace(CONTROL_CHARACTERS, ""));
                    }
                    break;
            }
        }

        composeFileNames.sort();
        envFileNames.sort();
        secretFileNames.sort();
        unsupportedFileNames.sort();
        return { composeFileNames,
            envFileNames,
            secretFileNames,
            unsupportedFileNames };
    }

    /**
     * Which of the files that are there the stack actually uses.
     *
     * A stored choice survives as long as the file it names is still on disk; nothing is
     * added on its own, except for the historic `.env` of a stack that never had any
     * metadata.
     * @param stored What was chosen before, if anything ever was
     * @param found What lies in the directory now
     * @returns The selection in force
     */
    private static resolveConfig(stored : StackFileConfig | null, found : { composeFileNames : string[]; envFileNames : string[]; secretFileNames : string[] }) : StackFileConfig {
        const config = emptyStackFileConfig();

        // Compose file: keep the stored choice while the file is still there
        if (stored?.composeFileName && found.composeFileNames.includes(stored.composeFileName)) {
            config.composeFileName = stored.composeFileName;
        } else {
            config.composeFileName = pickDefaultComposeFile(found.composeFileNames);
        }

        // Env files: stored order first, then nothing else is added on its own
        if (stored) {
            config.envFileNames = stored.envFileNames.filter((name) => found.envFileNames.includes(name));
            config.activeEnvFileName = found.envFileNames.includes(stored.activeEnvFileName) ? stored.activeEnvFileName : "";
            config.secretBindings = stored.secretBindings.filter((binding) => found.secretFileNames.includes(binding.fileName));
        }

        // A stack that never had metadata keeps the historic behaviour of using .env
        if (!stored && found.envFileNames.includes(".env")) {
            config.envFileNames = [ ".env" ];
            config.activeEnvFileName = ".env";
        }

        if (config.activeEnvFileName === "" && config.envFileNames.length > 0) {
            config.activeEnvFileName = config.envFileNames[0] ?? "";
        }
        return config;
    }

    /**
     * Describe the secret files without reading a single byte of them
     * @param stackDir Stack directory
     * @param secretFileNames Files classified as secrets
     * @param config The selection in force, which says what each file is bound to
     * @returns Metadata of every secret file
     */
    private static async describeSecrets(stackDir : string, secretFileNames : string[], config : StackFileConfig) : Promise<SecretFileMeta[]> {
        const secretFiles : SecretFileMeta[] = [];

        for (const fileName of secretFileNames) {
            const binding = config.secretBindings.find((item) => item.fileName === fileName);
            let size = 0;
            let modifiedAt = "";

            try {
                // lstat, so a swapped symlink cannot report the size of its target
                const stat = await fsAsync.lstat(path.join(stackDir, fileName));

                size = stat.size;
                modifiedAt = stat.mtime.toISOString();
            } catch (e) {
                // The file disappeared between readdir and stat
            }

            secretFiles.push({
                fileName,
                secretName: binding?.name ?? "",
                size,
                modifiedAt,
                services: binding?.services ?? [],
            });
        }
        return secretFiles;
    }

    /**
     * Read the directory and combine what is there with the stored selection.
     * Stacks created before this feature keep working: a single compose file is adopted
     * silently, several files keep a deterministic choice and ask the UI for a decision.
     * @param stackDir Stack directory
     * @param stackName Stack name
     * @returns Inventory of the stack files
     */
    static async inventory(stackDir : string, stackName : string) : Promise<StackFileInventory> {
        const found = await this.scan(stackDir);
        const stored = await this.get(stackName);
        const config = this.resolveConfig(stored, found);

        return {
            config,
            composeFileNames: found.composeFileNames,
            envFileNames: found.envFileNames,
            secretFiles: await this.describeSecrets(stackDir, found.secretFileNames, config),
            needsComposeSelection: found.composeFileNames.length > 1 && !stored?.composeFileName,
            unsupportedFileNames: found.unsupportedFileNames,
        };
    }
}
