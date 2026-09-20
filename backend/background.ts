import { log } from "./log";

/**
 * Start work nobody waits for, and make sure its failure is still reported.
 *
 * A broadcast after an operation is deliberately not awaited: the caller already answered
 * the client and the list is a courtesy. Left as a bare call, though, a rejection becomes
 * an unhandled rejection, which loses the context of what was being sent and - now that
 * an unhandled rejection ends the process - would take the server down over a broadcast.
 * Naming the task here keeps both the context and the choice visible.
 * @param name What the task was doing, as it appears in the log
 * @param task The work to start
 */
export function runInBackground(name : string, task : () => Promise<unknown>) : void {
    void (async () => {
        try {
            await task();
        } catch (e) {
            log.error("background", `${name} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    })();
}
