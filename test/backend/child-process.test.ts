import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "../../backend/child-process";

interface ChildProcessError extends Error {
    code: number | null;
    stdout?: string;
    stderr?: string;
}

test("spawn captures stdout and stderr from a real child process", async () => {
    const result = await spawn(process.execPath, [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err');",
    ], {
        encoding: "utf8",
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
});

test("spawn rejects with output and exit code for a failed child process", async () => {
    await assert.rejects(
        spawn(process.execPath, [
            "-e",
            "process.stderr.write('bad'); process.exit(3);",
        ], {
            encoding: "utf8",
        }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            const childError = error as ChildProcessError;
            assert.equal(childError.code, 3);
            assert.equal(childError.stdout, "");
            assert.equal(childError.stderr, "bad");
            return true;
        },
    );
});

test("spawn kills a real child process that exceeds the timeout", async () => {
    await assert.rejects(
        spawn(process.execPath, [
            "-e",
            "setTimeout(() => {}, 10000);",
        ], {
            encoding: "utf8",
            timeoutMs: 150,
        }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /timed out after 150ms/);
            const childError = error as ChildProcessError & { killed: boolean };
            assert.equal(childError.killed, true);
            return true;
        },
    );
});
