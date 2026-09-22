/** A known command boundary, never a guess based on Docker's free-form output. */
export class OperationError extends Error {
    /**
     * @param code Stable failure category carried to the browser
     * @param message Translation key explaining the next action
     * @param unknown Whether container changes remain unconfirmed
     */
    constructor(readonly code : "busy" | "interrupted" | "spawn" | "pull" | "build" | "apply", message : string, readonly unknown = false) {
        super(message);
    }
}
