import type {
    AgentErrorResponse,
    AgentRequestArgs,
    AgentRequestName,
    AgentRequestResult,
} from "../../common/agent-events";

/** How long an ordinary read may take before its result counts as unknown */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** How a request may be steered */
export interface AgentRequestOptions {
    /** How long to wait for the acknowledgement */
    timeoutMs? : number;
}

/**
 * The answer given when none arrived.
 *
 * A mutating request is never repeated on its own: the server may have carried it out,
 * and doing it twice is worse than asking the person to look at the current state.
 * @returns A response saying the result is unknown
 */
export function unknownResult() : AgentErrorResponse {
    return { ok: false,
        unknown: true,
        msgi18n: true,
        msg: "requestResultUnknown" };
}

/**
 * How a request leaves this application.
 * @template E Event being sent
 */
export type AgentRequestSender = <E extends AgentRequestName>(
    endpoint : string,
    eventName : E,
    args : AgentRequestArgs<E>,
    ack : (response : AgentRequestResult<E> | undefined) => void,
) => void;

/**
 * Requests waiting for their acknowledgement.
 *
 * Socket.IO does not answer a request whose connection went away, and a screen that only
 * leaves its "processing" state in the callback would then wait for ever. Every request
 * is kept here until it is answered, so a deadline or a lost connection ends it - with
 * "the result is unknown", never with "it failed", because a command whose answer was
 * lost may well have run.
 *
 * The transport is passed in rather than reached for, so what happens to a request that
 * is never answered can be established without a browser and without a server.
 */
export class AgentRequests {

    protected waitingList : Map<number, (response : AgentErrorResponse) => void> = new Map();
    protected sequence = 0;

    /**
     * @param send How a request reaches the server
     * @param defaultTimeoutMs How long a request waits when the caller names no deadline
     */
    constructor(
        protected send : AgentRequestSender,
        protected defaultTimeoutMs : number = DEFAULT_REQUEST_TIMEOUT_MS,
    ) {}

    /** How many requests are still waiting for an answer */
    get waiting() : number {
        return this.waitingList.size;
    }

    /**
     * Ask an agent something and always get an answer
     * @param endpoint Agent the request goes to
     * @param eventName Event of the agent protocol
     * @param args Arguments of that event, without the acknowledgement
     * @param options How long to wait
     * @returns The answer, or the unknown result
     */
    request<E extends AgentRequestName>(
        endpoint : string,
        eventName : E,
        args : AgentRequestArgs<E>,
        options : AgentRequestOptions = {},
    ) : Promise<AgentRequestResult<E>> {
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

        return new Promise((resolve) => {
            const id = ++this.sequence;
            let answered = false;

            const settle = (response : AgentRequestResult<E>) => {
                if (answered) {
                    return;
                }
                answered = true;
                clearTimeout(timer);
                this.waitingList.delete(id);
                resolve(response);
            };

            // An answer that never came is an error answer, which every request may be
            // given: the caller is told the result is unknown, never that it failed
            const unknown = () => unknownResult() as AgentRequestResult<E>;
            const timer = setTimeout(() => settle(unknown()), timeoutMs);

            this.waitingList.set(id, settle as (response : AgentErrorResponse) => void);
            this.send(endpoint, eventName, args, (response) => settle(response ?? unknown()));
        });
    }

    /** End every request that is still waiting, because nothing will answer it */
    failAll() : void {
        const waiting = [ ...this.waitingList.values() ];
        this.waitingList.clear();

        for (const settle of waiting) {
            settle(unknownResult());
        }
    }
}
