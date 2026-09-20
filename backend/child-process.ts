import { spawn as spawnProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";
import { SpawnedGroup } from "./process-group";

export interface SpawnOptions extends NodeSpawnOptions {
    encoding?: BufferEncoding | "buffer";
    maxBuffer?: number;
    killSignal?: NodeJS.Signals | number;
    timeoutMs?: number;
    /**
     * How long a process may take to honour the first signal before it is killed
     * outright. A command that ignores SIGTERM must not hold the caller forever.
     */
    killGraceMs?: number;
    /**
     * How long the output streams may stay open after the process itself exited.
     * A child of the command can inherit them and keep "close" from ever arriving.
     */
    closeGraceMs?: number;
    /**
     * Signal the whole process group instead of only the command.
     *
     * `docker compose` and `git` run their real work in children of the process this
     * module starts, so signalling the command alone leaves those children behind. The
     * default follows the timeout: a caller that put a bound on the call wants the bound
     * to hold for everything the call created.
     */
    killProcessGroup?: boolean;
}

export interface ChildProcessResult {
    stdout: string | Buffer | undefined;
    stderr: string | Buffer | undefined;
    code: number | null;
    signal: NodeJS.Signals | null;
    killed: boolean;
}

interface ChildProcessError extends Error {
    code: number | null;
    signal: NodeJS.Signals | null;
    killed: boolean;
    stdout: string | Buffer | undefined;
    stderr: string | Buffer | undefined;
}

/** How long a process may ignore the first signal before it is killed outright */
const DEFAULT_KILL_GRACE_MS = 5000;

/** How long the streams may stay open after the process exited */
const DEFAULT_CLOSE_GRACE_MS = 2000;

/**
 * Join the captured chunks into what the caller asked for
 * @param chunks Captured output, or undefined when nothing was captured
 * @param encoding Encoding the caller asked for
 * @returns Text or bytes of the output
 */
function joinChunks(chunks: Buffer[] | undefined, encoding: SpawnOptions["encoding"]) : string | Buffer | undefined {
    if (!chunks) {
        return undefined;
    }

    const buffer = Buffer.concat(chunks);
    return encoding && encoding !== "buffer" ? buffer.toString(encoding) : buffer;
}

/**
 * Spawn a child process and resolve with its captured output.
 *
 * The call always ends within a bounded time: a process that ignores the first signal
 * is killed, and streams that stay open after the exit stop being waited for. Answering
 * the caller is not the same as owning the processes: once this call has ordered a stop,
 * {@link SpawnedGroup} sees it through even after the promise is settled, because the
 * command exiting says nothing about the children it started.
 * @param command Executable to run
 * @param args Command arguments
 * @param options Spawn options and output capture settings
 * @returns Process result
 * @throws {ChildProcessError} If the process exits unsuccessfully
 */
export function spawn(command: string, args: readonly string[], options: SpawnOptions = {}) : Promise<ChildProcessResult> {
    const {
        encoding,
        killSignal,
        maxBuffer,
        timeoutMs,
        killGraceMs,
        closeGraceMs,
        killProcessGroup,
        ...childOptions
    } = options;
    // A command that starts its own children is signalled as a group, which only works
    // when it leads one of its own
    const ownGroup = killProcessGroup ?? timeoutMs !== undefined;
    const child = spawnProcess(command, args, ownGroup ? { ...childOptions,
        detached: true } : childOptions);
    const group = new SpawnedGroup(child, ownGroup, killSignal ?? "SIGTERM", killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    const captureOutput = encoding !== undefined || maxBuffer !== undefined;
    const stdoutChunks = captureOutput && child.stdout ? [] as Buffer[] : undefined;
    const stderrChunks = captureOutput && child.stderr ? [] as Buffer[] : undefined;

    return new Promise((resolve, reject) => {
        let error: Error | undefined;
        let bufferSize = 0;
        let settled = false;
        const bufferLimit = maxBuffer ?? 1024 * 1024;
        let closeTimer: NodeJS.Timeout | undefined;

        /**
         * Ask the command to stop, and tell the caller why.
         * Making it actually stop belongs to the group, which outlives this promise.
         * @param reason Error the caller is told about
         */
        const stopChild = (reason : Error) => {
            error ??= reason;
            group.requestStop();
        };

        const capture = (chunks: Buffer[]) => (data: Buffer | string) => {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const remaining = Math.max(0, bufferLimit - bufferSize);

            if (chunk.length > remaining) {
                // Past the limit nothing is kept: the output is already truncated, and
                // holding the rest would let a noisy command fill the memory anyway
                if (remaining > 0) {
                    bufferSize += remaining;
                    chunks.push(chunk.subarray(0, remaining));
                }
                stopChild(new Error("maxBuffer exceeded"));
                return;
            }

            bufferSize += chunk.length;
            chunks.push(chunk);
        };

        const captureStdout = stdoutChunks ? capture(stdoutChunks) : undefined;
        const captureStderr = stderrChunks ? capture(stderrChunks) : undefined;

        if (captureStdout) {
            child.stdout?.on("data", captureStdout);
        }
        if (captureStderr) {
            child.stderr?.on("data", captureStderr);
        }

        const timer = timeoutMs !== undefined ? setTimeout(() => {
            stopChild(new Error(`Process timed out after ${timeoutMs}ms`));
        }, timeoutMs) : undefined;

        const onError = (childError: Error) => {
            error ??= childError;
        };

        const settle = (code: number | null, signal: NodeJS.Signals | null) => {
            if (settled) {
                return;
            }
            settled = true;

            // Only the waiting stops here: these two timers exist to bound the answer
            for (const pending of [ timer, closeTimer ]) {
                if (pending) {
                    clearTimeout(pending);
                }
            }

            child.removeListener("error", onError);
            child.removeListener("close", onClose);
            child.removeListener("exit", onExit);
            if (captureStdout) {
                child.stdout?.removeListener("data", captureStdout);
            }
            if (captureStderr) {
                child.stderr?.removeListener("data", captureStderr);
            }
            // Streams a grandchild inherited would otherwise keep this process attached
            child.stdout?.destroy();
            child.stderr?.destroy();

            // The caller is about to be answered: what is left of the group is either
            // gone, or under a stop this call ordered and still owes
            group.release();

            const stdout = joinChunks(stdoutChunks, encoding);
            const stderr = joinChunks(stderrChunks, encoding);

            if (error || code !== 0 || signal !== null) {
                const processError = error ?? new Error(
                    signal !== null
                        ? `Process was killed with ${signal}`
                        : `Process exited with code ${code}`,
                );
                const childError = Object.assign(processError, {
                    code,
                    signal,
                    killed: signal !== null,
                    stdout,
                    stderr,
                }) as ChildProcessError;
                reject(childError);
            } else {
                resolve({
                    stdout,
                    stderr,
                    code,
                    signal,
                    killed: false,
                });
            }
        };

        const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
            settle(code, signal);
        };

        /**
         * The command itself is gone. Its output may still be held open by something it
         * started, so the wait for the streams is bounded separately.
         * @param code Exit code of the command
         * @param signal Signal that ended the command
         */
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            if (closeTimer || settled) {
                return;
            }
            closeTimer = setTimeout(() => {
                settle(code, signal);
            }, closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS);
        };

        child.once("error", onError);
        child.once("close", onClose);
        child.on("exit", onExit);
    });
}
