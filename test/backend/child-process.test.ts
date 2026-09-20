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

test("spawn force kills a child process that ignores the soft signal", async () => {
    const start = Date.now();

    await assert.rejects(
        spawn(process.execPath, [
            "-e",
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ], {
            encoding: "utf8",
            timeoutMs: 150,
            killGraceMs: 200,
        }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /timed out after 150ms/);
            const childError = error as ChildProcessError & { signal: NodeJS.Signals | null };
            assert.equal(childError.signal, "SIGKILL");
            return true;
        },
    );

    assert.ok(Date.now() - start < 5000, "the call has to end without waiting for the process to agree");
});

test("spawn leaves no process it started when the timeout forces a kill", async () => {
    let grandchildPid = 0;

    await assert.rejects(
        spawn(process.execPath, [
            "-e",
            [
                "const { spawn } = require('node:child_process');",
                "const child = spawn(process.execPath, [ '-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\" ], { stdio: 'ignore' });",
                "process.stdout.write(String(child.pid));",
                "process.on('SIGTERM', () => {});",
                "setInterval(() => {}, 1000);",
            ].join("\n"),
        ], {
            encoding: "utf8",
            timeoutMs: 300,
            killGraceMs: 200,
        }),
        (error: unknown) => {
            const childError = error as ChildProcessError;
            grandchildPid = Number(childError.stdout);
            return true;
        },
    );

    assert.ok(grandchildPid > 0, "the test needs the pid of the process the command started");

    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
        try {
            process.kill(grandchildPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
            alive = false;
        }
    }

    assert.equal(alive, false, "a process started by the command must not outlive it");
});

test("spawn stops capturing output once the buffer limit is exceeded", async () => {
    await assert.rejects(
        spawn(process.execPath, [
            "-e",
            "process.stdout.write('x'.repeat(200000)); setInterval(() => {}, 1000);",
        ], {
            encoding: "utf8",
            maxBuffer: 1000,
            killGraceMs: 200,
        }),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "maxBuffer exceeded");
            const childError = error as ChildProcessError;
            assert.equal(childError.stdout?.length, 1000);
            return true;
        },
    );
});

test("spawn stops waiting when something the command started holds its output open", async () => {
    const start = Date.now();
    const result = await spawn(process.execPath, [
        "-e",
        [
            "const { spawn } = require('node:child_process');",
            "spawn(process.execPath, [ '-e', 'setTimeout(() => {}, 4000);' ], { stdio: [ 'ignore', 'inherit', 'inherit' ], detached: true }).unref();",
            "process.stdout.write('done');",
        ].join("\n"),
    ], {
        encoding: "utf8",
        closeGraceMs: 200,
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "done");
    assert.ok(Date.now() - start < 3000, "the streams must not be waited for longer than the command itself");
});

/** A child that survives SIGTERM, so only a real kill ends it */
const STUBBORN_CHILD = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

/**
 * A command that starts such a child and then obeys SIGTERM itself
 * @param stdio How the child of the command gets its streams
 * @returns Script for `node -e`
 */
function commandThatObeysAndLeavesAChild(stdio : string) : string {
    return [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, [ '-e', ${JSON.stringify(STUBBORN_CHILD)} ], { stdio: ${JSON.stringify(stdio)} });`,
        "process.stdout.write(String(child.pid));",
        "process.on('SIGTERM', () => { process.exit(0); });",
        "setInterval(() => {}, 1000);",
    ].join("\n");
}

/**
 * Whether a process is still there, asked without delivering a signal
 * @param pid Process to ask about
 * @returns True while the process exists
 */
function isAlive(pid : number) : boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Wait until a process is gone
 * @param pid Process to wait for
 * @param timeoutMs How long to wait at most
 * @returns True when the process ended within that time
 */
async function waitForExit(pid : number, timeoutMs : number) : Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (!isAlive(pid)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !isAlive(pid);
}

/**
 * Leave nothing of a test behind, whatever the assertions did
 * @param pid Process the test created, if it learned the number at all
 */
function killLeftover(pid : number) : void {
    if (pid > 0 && isAlive(pid)) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // Already gone between the check and the signal
        }
    }
}

test("a command that obeys the stop signal does not cancel the kill of the child it left", async () => {
    let grandchildPid = 0;

    try {
        await assert.rejects(
            // The command exits on SIGTERM while its child ignores it and keeps the
            // output open, so the promise is answered by the stream deadline
            spawn(process.execPath, [ "-e", commandThatObeysAndLeavesAChild("inherit") ], {
                encoding: "utf8",
                timeoutMs: 300,
                killGraceMs: 600,
                closeGraceMs: 100,
            }),
            (error : unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /timed out after 300ms/);
                grandchildPid = Number((error as ChildProcessError).stdout);
                return true;
            },
        );

        assert.ok(grandchildPid > 0, "the test needs the pid of the process the command started");

        // This is the moment the defect hid in: the caller already has its answer
        assert.equal(isAlive(grandchildPid), true, "the scenario requires a child that is still running when the call ends");
        assert.equal(await waitForExit(grandchildPid, 3000), true, "the stop this call ordered has to reach the child as well");
    } finally {
        killLeftover(grandchildPid);
    }
});

test("the kill of a left over child also survives an answer given as soon as the streams close", async () => {
    let grandchildPid = 0;

    try {
        await assert.rejects(
            // With its own streams the child holds nothing open, so "close" arrives right
            // after the command exits and the promise is settled long before the grace ends
            spawn(process.execPath, [ "-e", commandThatObeysAndLeavesAChild("ignore") ], {
                encoding: "utf8",
                timeoutMs: 300,
                killGraceMs: 600,
            }),
            (error : unknown) => {
                grandchildPid = Number((error as ChildProcessError).stdout);
                return true;
            },
        );

        assert.ok(grandchildPid > 0, "the test needs the pid of the process the command started");
        assert.equal(isAlive(grandchildPid), true, "the scenario requires a child that is still running when the call ends");
        assert.equal(await waitForExit(grandchildPid, 3000), true, "the stop this call ordered has to reach the child as well");
    } finally {
        killLeftover(grandchildPid);
    }
});

test("a command that finished on its own keeps the work it started in the background", async () => {
    let grandchildPid = 0;

    try {
        const result = await spawn(process.execPath, [
            "-e",
            [
                "const { spawn } = require('node:child_process');",
                "const child = spawn(process.execPath, [ '-e', 'setTimeout(() => {}, 5000);' ], { stdio: 'ignore' });",
                "child.unref();",
                "process.stdout.write(String(child.pid));",
            ].join("\n"),
        ], {
            encoding: "utf8",
            timeoutMs: 5000,
            killGraceMs: 200,
        });

        grandchildPid = Number(result.stdout);
        assert.equal(result.code, 0);
        assert.ok(grandchildPid > 0);

        // Nothing was ever told to stop here, so nothing is: a helper a successful
        // command leaves behind is its business, not something this call may kill
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(isAlive(grandchildPid), true, "a successful command must not have its background work killed");
    } finally {
        killLeftover(grandchildPid);
    }
});
