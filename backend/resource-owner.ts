import { log } from "./log";

/** What stopping one resource can end with */
export interface ResourceStopOutcome {
    name : string;
    /** Why the resource did not stop cleanly, absent when it did */
    error? : string;
    /** True when the resource did not finish inside its share of the budget */
    timedOut? : boolean;
}

/** What a whole shutdown ended with */
export interface ResourceStopReport {
    stopped : string[];
    failed : ResourceStopOutcome[];
    timedOut : string[];
    durationMs : number;
}

/** How long a shutdown may take in total when the caller names no budget */
export const DEFAULT_STOP_TIMEOUT_MS = 15_000;

/** The least time one resource is given, so a long list cannot starve the last entry */
const MIN_RESOURCE_BUDGET_MS = 500;

/**
 * Everything this process started and therefore has to stop.
 *
 * The point is not tidiness: a timer that survives the database is a task that queries a
 * closed connection, and a terminal nobody stops is a process outliving the panel. So
 * every background task registers here, the flag tells running work that no new job
 * should start, and stop() goes through the list once, in reverse order of registration,
 * within a bounded time even when one of the entries refuses to finish.
 */
export class ResourceOwner {

    protected resources : { name : string, stop : () => unknown | Promise<unknown> }[] = [];
    protected stopPromise? : Promise<ResourceStopReport>;
    protected stoppingFlag = false;

    /**
     * Whether the process is on its way out.
     *
     * Periodic work asks this before starting another round: a job that begins during the
     * shutdown would either be cut off halfway or hold the exit back.
     * @returns True once stop() has been called
     */
    get stopping() : boolean {
        return this.stoppingFlag;
    }

    /**
     * Register something that has to be stopped before the process exits.
     *
     * Resources are stopped in reverse order, so whatever is registered first - the
     * database, as a rule - is released last, after its users are gone.
     * @param name Name used in the shutdown log
     * @param stop How to stop it, synchronously or not
     * @returns A function that unregisters the resource when it ends on its own
     */
    add(name : string, stop : () => unknown | Promise<unknown>) : () => void {
        const entry = { name,
            stop };
        this.resources.push(entry);

        return () => {
            const index = this.resources.indexOf(entry);
            if (index >= 0) {
                this.resources.splice(index, 1);
            }
        };
    }

    /**
     * Register a timer, which is the most common resource here.
     * @param name Name used in the shutdown log
     * @param timer Interval or timeout to clear
     * @returns A function that unregisters the timer
     */
    addTimer(name : string, timer : NodeJS.Timeout) : () => void {
        return this.add(name, () => clearInterval(timer));
    }

    /** How many resources are still registered */
    get size() : number {
        return this.resources.length;
    }

    /**
     * Stop everything once, within a bounded time.
     *
     * A second call does not start a second shutdown: it waits for the first one, because
     * two signals in a row must not run cleanup twice. One resource that fails or hangs
     * does not keep the others from being stopped - that is the whole reason the budget
     * is split per resource.
     * @param timeoutMs Total budget for the shutdown
     * @returns What was stopped, what failed and what ran out of time
     */
    async stop(timeoutMs : number = DEFAULT_STOP_TIMEOUT_MS) : Promise<ResourceStopReport> {
        if (this.stopPromise) {
            return this.stopPromise;
        }

        this.stoppingFlag = true;
        this.stopPromise = this.stopAll(timeoutMs);
        return this.stopPromise;
    }

    /**
     * Go through the list, newest first
     * @param timeoutMs Total budget for the shutdown
     * @returns What was stopped, what failed and what ran out of time
     */
    protected async stopAll(timeoutMs : number) : Promise<ResourceStopReport> {
        const startedAt = Date.now();
        const report : ResourceStopReport = { stopped: [],
            failed: [],
            timedOut: [],
            durationMs: 0 };
        const pending = [ ...this.resources ].reverse();
        this.resources = [];

        for (let index = 0; index < pending.length; index++) {
            const entry = pending[index];

            if (!entry) {
                continue;
            }

            const left = timeoutMs - (Date.now() - startedAt);
            // The minimum keeps a long list from starving its last entries, but it is not
            // allowed to outlive the budget itself: a shutdown asked to take 100ms took
            // 500 because one resource was given a floor larger than the whole budget
            const share = Math.max(0, Math.min(left, Math.max(MIN_RESOURCE_BUDGET_MS, Math.floor(left / (pending.length - index)))));
            const outcome = await this.stopOne(entry, share);

            if (outcome.timedOut) {
                report.timedOut.push(entry.name);
                report.failed.push(outcome);
            } else if (outcome.error !== undefined) {
                report.failed.push(outcome);
            } else {
                report.stopped.push(entry.name);
            }
        }

        report.durationMs = Date.now() - startedAt;
        return report;
    }

    /**
     * Stop one resource without letting it hold the shutdown
     * @param entry Resource to stop
     * @param budgetMs How long this resource may take
     * @returns How it ended
     */
    protected async stopOne(entry : { name : string, stop : () => unknown | Promise<unknown> }, budgetMs : number) : Promise<ResourceStopOutcome> {
        let timer : NodeJS.Timeout | undefined;

        try {
            const result = entry.stop();

            if (result instanceof Promise) {
                const expired = Symbol("expired");
                // Not unref'd on purpose: this timer is the bound, and a bound that an
                // empty event loop can skip would leave the shutdown unfinished
                const deadline = new Promise<symbol>((resolve) => {
                    timer = setTimeout(() => resolve(expired), budgetMs);
                });

                if (await Promise.race([ result.then(() => undefined), deadline ]) === expired) {
                    log.warn("shutdown", `${entry.name} did not stop within ${budgetMs}ms`);
                    return { name: entry.name,
                        timedOut: true,
                        error: `did not stop within ${budgetMs}ms` };
                }
            }

            return { name: entry.name };
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            log.error("shutdown", `${entry.name} failed to stop: ${message}`);
            return { name: entry.name,
                error: message };
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }
}
