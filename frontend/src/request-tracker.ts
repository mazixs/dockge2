/**
 * Which answers still belong to what is on the screen.
 *
 * A stack page is one component for every stack: choosing another stack does not build a
 * new screen, it changes the name. An answer to a request sent before that change arrives
 * all the same, and applied as it is, it puts the previous stack's services, availability
 * or statistics under the current stack's title. Answers are slow in exactly the cases
 * where this matters, so the order they arrive in is not the order they were asked in.
 *
 * Every selection gets a generation. A request remembers the generation it left with, and
 * an answer that comes back for an older one is dropped. The same object also keeps one
 * request per kind of data in flight: a poll whose answer is slow used to be asked again
 * by the next tick, and the queue grew instead of the screen getting faster.
 */
export class RequestTracker {

    protected generationValue = 0;

    /** Which generation the request of each kind currently in flight belongs to */
    protected running : Map<string, number> = new Map();

    /** The generation requests are being sent with now */
    get generation() : number {
        return this.generationValue;
    }

    /**
     * Begin a new selection: everything asked before this belongs to the previous screen
     * @returns The generation to send requests with
     */
    next() : number {
        this.generationValue++;
        return this.generationValue;
    }

    /**
     * Whether an answer from this generation may still change the screen
     * @param generation Generation the request left with
     * @returns True when it is the current one
     */
    isCurrent(generation : number) : boolean {
        return generation === this.generationValue;
    }

    /**
     * Whether a request of this kind is waiting for its answer
     * @param kind Name of the data being read
     * @returns True when one is in flight
     */
    busy(kind : string) : boolean {
        return this.running.has(kind);
    }

    /**
     * Send one request of a kind at a time, and answer only while it is still current.
     *
     * Null means "nothing to apply": either the request was not sent because one of its
     * kind is already waiting, or the answer arrived for a selection that is gone. The
     * caller does not have to tell those apart - in both cases the screen stays as it is.
     * @param kind Name of the data being read, unique per screen
     * @param generation Generation the caller is working for
     * @param request How to ask
     * @returns The answer, or null when it must not be applied
     */
    async run<T>(kind : string, generation : number, request : () => Promise<T>) : Promise<T | null> {
        // Only a request of the same selection blocks: one left over from the stack that
        // was open before must not keep the current screen from reading anything
        if (!this.isCurrent(generation) || this.running.get(kind) === generation) {
            return null;
        }

        this.running.set(kind, generation);

        let answer : T;

        try {
            answer = await request();
        } finally {
            if (this.running.get(kind) === generation) {
                this.running.delete(kind);
            }
        }

        return this.isCurrent(generation) ? answer : null;
    }

    /**
     * Drop everything that is still on its way, used when the screen goes away
     * @returns void
     */
    invalidate() : void {
        this.generationValue++;
    }
}
