/** An entry owns its value until replacement, eviction or an actively enforced deadline. */
interface Entry<T> {
    value : T;
    bytes : number;
    expires : number;
}

/** Small, byte-accounted LRU with one unreferenced expiry timer. */
export class BoundedCache<T> {
    private items = new Map<string, Entry<T>>();
    private used = 0;
    private timer : ReturnType<typeof setTimeout> | undefined;

    constructor(private maxBytes : number, private maxEntries : number, private ttlMs : number) {}

    /** Retained payload estimate; object overhead is bounded by maxEntries. */
    get bytes() : number {
        return this.used;
    }

    /** Number of owned entries, including none after idle expiry. */
    get size() : number {
        return this.items.size;
    }

    /** Read a live entry, moving it to the most recently used position. */
    get(key : string, now = Date.now()) : T | undefined {
        const entry = this.items.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expires <= now) {
            this.delete(key);
            return undefined;
        }
        this.items.delete(key);
        this.items.set(key, entry);
        return entry.value;
    }

    /** Admit a value, evicting oldest entries; oversized values are not retained. */
    set(key : string, value : T, bytes : number, now = Date.now()) : boolean {
        this.delete(key);
        if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxBytes) {
            return false;
        }
        while (this.items.size >= this.maxEntries || this.used + bytes > this.maxBytes) {
            const oldest = this.items.keys().next().value;
            if (oldest === undefined) {
                return false;
            }
            this.delete(oldest);
        }
        this.items.set(key, { value,
            bytes,
            expires: now + this.ttlMs });
        this.used += bytes;
        this.schedule();
        return true;
    }

    /** Iterate owned values for explicit domain invalidation. */
    *entries() : IterableIterator<[string, T]> {
        for (const [ key, entry ] of this.items) {
            yield [ key, entry.value ];
        }
    }

    /** Release a single value. */
    delete(key : string) : void {
        const entry = this.items.get(key);
        if (entry) {
            this.used -= entry.bytes;
            this.items.delete(key);
        }
        if (!this.items.size) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    /** Release all values and the expiry timer. */
    clear() : void {
        this.items.clear();
        this.used = 0;
        clearTimeout(this.timer);
        this.timer = undefined;
    }

    private schedule() : void {
        clearTimeout(this.timer);
        if (!this.items.size) {
            return;
        }
        const earliest = Math.min(...[ ...this.items.values() ].map(item => item.expires));
        this.timer = setTimeout(() => {
            const now = Date.now();
            for (const [ key, entry ] of this.items) {
                if (entry.expires <= now) {
                    this.delete(key);
                }
            }
            this.schedule();
        }, Math.max(1, earliest - Date.now()));
        this.timer.unref?.();
    }
}
