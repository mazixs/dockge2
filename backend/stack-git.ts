import { promises as fs, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "./child-process";
import { clearStackSourceCache, readStackSource } from "./stack-source";
import type { GitApplyInput, GitCloneInput, GitPreviewFile, GitUpdatePreview } from "../common/stack-git";
import type { StackFileConfig } from "../common/types/stack";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 1000;
const PREVIEW_MS = 10 * 60 * 1000;

type FileState = { bytes: Buffer; mode: number };
type FileTree = Map<string, FileState>;

interface StoredPreview {
    dir: string;
    createdAt: number;
    public: GitUpdatePreview;
    before: FileTree;
    target: FileTree;
    config: StackFileConfig;
    index: Buffer;
}

export interface GitWorkflowOptions {
    /** Only isolated unit tests may opt into a local transport. Never set from a socket. */
    allowLocalTransport?: boolean;
    validate: (directory: string, config: StackFileConfig) => Promise<void>;
    /** Test injection for a filesystem failure after earlier writes. */
    beforeWrite?: (fileName: string) => Promise<void>;
}

/** A safe message that never incorporates subprocess output or repository file contents. */
export class StackGitError extends Error {}

/** Check relative paths from Git before they become filesystem paths. */
function safePath(name: string): void {
    if (!name || name.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(name) || name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || path.isAbsolute(name)) {
        throw new StackGitError("Git содержит небезопасный путь файла.");
    }
}

/** Enforce a transport allowlist; credentials must come from the host, never the URL. */
export function validateGitRepository(repository: string, allowLocal = false): void {
    if (typeof repository !== "string" || repository.length > 2048 || /[\x00-\x20\x7f]/.test(repository) || repository.startsWith("-")) {
        throw new StackGitError("Укажите корректный HTTP(S) или SSH адрес репозитория.");
    }
    if (allowLocal && path.isAbsolute(repository)) {
        return;
    }
    if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(repository)) {
        return;
    }
    try {
        const url = new URL(repository);
        if (![ "https:", "http:", "ssh:" ].includes(url.protocol) || url.password || (url.protocol !== "ssh:" && url.username) || url.search || url.hash || !url.hostname || !url.pathname || url.pathname === "/") {
            throw new Error();
        }
    } catch {
        throw new StackGitError("Допустимы HTTP(S) и SSH адреса без пароля, токена и параметров запроса.");
    }
}

/** Capture only bounded regular files, refusing symlinks even inside nested folders. */
async function snapshot(dir: string): Promise<FileTree> {
    const root = await fs.lstat(dir);
    if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new StackGitError("Каталог стека должен быть обычным каталогом.");
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
                throw new StackGitError("Git-сценарий не поддерживает символические ссылки и специальные файлы.");
            }
            if (entry.isDirectory()) {
                await walk(name);
                continue;
            }
            const stat = await fs.lstat(path.join(dir, name));
            if (stat.size > MAX_FILE_BYTES || (size += stat.size) > MAX_BYTES || result.size >= MAX_FILES) {
                throw new StackGitError("Репозиторий превышает лимит: 1000 файлов, 1 МБ на файл, 20 МБ всего.");
            }
            const handle = await fs.open(path.join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const current = await handle.stat();
                if (current.ino !== stat.ino || !current.isFile()) {
                    throw new StackGitError("Файлы изменились во время проверки. Повторите сравнение.");
                }
                const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead > MAX_FILE_BYTES || current.size !== bytesRead) {
                    throw new StackGitError("Размер файла изменился во время проверки или превышает лимит.");
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
    private previews = new Map<string, StoredPreview>();
    private busy = new Set<string>();

    constructor(private options: GitWorkflowOptions) {}

    /** Compare a saved result with the intended tree before a separate deployment phase. */
    async filesHash(dir: string): Promise<string> {
        return treeHash(await snapshot(dir));
    }

    private async git(dir: string, args: string[], indexFile?: string): Promise<Buffer> {
        try {
            const env: NodeJS.ProcessEnv = { ...process.env };
            // Git-specific inherited variables can redirect its executable, config or index.
            for (const key of Object.keys(env)) {
                if (key.startsWith("GIT_")) {
                    delete env[key];
                }
            }
            Object.assign(env, {
                GIT_TERMINAL_PROMPT: "0",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
                GIT_ALLOW_PROTOCOL: this.options.allowLocalTransport ? "http:https:ssh:file" : "http:https:ssh",
            });
            if (indexFile) {
                env.GIT_INDEX_FILE = indexFile;
            }
            const result = await spawn("git", [ "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.sshCommand=ssh -oBatchMode=yes", "-c", "credential.helper=", "-c", "submodule.recurse=false", "-c", "protocol.ext.allow=never", ...args ], { cwd: dir,
                env,
                encoding: "buffer",
                maxBuffer: MAX_BYTES,
                timeoutMs: 60_000 });
            return Buffer.from(result.stdout ?? "");
        } catch {
            throw new StackGitError("Операция Git не выполнена. Проверьте адрес, ветку и доступ сервера к репозиторию.");
        }
    }

    private async assertRepository(dir: string): Promise<void> {
        const stat = await fs.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new StackGitError("Каталог стека должен быть обычным каталогом.");
        }
        const metadata = await fs.lstat(path.join(dir, ".git"));
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new StackGitError("Нужен отдельный Git-каталог стека; связанные рабочие копии не поддерживаются.");
        }
        async function checkMetadata(directory: string): Promise<void> {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
                    throw new StackGitError("Метаданные Git содержат символическую ссылку или специальный файл.");
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
                throw new StackGitError("Git-сценарий не поддерживает подмодули и символические ссылки.");
            }
            const name = match[3]!;
            safePath(name);
            const content = await this.git(dir, [ "cat-file", "blob", match[2]! ]);
            if (content.length > MAX_FILE_BYTES || (bytes += content.length) > MAX_BYTES || result.size >= MAX_FILES) {
                throw new StackGitError("Репозиторий превышает лимит: 1000 файлов, 1 МБ на файл, 20 МБ всего.");
            }
            result.set(name, { bytes: content,
                mode: match[1] === "100755" ? 0o755 : 0o644 });
        }
        return result;
    }

    private async exclusive<T>(dir: string, operation: () => Promise<T>): Promise<T> {
        if (this.busy.has(dir)) {
            throw new StackGitError("Для этого стека уже выполняется операция Git.");
        }
        this.busy.add(dir);
        try {
            return await operation();
        } finally {
            this.busy.delete(dir);
        }
    }

    /** Clone into a private staging directory, validate, then publish without overwriting. */
    async clone(dir: string, input: GitCloneInput, config: StackFileConfig): Promise<{ filesHash: string }> {
        return this.exclusive(dir, async () => {
            validateGitRepository(input.repository, this.options.allowLocalTransport);
            if (typeof input.branch !== "string" || !input.branch || input.branch.length > 200 || input.branch.startsWith("-") || /[\x00-\x20\x7f]/.test(input.branch)) {
                throw new StackGitError("Укажите корректное имя ветки.");
            }
            await this.git(path.dirname(dir), [ "check-ref-format", `refs/heads/${input.branch}` ]);
            const stage = await fs.mkdtemp(path.join(path.dirname(dir), ".dockge-git-"));
            try {
                await this.git(stage, [ "clone", "--no-checkout", "--single-branch", "--branch", input.branch, "--", input.repository, "repo" ]);
                const repo = path.join(stage, "repo");
                const intended = await this.tree(repo, await this.commit(repo));
                await writeTree(repo, intended);
                await this.git(repo, [ "read-tree", "HEAD" ]);
                await this.options.validate(repo, config);
                // mkdir is the exclusive reservation. rename can otherwise replace an empty directory.
                await fs.mkdir(dir);
                try {
                    await fs.rename(repo, dir);
                } catch (error) {
                    await fs.rmdir(dir);
                    throw error;
                }
                clearStackSourceCache(dir);
                return { filesHash: treeHash(intended) };
            } finally {
                await fs.rm(stage, { recursive: true,
                    force: true });
            }
        });
    }

    /** Fetch a branch, keep working files untouched and bind decisions to exact bytes. */
    async preview(dir: string, config: StackFileConfig): Promise<GitUpdatePreview> {
        return this.exclusive(dir, async () => {
            await this.assertRepository(dir);
            const remote = (await this.git(dir, [ "remote", "get-url", "origin" ])).toString().trim();
            validateGitRepository(remote, this.options.allowLocalTransport);
            const branch = await this.branch(dir);
            await this.git(dir, [ "check-ref-format", `refs/heads/${branch}` ]);
            const currentCommit = await this.commit(dir);
            try {
                await this.git(dir, [ "diff-index", "--cached", "--quiet", "HEAD", "--" ]);
            } catch {
                throw new StackGitError("В Git есть подготовленные к коммиту изменения. Сохраните их отдельным коммитом или уберите из индекса вне панели.");
            }
            await this.git(dir, [ "fetch", "--no-tags", "--no-recurse-submodules", "--", remote, `refs/heads/${branch}:refs/remotes/origin/${branch}` ]);
            const targetCommit = (await this.git(dir, [ "rev-parse", `refs/remotes/origin/${branch}` ])).toString().trim();
            try {
                await this.git(dir, [ "merge-base", "--is-ancestor", currentCommit, targetCommit ]);
            } catch {
                throw new StackGitError("Ветки разошлись. Объедините коммиты вне панели и повторите проверку.");
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
                files,
                source: await readStackSource(dir) };
            for (const [ id, item ] of this.previews) {
                if (Date.now() - item.createdAt > PREVIEW_MS || item.dir === dir) {
                    this.previews.delete(id);
                }
            }
            if (this.previews.size >= 10) {
                this.previews.delete(this.previews.keys().next().value!);
            }
            this.previews.set(preview.id, { dir,
                createdAt: Date.now(),
                public: preview,
                before,
                target,
                config: structuredClone(config),
                index: await fs.readFile(path.join(dir, ".git/index")) });
            return structuredClone(preview);
        });
    }

    /** Validate the selected result, recheck every file and restore bytes if a write fails. */
    async apply(dir: string, input: GitApplyInput, config: StackFileConfig): Promise<{ filesHash: string }> {
        return this.exclusive(dir, async () => {
            const preview = this.previews.get(input.previewId);
            if (!preview || preview.dir !== dir || Date.now() - preview.createdAt > PREVIEW_MS) {
                throw new StackGitError("Сравнение устарело. Проверьте изменения заново.");
            }
            if (!input.choices || typeof input.choices !== "object" || Array.isArray(input.choices) || Object.keys(input.choices).length !== preview.public.files.length || preview.public.files.some((file) => !Object.hasOwn(input.choices, file.path) || ![ "server", "git", "edited" ].includes(input.choices[file.path]!))) {
                throw new StackGitError("Выберите результат для каждого файла.");
            }
            const edited = input.editedContents ?? {};
            if (typeof edited !== "object" || Array.isArray(edited) || Object.keys(edited).some(name => !preview.public.files.some(file => file.path === name && input.choices[name] === "edited"))) {
                throw new StackGitError("Некорректный список измененных результатов.");
            }
            let editedBytes = 0;
            for (const file of preview.public.files) {
                if (input.choices[file.path] === "edited" && (file.redacted || file.binary || !Object.hasOwn(edited, file.path) || typeof edited[file.path] !== "string" || Buffer.byteLength(edited[file.path]!, "utf8") > MAX_FILE_BYTES || edited[file.path]!.includes("\0") || Buffer.from(edited[file.path]!).toString("utf8") !== edited[file.path])) {
                    throw new StackGitError("Изменение результата доступно только для открытого текстового файла размером до 1 МБ.");
                }
            }
            for (const content of Object.values(edited)) {
                editedBytes += Buffer.byteLength(content, "utf8");
                if (editedBytes > MAX_BYTES) {
                    throw new StackGitError("Измененные результаты превышают лимит 20 МБ.");
                }
            }
            if (JSON.stringify(config) !== JSON.stringify(preview.config)) {
                throw new StackGitError("Настройки файлов изменились. Повторите сравнение.");
            }
            const result: FileTree = new Map(preview.before);
            const changed: string[] = [];
            for (const file of preview.public.files) {
                if (input.choices[file.path] === "edited") {
                    const original = preview.before.get(file.path) ?? preview.target.get(file.path)!;
                    result.set(file.path, { bytes: Buffer.from(edited[file.path]!, "utf8"),
                        mode: original.mode });
                    changed.push(file.path);
                } else if (input.choices[file.path] === "git") {
                    const target = preview.target.get(file.path);
                    if (target) {
                        const previous = preview.before.get(file.path);
                        // Git tracks only executability. Preserve existing private read/write permissions.
                        result.set(file.path, { bytes: target.bytes,
                            mode: previous ? (previous.mode & ~0o111) | (target.mode & 0o111) : target.mode });
                    } else {
                        result.delete(file.path);
                    }
                    changed.push(file.path);
                }
            }
            if (result.size > MAX_FILES || [ ...result.values() ].reduce((total, file) => total + file.bytes.length, 0) > MAX_BYTES) {
                throw new StackGitError("Итоговые файлы превышают лимит 1000 файлов или 20 МБ.");
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
            const indexLockPath = path.join(dir, ".git/index.lock");
            let indexLock;
            try {
                indexLock = await fs.open(indexLockPath, "wx", 0o600);
            } catch {
                throw new StackGitError("Git занят другим процессом. Дождитесь его завершения и повторите сравнение.");
            }
            const temporaryIndex = path.join(dir, `.git/dockge-index-${randomUUID()}`);
            const recovery = path.join(dir, `.git/dockge-recovery-${randomUUID()}`);
            let preserveRecovery = false;
            const written: string[] = [];
            let indexUpdated = false;
            try {
                if (await this.commit(dir) !== preview.public.currentCommit || await this.branch(dir) !== preview.public.branch || !sameTree(await snapshot(dir), preview.before) || !(await fs.readFile(path.join(dir, ".git/index"))).equals(preview.index)) {
                    throw new StackGitError("Файлы или Git изменились после сравнения. Проверьте изменения заново.");
                }
                // Build Git metadata separately; the real index stays locked and unchanged until all files succeed.
                await this.git(dir, [ "read-tree", preview.public.targetCommit ], temporaryIndex);
                await fs.mkdir(recovery, { mode: 0o700 });
                const originals: FileTree = new Map(changed.filter((name) => preview.before.has(name)).map((name) => [ name, preview.before.get(name)! ]));
                await fs.mkdir(path.join(recovery, "files"));
                await writeTree(path.join(recovery, "files"), originals);
                await fs.writeFile(path.join(recovery, "index"), preview.index, { mode: 0o600 });
                await fs.writeFile(path.join(recovery, "manifest.json"), JSON.stringify({ currentCommit: preview.public.currentCommit,
                    targetCommit: preview.public.targetCommit,
                    files: changed }), { mode: 0o600 });
                for (const name of changed) {
                    await this.options.beforeWrite?.(name);
                    if (!equalFile(await this.currentFile(dir, name), preview.before.get(name))) {
                        throw new StackGitError("Файл изменился во время применения. Повторите сравнение.");
                    }
                    await this.replaceFile(dir, name, result.get(name));
                    written.push(name);
                }
                // Validation covers unchanged inputs too: detect edits made during our writes.
                if (!sameTree(await snapshot(dir), result) || !(await fs.readFile(path.join(dir, ".git/index"))).equals(preview.index)) {
                    throw new StackGitError("Файлы или Git изменились во время применения. Повторите сравнение.");
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
                    throw new StackGitError(`Не удалось полностью восстановить файлы. Резервная копия сохранена в .git/${path.basename(recovery)}. Не запускайте стек до проверки файлов.`);
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
            this.previews.delete(input.previewId);
            return { filesHash: treeHash(result) };
        });
    }

    private async currentFile(dir: string, name: string): Promise<FileState | undefined> {
        let parent = dir;
        for (const part of name.split("/").slice(0, -1)) {
            parent = path.join(parent, part);
            try {
                const stat = await fs.lstat(parent);
                if (stat.isSymbolicLink() || !stat.isDirectory()) {
                    throw new StackGitError("Путь файла изменился после сравнения.");
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
                    throw new StackGitError("Файл изменился после сравнения.");
                }
                const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead !== stat.size) {
                    throw new StackGitError("Файл изменился после сравнения.");
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
                throw new StackGitError("Путь файла изменился после сравнения.");
            }
        }
        try {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new StackGitError("Путь файла изменился после сравнения.");
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
