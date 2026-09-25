import type { AgentEventContract } from "./agent-events";

/**
 * What a handler of one event is given: the arguments of the event, and the
 * acknowledgement after them when the event has an answer.
 * @template Contract Events of this side
 * @template E Name of the event
 */
export type AgentEventHandler<Contract extends AgentEventContract<Contract>, E extends keyof Contract> =
    Contract[E]["result"] extends void
        ? (...args : Contract[E]["args"]) => void
        : (...args : [ ...Contract[E]["args"], ack : (response : Contract[E]["result"]) => void ]) => void;

/**
 * Which generation of the agent protocol this build speaks.
 *
 * It is deliberately separate from the release number in `package.json`. This
 * fork numbers its own releases and started over at 0.0.1, so the product
 * version says nothing about what an agent can do: comparing it against an
 * upstream number would reject every agent this fork talks to.
 *
 * Raise it only when an agent stops understanding what an older one sent.
 */
export const AGENT_PROTOCOL_VERSION = 2;

/**
 * The oldest protocol generation still accepted from an agent.
 *
 * Generation 2 added the baseline argument to the save events. An agent that only speaks
 * generation 1 still works: the argument is dropped before the event reaches it, and the
 * save is made without the conflict check instead of losing the acknowledgement.
 */
export const MIN_AGENT_PROTOCOL_VERSION = 1;

/**
 * Save events whose fifth argument is the baseline of the editor.
 * An agent older than generation 2 expects its acknowledgement in that position.
 */
export const BASELINE_EVENTS = new Set([ "saveStack", "deployStack" ]);

/** Where the baseline sits among the arguments of those events */
export const BASELINE_ARGUMENT_INDEX = 4;

/** First agent generation that understands the baseline argument */
export const BASELINE_PROTOCOL_VERSION = 2;

/**
 * One side of the agent transport.
 *
 * The contract says which events this side handles and what each of them carries, so a
 * handler for an event nobody sends, or one that expects an argument the caller never
 * passes, does not compile. What arrives over the wire is still whatever the sender put
 * there, and every handler validates it: this is a description of the agreement, not a
 * guard at the door.
 * @template Contract Events this side listens for
 */
export class AgentSocket<Contract extends AgentEventContract<Contract> = AgentEventContract> {

    eventList : Map<string, (...args : never[]) => void> = new Map();

    /**
     * Listen for one event of the contract
     * @param event Name of the event
     * @param callback What to do with it, with the acknowledgement last when there is one
     */
    on<E extends keyof Contract & string>(event : E, callback : AgentEventHandler<Contract, E>) {
        this.eventList.set(event, callback as (...args : never[]) => void);
    }

    /**
     * Hand an event that arrived to whoever listens for it.
     *
     * The name and the arguments come off the network, so they are deliberately not
     * typed: this is the point where something unknown becomes something the handler
     * has to check.
     * @param eventName Name as the sender wrote it
     * @param args Arguments as they arrived
     */
    call(eventName : string, ...args : unknown[]) {
        const callback = this.eventList.get(eventName);
        if (callback) {
            (callback as (...args : unknown[]) => void)(...args);
        }
    }
}
