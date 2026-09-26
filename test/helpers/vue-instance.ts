import { createRenderer, type ComponentOptions } from "vue";

/**
 * A renderer that draws nothing.
 *
 * The mixins of the root keep state, watchers and lifecycle hooks but render nothing of
 * their own, so they run on a real Vue instance outside a browser; only what they reach
 * in the browser (storage, media queries, the page) has to be provided by the test.
 */
const { createApp } = createRenderer<object, object>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
});

/** A mounted component and what Vue reported while it ran */
export interface Mounted<T> {
    vm : T;
    /** Errors thrown by hooks, watchers and handlers, which Vue would otherwise only log */
    errors : unknown[];
    unmount : () => void;
}

/**
 * Mount a component on a real Vue instance that renders nothing
 * @param component Options of the component, usually `{ mixins: [ mixin ] }`
 * @param globalProperties What every component sees on `this`, such as `$route` or `$t`
 * @returns The instance, the errors it raised, and a way to unmount it
 */
export function mountOptions<T>(component : ComponentOptions, globalProperties : Record<string, unknown> = {}) : Mounted<T> {
    const errors : unknown[] = [];
    const app = createApp({ render: () => null,
        ...component });
    app.config.errorHandler = (error) => {
        errors.push(error);
    };
    app.config.warnHandler = () => {};
    Object.assign(app.config.globalProperties, globalProperties);
    const vm = app.mount({}) as unknown as T;
    return { vm,
        errors,
        unmount: () => app.unmount() };
}

/** A `MediaQueryList` whose result the test changes, as a resize or a system switch would */
export class FakeMediaQuery extends EventTarget {
    constructor(readonly media : string, public matches = false) {
        super();
    }

    /**
     * Change the result and tell the listeners, as the browser does
     * @param matches New result of the query
     */
    change(matches : boolean) : void {
        this.matches = matches;
        this.dispatchEvent(Object.assign(new Event("change"), { matches }));
    }
}

/** `localStorage` or `sessionStorage`, which a private window or a site policy may block */
export class MemoryStorage {
    private values = new Map<string, string>();
    /** Every access throws, as a browser with blocked site data does */
    blocked = false;

    getItem(key : string) : string | null {
        this.check();
        return this.values.get(key) ?? null;
    }

    setItem(key : string, value : string) : void {
        this.check();
        this.values.set(key, String(value));
    }

    removeItem(key : string) : void {
        this.check();
        this.values.delete(key);
    }

    clear() : void {
        this.check();
        this.values.clear();
    }

    private check() : void {
        if (this.blocked) {
            throw new Error("The operation is insecure.");
        }
    }
}

/**
 * Put a browser global on `globalThis`, the way a page has it
 * @param name Name of the global
 * @param get Returns the value on every access, and may throw as a blocked storage does
 * @returns Restores what was there before
 */
export function installGlobal(name : string, get : () => unknown) : () => void {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true,
        get });
    return () => {
        if (previous) {
            Object.defineProperty(globalThis, name, previous);
        } else {
            Reflect.deleteProperty(globalThis, name);
        }
    };
}
