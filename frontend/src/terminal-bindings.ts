/** Bind acknowledgements only while the requesting terminal still owns the name. */
export class TerminalBindings<T> {
    private pending = new Map<string, symbol>();
    private active = new Map<string, T>();

    /** Reserve a name, invalidating an earlier pending join of that name. */
    begin(name : string) : symbol {
        const token = Symbol(name);
        this.pending.set(name, token);
        this.active.delete(name);
        return token;
    }

    /** Activate a join only if it still belongs to the current renderer. */
    accept(name : string, token : symbol, terminal : T) : boolean {
        if (this.pending.get(name) !== token) {
            return false;
        }
        this.pending.delete(name);
        this.active.set(name, terminal);
        return true;
    }

    /** Get the renderer which has completed its join. */
    get(name : string) : T | undefined {
        return this.active.get(name);
    }

    /** Finish a failed join only while its renderer still owns the request. */
    reject(name : string, token : symbol) : boolean {
        if (this.pending.get(name) !== token) {
            return false;
        }
        this.pending.delete(name);
        return true;
    }

    /** Renderers to clear before logging out. */
    values() : IterableIterator<T> {
        return this.active.values();
    }

    /** Release both the renderer and any acknowledgement still in flight. */
    delete(name : string) : void {
        this.pending.delete(name);
        this.active.delete(name);
    }

    /** Release all bindings when the authenticated session ends. */
    clear() : void {
        this.pending.clear();
        this.active.clear();
    }
}
