import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveStackFilePath, StackConfig } from "./stack-config";
import { isSafeStackFileName } from "../common/stack-files";
import type { StackFileConfig } from "../common/types/stack";
import { ValidationError } from "./util-server";
import { withStackLock } from "./stack-lock";
import { log } from "./log";

/** No stack file this panel writes is larger than this */
const MAX_FILE_BYTES = 1024 * 1024;

/** Mode a stack file is created with when it did not exist yet */
const DEFAULT_FILE_MODE = 0o644;

/** Directory inside the data directory holding the journals of unfinished writes */
export const STACK_WRITE_JOURNAL_DIR = "stack-writes";

/**
 * What a caller wants one file to contain after the write.
 */
export interface StackFileTarget {
    /** Plain file name inside the stack directory */
    name : string;
    /** Exact text the file has to hold afterwards */
    content : string;
    /**
     * Hash of the bytes the caller started from, null when the file must not exist yet.
     * Left out only where the caller has no baseline to offer, such as an explicit
     * overwrite the user confirmed.
     */
    expectedHash? : string | null;
    /** Permissions for a file this write creates; an existing file keeps its own */
    mode? : number;
}

/**
 * A stored selection that only makes sense together with the files of the same write.
 *
 * Adopting a new env file is such a change: the file on disk and the note saying compose
 * interpolates it are one decision, and a save that does one without the other leaves the
 * stack describing something that is not there. The transaction therefore owns both, and
 * the journal records the selection so a crash between them is repaired on the next start.
 */
export interface StackWriteMetadata {
    /** Stack whose stored selection belongs to this write */
    stack : string;
    /** Selection to put back when the write does not commit, null when nothing was stored */
    before : StackFileConfig | null;
    /** Selection that belongs to the files being written */
    after : StackFileConfig;
}

export interface StackWriteOptions {
    /** Data directory holding the journal, so an interrupted write can be finished later */
    journalRoot : string;
    /** Stored selection that has to hold together with these files */
    metadata? : StackWriteMetadata;
    /** Test injection: throws right before the named file is replaced */
    beforeWrite? : (fileName : string) => Promise<void>;
    /** Test injection: throws after every file is written, before the journal is committed */
    beforeCommit? : () => Promise<void>;
}

export interface StackWriteResult {
    /** Hash of every requested file after the write */
    hashes : Record<string, string>;
    /** Files whose bytes actually changed */
    changed : string[];
}

/** State of one file on disk, as the transaction sees it */
interface StackFileState {
    /** Hash of the current bytes, null when the file does not exist */
    hash : string | null;
    /** Current bytes, null when the file does not exist */
    bytes : Buffer | null;
    /** Permissions of the existing file */
    mode : number | null;
    /** Owner of the existing file, restored after the replacement */
    uid : number | null;
    /** Group of the existing file, restored after the replacement */
    gid : number | null;
}

/** One file as the journal records it */
interface JournalFile {
    name : string;
    beforeHash : string | null;
    afterHash : string;
    mode : number;
}

interface JournalManifest {
    dir : string;
    createdAt : number;
    files : JournalFile[];
    /** Stored selection this write changes together with the files, when it changes one */
    metadata? : StackWriteMetadata;
}

/**
 * The file changed between the moment the caller read it and the moment it would be written.
 * A conflict is never resolved by guessing: the caller has to show both versions.
 */
export class StackWriteConflictError extends ValidationError {
    /**
     * @param fileName File that no longer holds what the caller expected
     */
    constructor(fileName : string) {
        super("stackFileChangedElsewhere", { file: fileName });
    }
}

/**
 * The stack now works with other files than the ones the editor read.
 *
 * Not the same thing as changed content: here the text may be untouched while the file it
 * would be written to is a different one, so the save is refused and the editor re-reads.
 */
export class StackSelectionConflictError extends ValidationError {
    /**
     * @param expected File the editor had open
     * @param actual File the stack works with now
     */
    constructor(expected : string, actual : string) {
        super("stackSelectionChangedElsewhere", { expected,
            actual });
    }
}

/**
 * The files could not be saved because the selection that belongs to them could not be stored.
 *
 * Reported instead of a silently half done save: the files are put back, so the stack still
 * describes what is on disk.
 */
export class StackMetadataWriteError extends ValidationError {
    /**
     * @param stackName Stack whose selection could not be stored
     * @param cause Failure of the settings store
     */
    constructor(stackName : string, readonly cause? : unknown) {
        super("stackSelectionNotStored", { stack: stackName });
    }
}

/**
 * A failed write could not be undone, so the files are left as they are and the journal stays.
 */
export class StackWriteRecoveryError extends Error {
    readonly values : Record<string, string>;

    /**
     * @param backup Name of the journal directory holding the original bytes
     * @param cause Failure that started the rollback
     */
    constructor(backup : string, cause? : unknown) {
        super("stackWriteRecoveryIncomplete", { cause });
        this.values = { backup };
    }
}

/**
 * Hash of file content, the same way for every caller.
 * @param content Text of the file
 * @returns Hexadecimal sha256 of the UTF-8 bytes
 */
export function hashStackFileContent(content : string) : string {
    return createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
}

/**
 * Read what a stack file currently holds, without following a symlink.
 * @param dir Stack directory
 * @param fileName Plain file name inside it
 * @returns Current state, with null bytes when the file does not exist
 * @throws {ValidationError} If the name or the path cannot be used
 */
export async function readStackFileState(dir : string, fileName : string) : Promise<StackFileState> {
    const file = await resolveStackFilePath(dir, fileName);
    const absent : StackFileState = { hash: null,
        bytes: null,
        mode: null,
        uid: null,
        gid: null };

    let handle;
    try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return absent;
        }
        throw error;
    }

    try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
            throw new ValidationError("Invalid file name: " + fileName);
        }
        if (stat.size > MAX_FILE_BYTES) {
            throw new ValidationError("stackFileTooLarge", { file: fileName });
        }
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const bytes = buffer.subarray(0, bytesRead);
        return { hash: createHash("sha256").update(bytes).digest("hex"),
            bytes: Buffer.from(bytes),
            mode: stat.mode & 0o777,
            uid: stat.uid,
            gid: stat.gid };
    } finally {
        await handle.close();
    }
}

/**
 * Write a file in place of another one, leaving either the old or the new bytes behind.
 *
 * The rename is what makes a single file atomic; the journal is what makes the set of
 * files recoverable. Ownership is restored because the panel may run as root over files
 * that belong to the user who started the stack.
 * @param dir Stack directory
 * @param fileName Plain file name inside it
 * @param content Text to write
 * @param state State the file had before, used for permissions and ownership
 */
async function replaceFile(dir : string, fileName : string, content : string, state : StackFileState) : Promise<void> {
    const file = await resolveStackFilePath(dir, fileName);
    const temporary = path.join(path.dirname(file), `.dockge-write-${randomUUID()}`);
    const mode = state.mode ?? DEFAULT_FILE_MODE;

    try {
        const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
        try {
            await handle.writeFile(content, "utf-8");
            await handle.chmod(mode);
            if (state.uid !== null && state.gid !== null && (state.uid !== process.getuid?.() || state.gid !== process.getgid?.())) {
                try {
                    await handle.chown(state.uid, state.gid);
                } catch (error) {
                    // Only root may give a file away. Keeping the panel's own ownership is
                    // better than refusing the save the user asked for.
                    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
                        throw error;
                    }
                }
            }
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temporary, file);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

/**
 * Remove a file this transaction created, used while undoing a partial write.
 * @param dir Stack directory
 * @param fileName Plain file name inside it
 */
async function removeFile(dir : string, fileName : string) : Promise<void> {
    await fs.rm(await resolveStackFilePath(dir, fileName), { force: true });
}

/**
 * Store the selection that belongs to the files of this write.
 *
 * `StackConfig.setQuiet` is deliberately not used here: it answers "could not" and lets
 * the caller continue, which is exactly the half done save this transaction exists to
 * prevent.
 * @param metadata Selection to store
 * @throws {StackMetadataWriteError} If the selection could not be stored
 */
async function applyMetadata(metadata : StackWriteMetadata) : Promise<void> {
    try {
        await StackConfig.set(metadata.stack, metadata.after);
    } catch (error) {
        throw new StackMetadataWriteError(metadata.stack, error);
    }
}

/**
 * Put back the selection a failed write had already changed.
 * @param metadata Selection of this write
 * @returns Whether the previous selection is stored again
 */
async function revertMetadata(metadata : StackWriteMetadata) : Promise<boolean> {
    return metadata.before === null
        ? StackConfig.removeQuiet(metadata.stack)
        : StackConfig.setQuiet(metadata.stack, metadata.before);
}

/**
 * Write a set of stack files so that a failure leaves either all of them or none.
 *
 * Every caller passes the hashes it started from, so a second editor - another browser
 * tab, a manual edit on disk, an agent - is reported as a conflict instead of being
 * overwritten. The journal survives a crash: the next start finishes or undoes the write.
 * A selection that belongs to these files is part of the same transaction, so the answer
 * "saved" never means the files went in and the selection did not.
 * @param dir Stack directory, already resolved by the caller
 * @param targets Files and what they have to contain
 * @param options Journal location, dependent selection and test injections
 * @returns Hashes of the files afterwards and which of them changed
 * @throws {StackWriteConflictError} If a file no longer holds what the caller expected
 * @throws {StackMetadataWriteError} If the selection of these files could not be stored
 * @throws {StackWriteRecoveryError} If a failed write could not be undone
 */
export async function writeStackFiles(dir : string, targets : StackFileTarget[], options : StackWriteOptions) : Promise<StackWriteResult> {
    for (const target of targets) {
        if (!isSafeStackFileName(target.name)) {
            throw new ValidationError("Invalid file name: " + target.name);
        }
        if (Buffer.byteLength(target.content, "utf-8") > MAX_FILE_BYTES) {
            throw new ValidationError("stackFileTooLarge", { file: target.name });
        }
    }

    const names = targets.map((target) => target.name);
    if (new Set(names).size !== names.length) {
        throw new ValidationError("Duplicate file name in one save");
    }

    return withStackLock(dir, async () => {
        const states = new Map<string, StackFileState>();
        const hashes : Record<string, string> = {};
        const pending : { target : StackFileTarget, state : StackFileState, afterHash : string }[] = [];

        for (const target of targets) {
            const state = await readStackFileState(dir, target.name);
            states.set(target.name, state);

            if (target.expectedHash !== undefined && target.expectedHash !== state.hash) {
                throw new StackWriteConflictError(target.name);
            }

            if (target.mode !== undefined && state.mode === null) {
                state.mode = target.mode;
            }

            const afterHash = hashStackFileContent(target.content);
            hashes[target.name] = afterHash;

            if (afterHash !== state.hash) {
                pending.push({ target,
                    state,
                    afterHash });
            }
        }

        if (pending.length === 0) {
            // Nothing to undo, so the selection is the whole write and stands on its own
            if (options.metadata) {
                await applyMetadata(options.metadata);
            }
            return { hashes,
                changed: [] };
        }

        const journal = path.join(options.journalRoot, STACK_WRITE_JOURNAL_DIR, randomUUID());
        const manifest : JournalManifest = { dir: path.resolve(dir),
            createdAt: Date.now(),
            files: pending.map(({ target, state, afterHash }) => ({ name: target.name,
                beforeHash: state.hash,
                afterHash,
                mode: state.mode ?? DEFAULT_FILE_MODE })),
            ...(options.metadata ? { metadata: options.metadata } : {}) };

        await fs.mkdir(path.join(journal, "before"), { recursive: true,
            mode: 0o700 });
        await fs.mkdir(path.join(journal, "after"), { mode: 0o700 });

        for (const { target, state } of pending) {
            if (state.bytes) {
                await fs.writeFile(path.join(journal, "before", target.name), state.bytes, { mode: 0o600 });
            }
            await fs.writeFile(path.join(journal, "after", target.name), target.content, { mode: 0o600 });
        }
        await fs.writeFile(path.join(journal, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });

        const written : string[] = [];
        let metadataApplied = false;
        try {
            for (const { target, state, afterHash } of pending) {
                await options.beforeWrite?.(target.name);

                // The file is read once more under the lock: a process outside the panel
                // could have replaced it while the journal was being written
                const current = await readStackFileState(dir, target.name);
                if (current.hash !== state.hash) {
                    throw new StackWriteConflictError(target.name);
                }

                await replaceFile(dir, target.name, target.content, state);
                written.push(target.name);

                const verified = await readStackFileState(dir, target.name);
                if (verified.hash !== afterHash) {
                    throw new StackWriteConflictError(target.name);
                }
            }

            await options.beforeCommit?.();

            // The selection goes in while the files can still be put back: from the commit
            // marker on, both belong to the saved state and recovery rolls them forward
            if (options.metadata) {
                await applyMetadata(options.metadata);
                metadataApplied = true;
            }
            await fs.writeFile(path.join(journal, "committed"), "", { mode: 0o600 });
        } catch (error) {
            if (metadataApplied && options.metadata && !await revertMetadata(options.metadata)) {
                log.error("stack-write", `Could not put back the file selection of ${options.metadata.stack} after a failed save`);
                throw new StackWriteRecoveryError(path.basename(journal), error);
            }
            await undoWrite(dir, journal, manifest, written, error);
            throw error;
        }

        await fs.rm(journal, { recursive: true,
            force: true });

        return { hashes,
            changed: pending.map(({ target }) => target.name) };
    });
}

/**
 * Put back what the files held before a failed write.
 *
 * A file that no longer holds what this transaction wrote is left alone: someone else
 * changed it in the meantime, and overwriting it would be a second silent loss.
 * @param dir Stack directory
 * @param journal Journal directory of this write
 * @param manifest Plan of the write
 * @param written Files this transaction already replaced
 * @param cause Failure that started the rollback
 * @throws {StackWriteRecoveryError} If the original bytes could not be restored
 */
async function undoWrite(dir : string, journal : string, manifest : JournalManifest, written : string[], cause : unknown) : Promise<void> {
    try {
        for (const name of [ ...written ].reverse()) {
            const entry = manifest.files.find((file) => file.name === name)!;
            const current = await readStackFileState(dir, name);

            if (current.hash !== entry.afterHash) {
                throw new Error("The file changed while the save was being undone");
            }

            if (entry.beforeHash === null) {
                await removeFile(dir, name);
                continue;
            }

            const before = await fs.readFile(path.join(journal, "before", name), "utf-8");
            await replaceFile(dir, name, before, { hash: entry.beforeHash,
                bytes: null,
                mode: entry.mode,
                uid: current.uid,
                gid: current.gid });
        }
    } catch (error) {
        log.error("stack-write", `Could not undo a failed save in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        throw new StackWriteRecoveryError(path.basename(journal), cause);
    }

    await fs.rm(journal, { recursive: true,
        force: true });
}

/**
 * Finish or undo the writes an interrupted process left behind.
 *
 * A journal that was committed is rolled forward, because the files were already
 * verified; one that was not is rolled back, because nobody was ever told the save
 * succeeded. A file that holds neither version is left untouched and its journal is
 * kept, since only the user can say which text is the right one.
 * @param journalRoot Data directory holding the journals
 * @returns How many writes were finished, undone and left for the user
 */
export async function recoverStackWrites(journalRoot : string) : Promise<{ finished : number, undone : number, unresolved : number }> {
    const root = path.join(journalRoot, STACK_WRITE_JOURNAL_DIR);
    const result = { finished: 0,
        undone: 0,
        unresolved: 0 };

    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return result;
        }
        throw error;
    }

    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith("unresolved-")) {
            continue;
        }

        const journal = path.join(root, entry.name);
        let manifest : JournalManifest;
        try {
            manifest = JSON.parse(await fs.readFile(path.join(journal, "manifest.json"), "utf-8")) as JournalManifest;
        } catch (error) {
            log.warn("stack-write", `Unreadable save journal ${entry.name}, leaving it in place`);
            result.unresolved += 1;
            continue;
        }

        const committed = await fs.access(path.join(journal, "committed")).then(() => true, () => false);
        let unresolved = false;

        for (const file of manifest.files) {
            const wanted = committed ? file.afterHash : file.beforeHash;
            const other = committed ? file.beforeHash : file.afterHash;

            let current;
            try {
                current = await readStackFileState(manifest.dir, file.name);
            } catch (error) {
                unresolved = true;
                continue;
            }

            if (current.hash === wanted) {
                continue;
            }

            if (current.hash !== other) {
                // The file holds a third text: someone edited it after the crash
                unresolved = true;
                continue;
            }

            try {
                if (wanted === null) {
                    await removeFile(manifest.dir, file.name);
                } else {
                    const content = await fs.readFile(path.join(journal, committed ? "after" : "before", file.name), "utf-8");
                    await replaceFile(manifest.dir, file.name, content, { hash: current.hash,
                        bytes: null,
                        mode: file.mode,
                        uid: current.uid,
                        gid: current.gid });
                }
                log.info("stack-write", `${committed ? "Finished" : "Undid"} the interrupted save of ${file.name} in ${manifest.dir}`);
            } catch (error) {
                unresolved = true;
            }
        }

        // The selection follows the files: a committed write keeps the one it was saved
        // with, an uncommitted one goes back to what was stored before it started
        if (!unresolved && manifest.metadata) {
            const wanted = committed ? manifest.metadata.after : manifest.metadata.before;
            const stored = wanted === null
                ? await StackConfig.removeQuiet(manifest.metadata.stack)
                : await StackConfig.setQuiet(manifest.metadata.stack, wanted);

            if (stored) {
                log.info("stack-write", `${committed ? "Finished" : "Undid"} the interrupted file selection of ${manifest.metadata.stack}`);
            } else {
                unresolved = true;
            }
        }

        if (unresolved) {
            result.unresolved += 1;
            await fs.rename(journal, path.join(root, `unresolved-${entry.name}`));
            log.warn("stack-write", `An interrupted save of ${manifest.dir} needs a decision, the original files are kept in unresolved-${entry.name}`);
            continue;
        }

        if (committed) {
            result.finished += 1;
        } else {
            result.undone += 1;
        }
        await fs.rm(journal, { recursive: true,
            force: true });
    }

    return result;
}
