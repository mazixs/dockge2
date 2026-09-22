import { promises as fs, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { BoundedCache } from "./bounded-cache";
import { runGit } from "./git-command";
import { clearStackSourceCache } from "./stack-source";
import type { GitApplyInput, GitCloneInput, GitPreviewFile, GitUpdatePreview } from "../common/types/stack-git";
import type { StackFileConfig } from "../common/types/stack";
import { gitRepositoryProblem } from "../common/git-repository";
import { stackLockBusy, withStackLock } from "./stack-lock";

import { acceptedComposeFileNames } from "../common/util-common";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 1000;
const PREVIEW_MS = 10 * 60 * 1000;
const MAX_BRANCHES = 500;
// Two 20 MiB trees plus UTF-16 comparison text and a bounded index fit one preview.
const PREVIEW_BUDGET = 128 * 1024 * 1024;
let buildingPreview = false;

type FileState = { bytes: Buffer; mode: number };
type FileTree = Map<string, FileState>;

interface StoredPreview {
    owner: symbol;
    dir: string;
    createdAt: number;
    public: GitUpdatePreview;
    before: FileTree;
    target: FileTree;
    config: StackFileConfig;
    index: Buffer;
}

const storedPreviews = new BoundedCache<StoredPreview>(PREVIEW_BUDGET, 10, PREVIEW_MS);

/** Release retained comparisons when their directory is deleted. */
export function discardStackGitPreviews(dir: string): void {
    for (const [ id, item ] of storedPreviews.entries()) {
        if (item.dir === dir) {
            storedPreviews.delete(id);
        }
    }
}

/** A valid bounded working tree cannot need an unbounded Git index allocation. */
async function readIndex(dir: string): Promise<Buffer> {
    const handle = await fs.open(path.join(dir, ".git/index"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
        let size = 0;
        while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
            if (bytesRead === 0) {
                break;
            }
            size += bytesRead;
        }
        if (size === buffer.length) {
            throw new StackGitError("gitRepositoryTooLarge");
        }
        return Buffer.from(buffer.subarray(0, size));
    } finally {
        await handle.close();
    }
}

export interface GitWorkflowOptions {
    /** Only isolated unit tests may opt into a local transport. Never set from a socket. */
    allowLocalTransport?: boolean;
    validate: (directory: string, config: StackFileConfig) => Promise<void>;
    /** Test injection for a filesystem failure after earlier writes. */
    beforeWrite?: (fileName: string) => Promise<void>;
}

/**
 * A safe message that never incorporates subprocess output or repository file contents.
 *
 * The message is a catalogue key, not a sentence: the panel and the agent may be running
 * in different languages, and only the browser knows which one the reader chose.
 */
export class StackGitError extends Error {
    /** Values the catalogue entry interpolates, when it takes any. */
    readonly values? : Record<string, string>;

    /**
     * @param key Catalogue key describing what went wrong
     * @param values Values the entry interpolates
     */
    constructor(key : string, values? : Record<string, string>) {
        super(key);
        if (values) {
            this.values = values;
        }
    }
}

/**
 * Whether a validation failure still allows the files to be saved.
 *
 * The workflow knows nothing about Compose; the validator is the one that can tell an
 * unfinished environment from a file that cannot be read, and says so on the error.
 * @param error Error thrown by the configured validator
 * @returns True when the files may be published despite the failure
 */
function isDeferrable(error: unknown): error is StackGitError {
    return error instanceof StackGitError && (error as { deferrable?: unknown }).deferrable === true;
}

/** Check relative paths from Git before they become filesystem paths. */
function safePath(name: string): void {
    if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || path.isAbsolute(name)) {
        throw new StackGitError("gitUnsafeFilePath");
    }
}

/**
 * Enforce the address rule, saying which half of it the address failed.
 *
 * The rule itself is shared with the creation page, so a button that is enabled
 * means the server will accept what it sends.
 * @param repository Address supplied by the user
 * @param allowLocal Whether a local path counts as a remote; tests only
 * @throws {StackGitError} When the address cannot be used
 */
export function validateGitRepository(repository: string, allowLocal = false): void {
    const problem = gitRepositoryProblem(repository, allowLocal);

    if (problem === "shape") {
        throw new StackGitError("gitInvalidRepositoryAddress");
    }

    if (problem) {
        throw new StackGitError("gitAddressMustNotCarryCredentials");
    }
}

/** Capture only bounded regular files, refusing symlinks even inside nested folders. */
async function snapshot(dir: string): Promise<FileTree> {
    const root = await fs.lstat(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new StackGitError("gitStackPathMustBeDirectory");
    }
    const result: FileTree = new Map();
    let size = 0;
    async function walk(prefix: string): Promise<void> {
        for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
            if (!prefix && entry.name === ".git") {
                continue;
            }
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            safePath(name);
            if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
                throw new StackGitError("gitSymlinksNotSupported");
            }
            if (entry.isDirectory()) {
                await walk(name);
                continue;
            }
            const stat = await fs.lstat(path.join(dir, name));
            if (stat.size > MAX_FILE_BYTES || (size += stat.size) > MAX_BYTES || result.size >= MAX_FILES) {
                throw new StackGitError("gitRepositoryTooLarge");
            }
            const handle = await fs.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const current = await handle.stat();
                if (current.ino !== stat.ino || !current.isFile()) {
                    throw new StackGitError("gitFilesChangedDuringCheck");
                }
                const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead > MAX_FILE_BYTES || current.size !== bytesRead) {
                    throw new StackGitError("gitFileSizeChangedDuringCheck");
                }
                result.set(name, { bytes: Buffer.from(buffer.subarray(0, bytesRead)),
                    mode: stat.mode & 0o777 });
            } finally {
                await handle.close();
            }
        }
    }
    await walk("");
    return result;
}

function equalFile(a?: FileState, b?: FileState): boolean {
    return (!a && !b) || (!!a && !!b && a.bytes.equals(b.bytes) && (a.mode & 0o111) === (b.mode & 0o111));
}

function sameTree(a: FileTree, b: FileTree): boolean {
    return a.size === b.size && [ ...a ].every(([ name, file ]) => equalFile(file, b.get(name)));
}

/** Digest the intended exact tree, including preserved permission bits, without rereading disk. */
function treeHash(tree: FileTree): string {
    const hash = createHash("sha256");
    for (const [ name, file ] of [ ...tree ].sort(([ a ], [ b ]) => a < b ? -1 : a > b ? 1 : 0)) {
        hash.update(JSON.stringify([ name, file.mode, file.bytes.length ])).update(file.bytes);
    }
    return hash.digest("hex");
}

/** Materialize a new directory with the exact bytes approved by the user. */
async function writeTree(dir: string, tree: FileTree): Promise<void> {
    for (const [ name, file ] of tree) {
        await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await fs.writeFile(path.join(dir, name), file.bytes, { flag: "wx",
            mode: file.mode });
        await fs.chmod(path.join(dir, name), file.mode);
    }
}

/** Return an entire file as hidden when it might contain credentials. */
/**
 * Check that the choice covers exactly the files that were compared.
 *
 * A comparison the browser did not see in full, or an answer for a file nobody offered,
 * means the two sides are talking about different states of the directory.
 * @param preview Comparison the choice was made on
 * @param input What the browser chose
 * @returns {void}
 */
function assertChoices(preview: StoredPreview, input: GitApplyInput): void {
    if (!input.choices || typeof input.choices !== "object" || Array.isArray(input.choices)) {
        throw new StackGitError("gitChooseResultForEveryFile");
    }
    if (Object.keys(input.choices).length !== preview.public.files.length) {
        throw new StackGitError("gitChooseResultForEveryFile");
    }
    for (const file of preview.public.files) {
        if (!Object.hasOwn(input.choices, file.path) || ![ "server", "git", "edited" ].includes(input.choices[file.path]!)) {
            throw new StackGitError("gitChooseResultForEveryFile");
        }
    }
}

/**
 * Check the texts offered in place of both versions.
 *
 * Only a file the user was shown as text may be typed over: a redacted or binary file
 * has no text to edit, and bytes that do not survive a round trip through UTF-8 would be
 * written back as something else than what was on the screen.
 * @param preview Comparison the choice was made on
 * @param input What the browser chose
 * @returns {void}
 */
function assertEditedResults(preview: StoredPreview, input: GitApplyInput): void {
    const edited = input.editedContents ?? {};

    if (typeof edited !== "object" || Array.isArray(edited)) {
        throw new StackGitError("gitInvalidEditedResults");
    }
    for (const name of Object.keys(edited)) {
        if (!preview.public.files.some((file) => file.path === name && input.choices[name] === "edited")) {
            throw new StackGitError("gitInvalidEditedResults");
        }
    }
    for (const file of preview.public.files) {
        if (input.choices[file.path] !== "edited") {
            continue;
        }
        const content = edited[file.path];

        if (file.redacted || file.binary || typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES || content.includes("\0") || Buffer.from(content).toString("utf8") !== content) {
            throw new StackGitError("gitEditOnlyForTextFiles");
        }
    }
    let editedBytes = 0;

    for (const content of Object.values(edited)) {
        editedBytes += Buffer.byteLength(content, "utf8");
        if (editedBytes > MAX_BYTES) {
            throw new StackGitError("gitEditedResultsTooLarge");
        }
    }
}

/**
 * What the directory becomes once every choice is applied.
 *
 * Nothing is read or written here: the answer is decided from the comparison alone, so
 * the state of the disk is checked once, later, against a result that is already known.
 * @param preview Comparison the choice was made on
 * @param input What the browser chose
 * @returns The files as they should end up, and which of them the choice touches
 */
function resolveResult(preview: StoredPreview, input: GitApplyInput): { result: FileTree; changed: string[] } {
    const result: FileTree = new Map(preview.before);
    const changed: string[] = [];
    const edited = input.editedContents ?? {};

    for (const file of preview.public.files) {
        const choice = input.choices[file.path];

        if (choice === "edited") {
            const original = preview.before.get(file.path) ?? preview.target.get(file.path)!;

            result.set(file.path, { bytes: Buffer.from(edited[file.path]!, "utf8"),
                mode: original.mode });
            changed.push(file.path);
        } else if (choice === "git") {
            const target = preview.target.get(file.path);
            const previous = preview.before.get(file.path);

            if (target) {
                // Git tracks only executability. Preserve existing private read/write permissions.
                result.set(file.path, { bytes: target.bytes,
                    mode: previous ? (previous.mode & ~0o111) | (target.mode & 0o111) : target.mode });
            } else {
                result.delete(file.path);
            }
            changed.push(file.path);
        }
    }
    return { result,
        changed };
}

function previewFile(name: string, before: FileState | undefined, after: FileState | undefined, config: StackFileConfig): GitPreviewFile {
    const texts = [ before?.bytes.toString("utf8") ?? "", after?.bytes.toString("utf8") ?? "" ];
    const binary = [ before, after ].some((file) => file && (file.bytes.includes(0) || !Buffer.from(file.bytes.toString("utf8")).equals(file.bytes)));
    const redacted = config.envFileNames.includes(name) || config.activeEnvFileName === name || config.secretBindings.some(binding => binding.fileName === name) || /(?:^|[/. _-])(?:env|secret|secrets|credentials|password|passwd|id_rsa|id_ed25519)(?:$|[. _/-])/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name) || texts.some((text) => /(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|credential|bearer|authorization|private[_ -]?key|https?:\/\/[^\s/]+@)/i.test(text));
    return {
        path: name,
        status: !before ? "added" : !after ? "deleted" : "modified",
        serverText: binary || redacted || !before ? null : (texts[0] ?? ""),
        gitText: binary || redacted || !after ? null : (texts[1] ?? ""),
        redacted,
        binary,
    };
}

/** Immutable, bounded previews and file selection without checkout/reset/stash. */
export class StackGitWorkflow {
    private previews = storedPreviews;
    private owner = Symbol();

    constructor(private options: GitWorkflowOptions) {}

    /** Compare a saved result with the intended tree before a separate deployment phase. */
    async filesHash(dir: string): Promise<string> {
        return treeHash(await snapshot(dir));
    }

    private async git(dir: string, args: string[], indexFile?: string): Promise<Buffer> {
        try {
            return await runGit(args, { cwd: dir,
                allowLocalTransport: this.options.allowLocalTransport,
                indexFile,
                maxBuffer: MAX_BYTES,
                timeoutMs: 60_000 });
        } catch {
            throw new StackGitError("gitRemoteOperationFailed");
        }
    }

    private async assertRepository(dir: string): Promise<void> {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new StackGitError("gitStackPathMustBeDirectory");
        }
        const metadata = await fs.lstat(path.join(dir, ".git"));
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new StackGitError("gitLinkedWorktreeNotSupported");
        }
        async function checkMetadata(directory: string): Promise<void> {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
                    throw new StackGitError("gitMetadataHasSymlink");
                }
                if (entry.isDirectory()) {
                    await checkMetadata(path.join(directory, entry.name));
                }
            }
        }
        await checkMetadata(path.join(dir, ".git"));
    }

    private async branch(dir: string): Promise<string> {
        return (await this.git(dir, [ "symbolic-ref", "--short", "HEAD" ])).toString().trim();
    }

    private async commit(dir: string): Promise<string> {
        return (await this.git(dir, [ "rev-parse", "HEAD" ])).toString().trim();
    }

    private async tree(dir: string, commit: string): Promise<FileTree> {
        const output = await this.git(dir, [ "ls-tree", "-rz", "--full-tree", commit ]);
        const result: FileTree = new Map();
        let bytes = 0;
        for (const entry of output.toString().split("\0").filter(Boolean)) {
            const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
            if (!match || ![ "100644", "100755" ].includes(match[1]!)) {
                throw new StackGitError("gitSubmodulesNotSupported");
            }
            const name = match[3]!;
            safePath(name);
            const content = await this.git(dir, [ "cat-file", "blob", match[2]! ]);
            if (content.length > MAX_FILE_BYTES || (bytes += content.length) > MAX_BYTES || result.size >= MAX_FILES) {
                throw new StackGitError("gitRepositoryTooLarge");
            }
            result.set(name, { bytes: content,
                mode: match[1] === "100755" ? 0o755 : 0o644 });
        }
        return result;
    }

    /**
     * Run a Git operation while nothing else writes this stack directory.
     *
     * The lock is the one the editor and MCP take, because all three replace the same
     * files. Git does not wait for its turn: a comparison made against files that are
     * being rewritten would be shown to the user as if it still applied.
     * @param dir Stack directory
     * @param operation Work to run exclusively
     * @returns Whatever the operation returns
     * @throws {StackGitError} When another operation already holds the directory
     */
    private async exclusive<T>(dir: string, operation: () => Promise<T>): Promise<T> {
        if (stackLockBusy(dir)) {
            throw new StackGitError("gitOperationAlreadyRunning");
        }
        return withStackLock(dir, operation);
    }

    /** List the branches a remote advertises so the name does not have to be typed from memory.
     * Read-only and outside any stack directory: nothing is cloned and nothing is written.
     * @param repository Remote address supplied by the user
     * @returns Branch names as the remote reports them, capped to a readable list
     */
    async listBranches(repository: string): Promise<string[]> {
        validateGitRepository(repository, this.options.allowLocalTransport);
        const output = await this.git(os.tmpdir(), [ "ls-remote", "--heads", "--refs", "--", repository ]);
        const names: string[] = [];
        for (const line of output.toString("utf-8").split("\n")) {
            const ref = line.split("\t")[1]?.trim();
            if (!ref?.startsWith("refs/heads/")) {
                continue;
            }
            const name = ref.slice("refs/heads/".length);
            if (name && !names.includes(name)) {
                names.push(name);
            }
        }
        return names.slice(0, MAX_BRANCHES);
    }

    /**
     * Clone into a private staging directory, validate, then publish without overwriting.
     *
     * A validation failure normally leaves nothing behind - a stack that cannot be read is
     * not worth creating. The exception is an error the validator marks as deferrable: a
     * checkout whose compose file is sound but whose environment is not filled in yet. Those
     * files are published and the reason is returned, because the variables are set in them
     * and there is nowhere else to set them.
     */
    async clone(dir: string, input: GitCloneInput, config: StackFileConfig): Promise<{ filesHash: string, pending?: StackGitError }> {
        return this.exclusive(dir, async () => {
            validateGitRepository(input.repository, this.options.allowLocalTransport);
            if (typeof input.branch !== "string" || !input.branch || input.branch.length > 200 || input.branch.startsWith("-") || /[\x00-\x20\x7f]/.test(input.branch)) {
                throw new StackGitError("gitInvalidBranchName");
            }
            await this.git(path.dirname(dir), [ "check-ref-format", `refs/heads/${input.branch}` ]);
            const stage = await fs.mkdtemp(path.join(path.dirname(dir), ".dockge-git-"));
            try {
                await this.git(stage, [ "clone", "--no-checkout", "--single-branch", "--branch", input.branch, "--", input.repository, "repo" ]);
                const repo = path.join(stage, "repo");
                const intended = await this.tree(repo, await this.commit(repo));
                await writeTree(repo, intended);
                await this.git(repo, [ "read-tree", "HEAD" ]);
                if (!config.composeFileName) {
                    const selected = acceptedComposeFileNames.find((name) => intended.has(name));
                    if (!selected) {
                        throw new StackGitError("gitComposeFileNotFound");
                    }
                    config.composeFileName = selected;
                }
                let pending: StackGitError | undefined;
                try {
                    await this.options.validate(repo, config);
                } catch (error) {
                    if (!isDeferrable(error)) {
                        throw error;
                    }
                    pending = error;
                }
                // mkdir is the exclusive reservation. rename can otherwise replace an empty directory.
                await fs.mkdir(dir);
                try {
                    await fs.rename(repo, dir);
                } catch (error) {
                    await fs.rmdir(dir);
                    throw error;
                }
                clearStackSourceCache(dir);
                return { filesHash: treeHash(intended),
                    ...(pending ? { pending } : {}) };
            } finally {
                await fs.rm(stage, { recursive: true,
                    force: true });
            }
        });
    }

    /** Fetch a branch, keep working files untouched and bind decisions to exact bytes. */
    async preview(dir: string, config: StackFileConfig): Promise<GitUpdatePreview> {
        return this.exclusive(dir, async () => {
            if (buildingPreview) {
                throw new StackGitError("gitBusyElsewhere");
            }
            buildingPreview = true;
            try {
                await this.assertRepository(dir);
                const remote = (await this.git(dir, [ "remote", "get-url", "origin" ])).toString().trim();
                validateGitRepository(remote, this.options.allowLocalTransport);
                const branch = await this.branch(dir);
                await this.git(dir, [ "check-ref-format", `refs/heads/${branch}` ]);
                const currentCommit = await this.commit(dir);
                try {
                    await this.git(dir, [ "diff-index", "--cached", "--quiet", "HEAD", "--" ]);
                } catch {
                    throw new StackGitError("gitStagedChangesPresent");
                }
                await this.git(dir, [ "fetch", "--no-tags", "--no-recurse-submodules", "--", remote, `refs/heads/${branch}:refs/remotes/origin/${branch}` ]);
                const targetCommit = (await this.git(dir, [ "rev-parse", `refs/remotes/origin/${branch}` ])).toString().trim();
                try {
                    await this.git(dir, [ "merge-base", "--is-ancestor", currentCommit, targetCommit ]);
                } catch {
                    throw new StackGitError("gitBranchesDiverged");
                }
                const before = await snapshot(dir);
                const target = await this.tree(dir, targetCommit);
                const tracked = await this.tree(dir, currentCommit);
                const files: GitPreviewFile[] = [];
                for (const name of [ ...new Set([ ...tracked.keys(), ...target.keys() ]) ].sort()) {
                    if (!equalFile(before.get(name), target.get(name))) {
                        files.push(previewFile(name, before.get(name), target.get(name), config));
                    }
                }
                clearStackSourceCache(dir);
                const preview: GitUpdatePreview = { id: randomUUID(),
                    branch,
                    currentCommit,
                    targetCommit,
                    files };
                for (const [ id, item ] of this.previews.entries()) {
                    if (Date.now() - item.createdAt > PREVIEW_MS || item.dir === dir && item.owner === this.owner) {
                        this.previews.delete(id);
                    }
                }
                const indexPath = path.join(dir, ".git/index");
                if ((await fs.stat(indexPath)).size > 2 * 1024 * 1024) {
                    throw new StackGitError("gitRepositoryTooLarge");
                }
                const stored: StoredPreview = { dir,
                    owner: this.owner,
                    createdAt: Date.now(),
                    public: preview,
                    before,
                    target,
                    config: structuredClone(config),
                    index: await readIndex(dir) };
                const bytes = stored.index.length
                + [ ...before.values(), ...target.values() ].reduce((sum, file) => sum + file.bytes.length, 0)
                + files.reduce((sum, file) => sum + 2 * ((file.serverText?.length ?? 0) + (file.gitText?.length ?? 0) + file.path.length), 0);
                if (!this.previews.set(preview.id, stored, bytes)) {
                    throw new StackGitError("gitRepositoryTooLarge");
                }
                return structuredClone(preview);
            } finally {
                buildingPreview = false;
            }
        });
    }

    /** Release a comparison abandoned by its view; applying already owns its local reference. */
    discard(dir: string, id: string): void {
        const preview = this.previews.get(id);
        if (preview?.dir === dir && preview.owner === this.owner) {
            this.previews.delete(id);
        }
    }

    /** Validate the selected result, recheck every file and restore bytes if a write fails. */
    async apply(dir: string, input: GitApplyInput, config: StackFileConfig): Promise<{ filesHash: string }> {
        return this.exclusive(dir, async () => {
            const preview = this.previews.get(input.previewId);
            if (!preview || preview.owner !== this.owner || preview.dir !== dir || Date.now() - preview.createdAt > PREVIEW_MS) {
                throw new StackGitError("gitComparisonExpired");
            }
            assertChoices(preview, input);
            assertEditedResults(preview, input);
            if (JSON.stringify(config) !== JSON.stringify(preview.config)) {
                throw new StackGitError("gitFileConfigChanged");
            }
            const { result, changed } = resolveResult(preview, input);
            if (result.size > MAX_FILES || [ ...result.values() ].reduce((total, file) => total + file.bytes.length, 0) > MAX_BYTES) {
                throw new StackGitError("gitResultTooLarge");
            }
            const stage = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-git-validate-"));
            try {
                await writeTree(stage, result);
                await this.options.validate(stage, config);
            } finally {
                await fs.rm(stage, { recursive: true,
                    force: true });
            }
            await this.assertRepository(dir);
            await this.write(dir, preview, result, changed);
            this.previews.delete(input.previewId);
            return { filesHash: treeHash(result) };
        });
    }

    /**
     * Put the chosen result on disk, or leave the directory as it was.
     *
     * Everything before this point decided what the files should become; here nothing is
     * decided any more. The state is checked once more against the comparison, because
     * time passed while the user was choosing, and every write is undone when a later one
     * fails. Rolling files back does not roll container data back, so the caller still has
     * to redeploy.
     * @param dir Stack directory
     * @param preview Comparison the choice was made on
     * @param result What every file has to become
     * @param changed Files the choice actually touches
     * @returns {void}
     */
    private async write(dir: string, preview: StoredPreview, result: FileTree, changed: string[]): Promise<void> {
        const indexLockPath = path.join(dir, ".git/index.lock");
        let indexLock;
        try {
            indexLock = await fs.open(indexLockPath, "wx", 0o600);
        } catch {
            throw new StackGitError("gitBusyElsewhere");
        }
        const temporaryIndex = path.join(dir, `.git/dockge-index-${randomUUID()}`);
        const recovery = path.join(dir, `.git/dockge-recovery-${randomUUID()}`);
        let preserveRecovery = false;
        const written: string[] = [];
        let indexUpdated = false;
        try {
            if (await this.commit(dir) !== preview.public.currentCommit || await this.branch(dir) !== preview.public.branch || !sameTree(await snapshot(dir), preview.before) || !(await readIndex(dir)).equals(preview.index)) {
                throw new StackGitError("gitChangedSinceComparison");
            }
            // Build Git metadata separately; the real index stays locked and unchanged until all files succeed.
            await this.git(dir, [ "read-tree", preview.public.targetCommit ], temporaryIndex);
            await this.keepOriginals(recovery, preview, changed);
            for (const name of changed) {
                await this.options.beforeWrite?.(name);
                if (!equalFile(await this.currentFile(dir, name), preview.before.get(name))) {
                    throw new StackGitError("gitFileChangedWhileApplying");
                }
                await this.replaceFile(dir, name, result.get(name));
                written.push(name);
            }
            // Validation covers unchanged inputs too: detect edits made during our writes.
            if (!sameTree(await snapshot(dir), result) || !(await readIndex(dir)).equals(preview.index)) {
                throw new StackGitError("gitChangedWhileApplying");
            }
            await fs.rename(temporaryIndex, path.join(dir, ".git/index"));
            indexUpdated = true;
            await this.git(dir, [ "update-ref", `refs/heads/${preview.public.branch}`, preview.public.targetCommit, preview.public.currentCommit ]);
        } catch (error) {
            try {
                for (const name of written.reverse()) {
                    if (!equalFile(await this.currentFile(dir, name), result.get(name))) {
                        throw new Error("Concurrent edit during rollback", { cause: error });
                    }
                    if (preview.before.has(name)) {
                        await fs.rename(path.join(recovery, "files", name), path.join(dir, name));
                    } else {
                        await this.replaceFile(dir, name);
                    }
                }
                if (indexUpdated) {
                    await fs.rename(path.join(recovery, "index"), path.join(dir, ".git/index"));
                }
            } catch {
                preserveRecovery = true;
                throw new StackGitError("gitRollbackIncomplete", { backup: path.basename(recovery) });
            }
            throw error;
        } finally {
            await indexLock.close();
            await fs.rm(indexLockPath, { force: true });
            await fs.rm(temporaryIndex, { force: true });
            await fs.rm(`${temporaryIndex}.lock`, { force: true });
            if (!preserveRecovery) {
                await fs.rm(recovery, { recursive: true,
                    force: true });
            }
            clearStackSourceCache(dir);
        }
    }

    /**
     * Keep the bytes a failed write would otherwise destroy.
     *
     * The copy survives a crash on purpose: a directory left behind names the commit it
     * belongs to, so the files can be put back by hand.
     * @param recovery Directory the originals are kept in
     * @param preview Comparison the choice was made on
     * @param changed Files the choice touches
     * @returns {void}
     */
    private async keepOriginals(recovery: string, preview: StoredPreview, changed: string[]): Promise<void> {
        const originals: FileTree = new Map(changed.filter((name) => preview.before.has(name)).map((name) => [ name, preview.before.get(name)! ]));

        await fs.mkdir(recovery, { mode: 0o700 });
        await fs.mkdir(path.join(recovery, "files"));
        await writeTree(path.join(recovery, "files"), originals);
        await fs.writeFile(path.join(recovery, "index"), preview.index, { mode: 0o600 });
        await fs.writeFile(path.join(recovery, "manifest.json"), JSON.stringify({ currentCommit: preview.public.currentCommit,
            targetCommit: preview.public.targetCommit,
            files: changed }), { mode: 0o600 });
    }

    private async currentFile(dir: string, name: string): Promise<FileState | undefined> {
        let parent = dir;
        for (const part of name.split("/").slice(0, -1)) {
            parent = path.join(parent, part);
            try {
                const stat = await fs.lstat(parent);
                if (stat.isSymbolicLink() || !stat.isDirectory()) {
                    throw new StackGitError("gitFilePathChangedSinceComparison");
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    return undefined;
                }
                throw error;
            }
        }
        try {
            const handle = await fs.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
                    throw new StackGitError("gitFileChangedSinceComparison");
                }
                const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead !== stat.size) {
                    throw new StackGitError("gitFileChangedSinceComparison");
                }
                return { bytes: Buffer.from(buffer.subarray(0, bytesRead)),
                    mode: stat.mode & 0o777 };
            } finally {
                await handle.close();
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
            }
            throw error;
        }
    }

    private async replaceFile(dir: string, name: string, file?: FileState): Promise<void> {
        const target = path.join(dir, name);
        let parent = dir;
        for (const part of name.split("/").slice(0, -1)) {
            parent = path.join(parent, part);
            await fs.mkdir(parent, { recursive: true });
            const stat = await fs.lstat(parent);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new StackGitError("gitFilePathChangedSinceComparison");
            }
        }
        try {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new StackGitError("gitFilePathChangedSinceComparison");
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        if (!file) {
            await fs.rm(target, { force: true });
            return;
        }
        const temporary = path.join(path.dirname(target), `.dockge-write-${randomUUID()}`);
        try {
            await fs.writeFile(temporary, file.bytes, { flag: "wx",
                mode: file.mode });
            await fs.chmod(temporary, file.mode);
            await fs.rename(temporary, target);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }
}
