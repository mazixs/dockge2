import assert from "node:assert/strict";
import test from "node:test";
import { createFatalErrorHandler, installFatalErrorHandlers } from "../../backend/fatal-error";
import { spawn } from "../../backend/child-process";

test("an uncaught exception ends the process instead of leaving it serving", async () => {
    const script = [
        "import { installFatalErrorHandlers } from './backend/fatal-error';",
        "installFatalErrorHandlers();",
        // Something that would keep the process alive and serving, exactly what must not happen
        "setInterval(() => {}, 1000);",
        "setTimeout(() => { throw new Error('boom'); }, 10);",
    ].join("\n");

    await assert.rejects(
        spawn(process.execPath, [ "--import", "tsx", "--input-type=module", "-e", script ], {
            encoding: "utf8",
            timeoutMs: 30_000,
            cwd: process.cwd(),
        }),
        (error : unknown) => {
            const exit = error as { code : number | null, signal : string | null };
            assert.equal(exit.signal, null, "the process has to leave on its own, not be killed by the test");
            assert.notEqual(exit.code, 0);
            return true;
        },
    );
});

test("an unhandled rejection ends the process as well", async () => {
    const script = [
        "import { installFatalErrorHandlers } from './backend/fatal-error';",
        "installFatalErrorHandlers();",
        "setInterval(() => {}, 1000);",
        "setTimeout(() => { Promise.reject(new Error('nobody waits for me')); }, 10);",
    ].join("\n");

    await assert.rejects(
        spawn(process.execPath, [ "--import", "tsx", "--input-type=module", "-e", script ], {
            encoding: "utf8",
            timeoutMs: 30_000,
            cwd: process.cwd(),
        }),
        (error : unknown) => {
            const exit = error as { code : number | null };
            assert.notEqual(exit.code, 0);
            return true;
        },
    );
});

test("cleanup runs before the exit and cannot delay it forever", async () => {
    const exits : number[] = [];
    let cleanupCalls = 0;

    const fatal = createFatalErrorHandler({
        stop: async () => {
            cleanupCalls++;
        },
        exit: (code) => exits.push(code),
        report: () => undefined,
    });

    fatal("uncaught exception", new Error("first"));
    // A second error while leaving must not start another exit
    fatal("uncaught exception", new Error("second"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(cleanupCalls, 1);
    assert.deepEqual(exits, [ 1 ]);
});

test("a cleanup that hangs still lets the process leave", async () => {
    const exits : number[] = [];

    const fatal = createFatalErrorHandler({
        stop: () => new Promise(() => {}),
        timeoutMs: 50,
        exit: (code) => exits.push(code),
        report: () => undefined,
    });

    fatal("unhandled promise rejection", new Error("stuck"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.deepEqual(exits, [ 1 ]);
});

test("the handlers are removed again when the caller asks", () => {
    const before = process.listenerCount("uncaughtException");
    const remove = installFatalErrorHandlers({ exit: () => undefined,
        report: () => undefined });

    assert.equal(process.listenerCount("uncaughtException"), before + 1);
    remove();
    assert.equal(process.listenerCount("uncaughtException"), before);
});
