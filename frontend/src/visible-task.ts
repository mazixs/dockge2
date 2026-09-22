/** Browser visibility surface, injectable without emulating a DOM in unit tests. */
export interface VisibilitySource extends EventTarget {
    readonly hidden : boolean;
}

/**
 * A page-owned periodic task. Hidden pages do no work and resume with one refresh.
 * Callers retain ownership of requests/commands; this only controls idle scheduling.
 */
export class VisibleTask {
    private timer : ReturnType<typeof setTimeout> | undefined;
    private started = false;
    private onVisibility = () => {
        clearTimeout(this.timer);
        if (!this.source.hidden) {
            this.tick();
        }
    };

    constructor(private source : VisibilitySource, private intervalMs : number, private run : () => void) {}

    /** Start once, refreshing immediately if the document is visible. */
    start() : void {
        if (!this.started) {
            this.started = true;
            this.source.addEventListener("visibilitychange", this.onVisibility);
            this.onVisibility();
        }
    }

    private tick() : void {
        if (!this.started || this.source.hidden) {
            return;
        }
        this.run();
        this.timer = setTimeout(() => this.tick(), this.intervalMs);
    }

    /** Release both the timer and its visibility listener. */
    stop() : void {
        this.started = false;
        clearTimeout(this.timer);
        this.source.removeEventListener("visibilitychange", this.onVisibility);
    }
}
