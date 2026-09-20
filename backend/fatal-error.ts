/** How long cleanup may take after a fatal error before the process leaves anyway */
const DEFAULT_FATAL_TIMEOUT_MS = 5000;

export interface FatalErrorOptions {
    /** Bounded cleanup to run before the process exits */
    stop? : () => Promise<unknown>;
    /** How long that cleanup may take */
    timeoutMs? : number;
    /** How the process ends, replaceable so a test can observe it */
    exit? : (code : number) => void;
    /** Where the diagnostics go */
    report? : (kind : string, error : unknown) => void;
}

/**
 * Print what happened before the process goes away
 * @param kind Which handler caught it
 * @param error What was caught
 */
function defaultReport(kind : string, error : unknown) : void {
    console.trace(error);
    console.error(`Fatal: ${kind}. The process is stopping because its state is no longer known.`);
    console.error("If you keep encountering errors, please report to https://github.com/mazixs/dockge2");
}

/**
 * Build the handler that treats an error nobody handled as the end of this process.
 *
 * Logging and carrying on is what Node warns against: after an unhandled error the
 * process may hold half-applied state, and a panel that keeps serving from it is worse
 * than one that restarts. Expected failures belong at the operation that can answer for
 * them, and deliberate background work says so with runInBackground().
 * @param options How to clean up and how to leave
 * @returns The handler, separate from the listeners so it can be called directly
 */
export function createFatalErrorHandler(options : FatalErrorOptions = {}) : (kind : string, error : unknown) => void {
    const exit = options.exit ?? ((code : number) => process.exit(code));
    const report = options.report ?? defaultReport;
    const timeoutMs = options.timeoutMs ?? DEFAULT_FATAL_TIMEOUT_MS;
    let leaving = false;

    return (kind : string, error : unknown) => {
        report(kind, error);

        // A second error while the first one is being cleaned up must not restart the exit
        if (leaving) {
            return;
        }
        leaving = true;

        if (!options.stop) {
            exit(1);
            return;
        }

        // Cleanup is given a chance, never the last word: a cleanup that hangs would
        // leave exactly the half-running process this handler exists to prevent
        const force = setTimeout(() => exit(1), timeoutMs);

        void options.stop()
            .catch(() => undefined)
            .then(() => {
                clearTimeout(force);
                exit(1);
            });
    };
}

/**
 * Listen for the errors Node reports as unhandled and end the process on them.
 * @param options How to clean up and how to leave
 * @returns A function that removes the handlers again
 */
export function installFatalErrorHandlers(options : FatalErrorOptions = {}) : () => void {
    const fatal = createFatalErrorHandler(options);
    const onRejection = (error : unknown) => fatal("unhandled promise rejection", error);
    const onException = (error : unknown) => fatal("uncaught exception", error);

    process.addListener("unhandledRejection", onRejection);
    process.addListener("uncaughtException", onException);

    return () => {
        process.removeListener("unhandledRejection", onRejection);
        process.removeListener("uncaughtException", onException);
    };
}
