import type { ChildProcess } from "node:child_process";
import { log } from "./log";

/**
 * The processes one command started, owned apart from the promise that reports it.
 *
 * The promise ends when the caller has an answer. The processes end when nothing of them
 * runs any more, and that is not the same moment: `docker compose` and `git` do their
 * work in children, so the command can exit while what it started is still running and
 * still holding the output open. Keeping the two apart is the point of this class - an
 * answer given to the caller must never cancel a stop that was already ordered, or the
 * caller is told the call is over while the work continues.
 */
export class SpawnedGroup {

    /** Pending escalation to SIGKILL; it outlives the promise on purpose */
    private killTimer : NodeJS.Timeout | undefined;

    /**
     * @param child Process the command started
     * @param leadsGroup Whether that process leads a process group of its own
     * @param stopSignal Signal a stop starts with
     * @param graceMs How long the group may take to honour that signal
     */
    constructor(
        private readonly child : ChildProcess,
        private readonly leadsGroup : boolean,
        private readonly stopSignal : NodeJS.Signals | number,
        private readonly graceMs : number,
    ) {}

    /**
     * Whether anything of this command is still running.
     *
     * Signal 0 asks the kernel without delivering anything, and asking the group rather
     * than the process is what makes a surviving child visible at all.
     * @returns True while at least one process of the command is alive
     */
    get alive() : boolean {
        if (this.child.pid === undefined) {
            // The command never started: there is nothing to signal or wait for
            return false;
        }

        if (this.leadsGroup) {
            try {
                process.kill(-this.child.pid, 0);
                return true;
            } catch (e) {
                return false;
            }
        }

        return this.child.exitCode === null && this.child.signalCode === null;
    }

    /**
     * Send a signal to the whole group, or to the command alone when it leads none
     * @param signal Signal to send
     */
    signal(signal : NodeJS.Signals | number) : void {
        if (this.leadsGroup && this.child.pid) {
            try {
                process.kill(-this.child.pid, signal);
                return;
            } catch (e) {
                // The group is already gone, or this platform has none: fall back
            }
        }

        this.child.kill(signal);
    }

    /**
     * Order the group to stop, and make sure it really does.
     *
     * The escalation is not tied to the promise: a command that obeys the first signal
     * and exits proves nothing about the children it started, and those children are what
     * this call has to stop. The timer is therefore kept referenced - the panel may take
     * the grace period to exit, but it does not walk away from processes it told to stop.
     */
    requestStop() : void {
        this.signal(this.stopSignal);

        if (this.killTimer) {
            return;
        }

        this.killTimer = setTimeout(() => {
            this.killTimer = undefined;

            if (!this.alive) {
                return;
            }

            // Nothing else will make it stop, and the caller was told the call ended
            log.warn("process-group", `A process started by a command that was stopped is still running after ${this.graceMs}ms, killing the group of ${this.child.pid}`);
            this.signal("SIGKILL");
        }, this.graceMs);
    }

    /**
     * The caller has its answer; decide what is left to do about the processes.
     *
     * A stop that was ordered stays on until the group is really gone. A command that
     * finished on its own is left alone, including anything it started deliberately in
     * the background: this call never asked those to stop, and killing them would end
     * work the user did not cancel.
     */
    release() : void {
        if (this.killTimer && !this.alive) {
            clearTimeout(this.killTimer);
            this.killTimer = undefined;
        }
    }
}
