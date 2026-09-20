import type { ComposeTask } from "../../common/compose-progress";

/** Which stack an operation belongs to: one page shows one stack after another */
export interface StackRunTarget {
    /** Agent the stack lives on, empty for this panel */
    endpoint : string;
    /** Name of the stack */
    stack : string;
}

/** How an operation ended, as the progress panel names it */
export type StackRunOutcome = "" | "ok" | "failed" | "unknown";

/** What the progress line reports while a command is running */
export interface StackRunProgress {
    tasks : ComposeTask[];
    hasOutput : boolean;
}

/** How often the seconds are counted and the status is asked again */
const TICK_MS = 2000;

/**
 * The operation one screen is showing, and everything that belongs to it.
 *
 * A stack page is the same component for every stack, so the running command, its clock,
 * its steps and its outcome do not disappear when the user picks another stack - they
 * simply keep running under the new title, and the timer keeps polling for a stack nobody
 * is looking at. So the operation is owned here together with the stack it belongs to:
 * leaving that stack releases it, and an answer that arrives afterwards is told it no
 * longer has a screen.
 *
 * Releasing is about the screen, never about the server: a command that was started keeps
 * running, and the page shows it again as soon as the stack is opened again - through the
 * stack list and the progress line, which read the real state instead of this one.
 */
export class StackRun {

    /** Command that is running, empty when nothing is */
    event = "";

    /** Seconds the command has been running */
    elapsed = 0;

    /** How the last command ended */
    outcome : StackRunOutcome = "";

    /** Steps of the running command, as compose reports them */
    tasks : ComposeTask[] = [];

    /** Whether the command said anything worth opening */
    hasOutput = false;

    /** Stack this operation belongs to, null when no operation is on the screen */
    private target : StackRunTarget | null = null;

    private timer : ReturnType<typeof setInterval> | null = null;

    private startedAt = 0;

    /**
     * @param onTick Called on every tick, where the screen refreshes what it shows
     * @param tickMs How often that happens
     * @param now Clock, so a test does not have to wait in real seconds
     */
    constructor(
        private readonly onTick : () => void = () => undefined,
        private readonly tickMs : number = TICK_MS,
        private readonly now : () => number = () => Date.now(),
    ) {}

    /** Whether a command is running on the screen right now */
    get running() : boolean {
        return this.event !== "";
    }

    /**
     * Whether an answer belongs to the operation the screen is showing
     * @param target Stack the answer was asked for
     * @returns True while that stack is still the one on the screen
     */
    belongsToScreen(target : StackRunTarget) : boolean {
        return this.target !== null
            && this.target.endpoint === target.endpoint
            && this.target.stack === target.stack;
    }

    /**
     * A command was started for a stack: it takes over the screen.
     * @param target Stack the command was sent for
     * @param event Name of the command
     */
    start(target : StackRunTarget, event : string) : void {
        this.stopClock();
        this.target = { endpoint: target.endpoint,
            stack: target.stack };
        this.event = event;
        this.elapsed = 0;
        this.outcome = "";
        this.startedAt = this.now();

        this.timer = setInterval(() => {
            this.elapsed = Math.floor((this.now() - this.startedAt) / 1000);
            this.onTick();
        }, this.tickMs);
    }

    /**
     * The command answered.
     *
     * An answer for a stack that is no longer on the screen changes nothing: its timer
     * and its steps were released when the screen left it, and writing its outcome now
     * would put it under another stack's title.
     * @param target Stack the answer was asked for
     * @param outcome How the command ended
     * @returns Whether the answer was applied to the screen
     */
    finish(target : StackRunTarget, outcome : StackRunOutcome = "") : boolean {
        if (!this.belongsToScreen(target)) {
            return false;
        }

        this.event = "";
        this.outcome = outcome;
        this.stopClock();
        return true;
    }

    /**
     * What compose is doing right now, reported by the progress line
     * @param target Stack the progress belongs to
     * @param progress Steps and whether there is output to open
     * @returns Whether the progress was applied to the screen
     */
    setProgress(target : StackRunTarget, progress : StackRunProgress) : boolean {
        if (this.target !== null && !this.belongsToScreen(target)) {
            return false;
        }

        this.tasks = progress.tasks;
        this.hasOutput = progress.hasOutput;
        return true;
    }

    /**
     * The screen moved on: another stack, another page, or the page is gone.
     *
     * Only the view is released. Nothing here stops a command on the server, and no
     * answer of the released operation reaches the screen afterwards.
     */
    release() : void {
        this.stopClock();
        this.target = null;
        this.event = "";
        this.elapsed = 0;
        this.outcome = "";
        this.tasks = [];
        this.hasOutput = false;
    }

    /** Stop counting: the timer belongs to the operation, not to the page */
    private stopClock() : void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}
