/** The public Bootstrap lifecycle needed to release an owned dialog. */
interface ModalInstance {
    hide: () => void;
    dispose: () => void;
}

/**
 * Release a modal after its transitions finish, including unmount during opening.
 * Bootstrap ignores hide during a transition; disposing then leaves body scroll
 * locks/backdrops behind. Event ownership also avoids retaining Vue through a modal.
 * @param element Modal event target
 * @param modal Bootstrap instance owned by the component
 * @returns Idempotent unmount callback
 */
export function ownModal(element : EventTarget & { remove? : () => void }, modal : ModalInstance) : () => void {
    let state: "closed" | "opening" | "open" | "closing" = "closed";
    let released = false;
    let disposed = false;
    const events = {
        "show.bs.modal": () => {
            state = "opening";
        },
        "shown.bs.modal": () => {
            state = "open";
            if (released) {
                modal.hide();
            }
        },
        "hide.bs.modal": () => {
            state = "closing";
        },
        "hidden.bs.modal": () => {
            state = "closed";
            if (released) {
                dispose();
            }
        },
    };
    const dispose = () => {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const [ event, listener ] of Object.entries(events)) {
            element.removeEventListener(event, listener);
        }
        modal.dispose();
        // Bootstrap may append an already unmounted element to body when its
        // backdrop finishes opening. The owner must remove that orphan too.
        element.remove?.();
    };
    for (const [ event, listener ] of Object.entries(events)) {
        element.addEventListener(event, listener);
    }
    return () => {
        released = true;
        if (state === "closed") {
            dispose();
        } else if (state === "open") {
            modal.hide();
        }
    };
}
