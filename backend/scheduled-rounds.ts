import { Cron } from "croner";
import { log } from "./log";

/**
 * Periodic work that a shutdown can actually wait for.
 *
 * Stopping a schedule is two separate things: no further round may start, and the round
 * already running has to finish before what it uses is taken away. `Cron.stop()` only
 * does the first, so a stop that returns at once lets a round that is waiting on Docker
 * come back to a database somebody closed behind it. This class keeps the running round,
 * which makes `stop()` a promise the resource owner can wait on inside its budget - and
 * a round that never finishes then shows up as a resource that timed out, not as work
 * that quietly continued.
 */
export class ScheduledRounds {

    /** The schedule while it is running */
    private cron : Cron | undefined;

    /** The round that is running right now, so a stop can wait for exactly it */
    private active : Promise<void> | undefined;

    /** Set by stop(): no further round starts, whatever the schedule still fires */
    private stoppingFlag = false;

    /**
     * @param name Name used in the log of a failed round
     * @param pattern Cron pattern, with seconds
     * @param round One round of work
     */
    constructor(
        private readonly name : string,
        private readonly pattern : string,
        private readonly round : () => Promise<void>,
    ) {}

    /** Whether a round is running at this moment */
    get running() : boolean {
        return this.active !== undefined;
    }

    /** Start the schedule; starting twice, or after a stop, does nothing */
    start() : void {
        if (this.cron || this.stoppingFlag) {
            return;
        }

        this.cron = new Cron(this.pattern, { protect: true }, () => this.runOnce());
    }

    /**
     * Run one round and remember it while it lasts.
     *
     * A round that fails is logged rather than thrown into the scheduler: the promise
     * this returns says when the round is over, not whether it went well.
     * @returns The round that is running now
     */
    private runOnce() : Promise<void> {
        if (this.stoppingFlag) {
            return Promise.resolve();
        }

        if (this.active) {
            return this.active;
        }

        const current : Promise<void> = this.round()
            .catch((e) => log.error("schedule", `${this.name} failed: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => {
                if (this.active === current) {
                    this.active = undefined;
                }
            });

        this.active = current;
        return current;
    }

    /**
     * Stop the schedule and wait for the round that is still running.
     *
     * The caller decides how long it is willing to wait: this promise is handed to the
     * resource owner, which bounds it like every other resource.
     */
    async stop() : Promise<void> {
        this.stoppingFlag = true;
        this.cron?.stop();
        this.cron = undefined;
        await this.active;
    }
}
