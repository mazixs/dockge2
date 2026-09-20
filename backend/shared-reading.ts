/**
 * One reading of something expensive, shared by everyone who wants it.
 *
 * Several open screens ask the same question at the same moment - host statistics are
 * the case this was written for - and each answer used to start its own Docker call.
 * Here the first caller starts the reading, everyone who arrives while it runs waits for
 * that same reading, and the result is handed out as it is for a short while. A failed
 * reading is not remembered: the next caller tries again rather than being told about an
 * error that may already be over.
 */
export class SharedReading<T> {

    protected value : T | undefined = undefined;
    protected readAt = 0;
    protected request : Promise<T> | undefined = undefined;

    /**
     * @param read How to produce the value
     * @param ttlMs How long a value may be handed out again
     */
    constructor(protected read : () => Promise<T>, protected ttlMs : number) {
    }

    /**
     * The value, read now or taken from the last reading
     * @param now Current time, injectable for tests
     * @returns The value
     */
    async get(now : number = Date.now()) : Promise<T> {
        if (this.value !== undefined && now - this.readAt < this.ttlMs) {
            return this.value;
        }

        if (this.request) {
            return this.request;
        }

        this.request = this.read().then((value) => {
            this.value = value;
            this.readAt = Date.now();
            return value;
        }).finally(() => {
            this.request = undefined;
        });

        return this.request;
    }

    /**
     * Forget what was read, so the next caller asks again
     * @returns void
     */
    invalidate() : void {
        this.value = undefined;
        this.readAt = 0;
    }
}
