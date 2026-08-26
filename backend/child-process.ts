import { spawn as spawnProcess, type SpawnOptions as NodeSpawnOptions } from "node:child_process";

export interface SpawnOptions extends NodeSpawnOptions {
    encoding?: BufferEncoding | "buffer";
    maxBuffer?: number;
    killSignal?: NodeJS.Signals | number;
    timeoutMs?: number;
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

function joinChunks(chunks: Buffer[] | undefined, encoding: SpawnOptions["encoding"]) : string | Buffer | undefined {
    if (!chunks) {
        return undefined;
    }

    const buffer = Buffer.concat(chunks);
    return encoding && encoding !== "buffer" ? buffer.toString(encoding) : buffer;
}

/**
 * Spawn a child process and resolve with its captured output.
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
        ...childOptions
    } = options;
    const child = spawnProcess(command, args, childOptions);
    const captureOutput = encoding !== undefined || maxBuffer !== undefined;
    const stdoutChunks = captureOutput && child.stdout ? [] as Buffer[] : undefined;
    const stderrChunks = captureOutput && child.stderr ? [] as Buffer[] : undefined;

    return new Promise((resolve, reject) => {
        let error: Error | undefined;
        let bufferSize = 0;
        const bufferLimit = maxBuffer ?? 1024 * 1024;

        const capture = (chunks: Buffer[]) => (data: Buffer | string) => {
            const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const remaining = Math.max(0, bufferLimit - bufferSize);
            bufferSize += Math.min(remaining, chunk.length);

            if (chunk.length > remaining) {
                error = new Error("maxBuffer exceeded");
                child.kill(killSignal ?? "SIGTERM");
                chunks.push(chunk.subarray(0, remaining));
            } else {
                chunks.push(chunk);
            }
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
            error = new Error(`Process timed out after ${timeoutMs}ms`);
            child.kill(killSignal ?? "SIGTERM");
        }, timeoutMs) : undefined;

        const onError = (childError: Error) => {
            error = childError;
        };

        const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
            if (timer) {
                clearTimeout(timer);
            }
            child.removeListener("error", onError);
            child.removeListener("close", onClose);
            if (captureStdout) {
                child.stdout?.removeListener("data", captureStdout);
            }
            if (captureStderr) {
                child.stderr?.removeListener("data", captureStderr);
            }

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

        child.once("error", onError);
        child.once("close", onClose);
    });
}
