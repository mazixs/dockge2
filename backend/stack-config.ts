import { promises as fsAsync } from "fs";
import path from "path";
import { classifyStackFile, isSafeStackFileName, pickDefaultComposeFile } from "../common/stack-files";
import type { SecretFileMeta, StackFileConfig, StackFileInventory } from "../common/types/stack";
import { Settings } from "./settings";
import { ValidationError } from "./util-server";

/** Settings key holding the file selection of every stack */
export const STACK_FILES_SETTING_KEY = "stackFiles";

/** Settings type, so the general settings screen cannot overwrite this entry */
export const STACK_FILES_SETTING_TYPE = "stackFiles";

/**
 * Resolve a file of a stack directory and make sure it stays inside it.
 * This is the single barrier for every read, write and Compose argument.
 * @param stackDir Directory of the stack, already validated by Stack.getSafePath()
 * @param fileName Plain file name inside the directory
 * @returns Absolute path of the file
 * @throws {ValidationError} If the name is not accepted or escapes the directory
 */
export async function resolveStackFilePath(stackDir : string, fileName : string) : Promise<string> {
    if (!isSafeStackFileName(fileName)) {
        throw new ValidationError("Invalid file name: " + fileName);
    }

    const base = path.resolve(stackDir);
    const resolved = path.resolve(base, fileName);
    const relative = path.relative(base, resolved);

    if (relative !== fileName || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new ValidationError("File is outside the stack directory: " + fileName);
    }

    // A symlink could point anywhere, so an existing one is rejected
    try {
        const stat = await fsAsync.lstat(resolved);
        if (stat.isSymbolicLink()) {
            throw new ValidationError("File is outside the stack directory: " + fileName);
        }
        if (stat.isDirectory()) {
            throw new ValidationError("Expected a file, not a directory: " + fileName);
        }
    } catch (e) {
        if (e instanceof ValidationError) {
            throw e;
        }
        // Not existing yet is fine, the caller decides whether it has to exist
    }

    return resolved;
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
        const stored = await Settings.get(STACK_FILES_SETTING_KEY);

        if (!stored || typeof stored !== "object") {
            return {};
        }

        return stored as Record<string, StackFileConfig>;
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
        }

        const secretBindings = [];

        for (const binding of config.secretBindings) {
            if (classifyStackFile(binding.fileName) !== "secret") {
                throw new ValidationError("Not a secret file: " + binding.fileName);
            }
            await resolveStackFilePath(stackDir, binding.fileName);

            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(binding.name)) {
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
     * Read the directory and combine what is there with the stored selection.
     * Stacks created before this feature keep working: a single compose file is adopted
     * silently, several files keep a deterministic choice and ask the UI for a decision.
     * @param stackDir Stack directory
     * @param stackName Stack name
     * @returns Inventory of the stack files
     */
    static async inventory(stackDir : string, stackName : string) : Promise<StackFileInventory> {
        const composeFileNames : string[] = [];
        const envFileNames : string[] = [];
        const secretFileNames : string[] = [];

        let entries : string[] = [];
        try {
            entries = await fsAsync.readdir(stackDir);
        } catch (e) {
            // A stack that is not managed by Dockge has no directory here
        }

        for (const entry of entries) {
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
                    break;
            }
        }

        composeFileNames.sort();
        envFileNames.sort();
        secretFileNames.sort();

        const stored = await this.get(stackName);
        const config = emptyStackFileConfig();

        // Compose file: keep the stored choice while the file is still there
        if (stored?.composeFileName && composeFileNames.includes(stored.composeFileName)) {
            config.composeFileName = stored.composeFileName;
        } else {
            config.composeFileName = pickDefaultComposeFile(composeFileNames);
        }

        // Env files: stored order first, then nothing else is added on its own
        if (stored) {
            config.envFileNames = stored.envFileNames.filter((name) => envFileNames.includes(name));
            config.activeEnvFileName = envFileNames.includes(stored.activeEnvFileName) ? stored.activeEnvFileName : "";
            config.secretBindings = stored.secretBindings.filter((binding) => secretFileNames.includes(binding.fileName));
        }

        // A stack that never had metadata keeps the historic behaviour of using .env
        if (!stored && envFileNames.includes(".env")) {
            config.envFileNames = [ ".env" ];
            config.activeEnvFileName = ".env";
        }

        if (config.activeEnvFileName === "" && config.envFileNames.length > 0) {
            config.activeEnvFileName = config.envFileNames[0] ?? "";
        }

        const secretFiles : SecretFileMeta[] = [];

        for (const fileName of secretFileNames) {
            const binding = config.secretBindings.find((item) => item.fileName === fileName);
            let size = 0;
            let modifiedAt = "";

            try {
                const stat = await fsAsync.stat(path.join(stackDir, fileName));
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

        return {
            config,
            composeFileNames,
            envFileNames,
            secretFiles,
            needsComposeSelection: composeFileNames.length > 1 && !stored?.composeFileName,
        };
    }
}
