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
export const AGENT_PROTOCOL_VERSION = 1;

/**
 * The oldest protocol generation still accepted from an agent.
 */
export const MIN_AGENT_PROTOCOL_VERSION = 1;

export class AgentSocket {

    eventList : Map<string, (...args : unknown[]) => void> = new Map();

    on(event : string, callback : (...args : unknown[]) => void) {
        this.eventList.set(event, callback);
    }

    call(eventName : string, ...args : unknown[]) {
        const callback = this.eventList.get(eventName);
        if (callback) {
            callback(...args);
        }
    }
}
