import type { LocationQuery, LocationQueryRaw } from "vue-router";
import { containerStateName } from "../../common/stability";
import type { StandaloneContainer } from "../../common/types/container";
import type { StackSummaryDTO, ViewerStackSummary } from "../../common/types/stack";
import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN, isStackFailed, stackNeedsAttention } from "../../common/util-common";

export type ListedStack = StackSummaryDTO | ViewerStackSummary;

/** Rows of one group drawn before "show more"; a server with 500 stacks stays quick to open */
export const LIST_PAGE_SIZE = 50;

export const LIST_FILTERS = [ "running", "attention", "stopped", "unknown", "updates" ] as const;
export type ListFilter = typeof LIST_FILTERS[number];

/** Query keys of the list: every link inside the list carries them, so a click keeps the slice */
const LIST_QUERY_KEYS = [ "q", "filter" ] as const;

/**
 * The part of a route query that belongs to the list
 * @param query Query of the current route
 * @returns Search and filter, without empty values
 */
export function listQuery(query : LocationQuery) : Record<string, string> {
    const result : Record<string, string> = {};
    for (const key of LIST_QUERY_KEYS) {
        const value = query[key];
        if (typeof value === "string" && value !== "") {
            result[key] = value;
        }
    }
    return result;
}

/**
 * The same query with one list key set or removed
 * @param query Query of the current route
 * @param key Key of the list
 * @param value New value, empty to remove it
 * @returns Query to replace the route with
 */
export function withListQuery(query : LocationQuery, key : typeof LIST_QUERY_KEYS[number], value : string) : LocationQueryRaw {
    const next : LocationQueryRaw = { ...query };
    if (value) {
        next[key] = value;
    } else {
        delete next[key];
    }
    return next;
}

/**
 * A filter named in the address, or none when it is not one of ours
 * @param value Query value
 * @returns The filter, or an empty string
 */
export function readListFilter(value : unknown) : ListFilter | "" {
    return LIST_FILTERS.find((filter) => filter === value) ?? "";
}

/**
 * Whether any of the fields contains the search text, ignoring case
 * @param needle Search text, already lower case and trimmed
 * @param fields Texts the row can be found by
 * @returns True for an empty search
 */
export function matchesSearch(needle : string, fields : readonly (string | undefined)[]) : boolean {
    return needle === "" || fields.some((field) => !!field && field.toLowerCase().includes(needle));
}

/**
 * What a stack can be found by: its name, its server, and the names and images of its
 * services. The owner remembers "gotenberg" or "postgres:16", not the stack it lives in.
 * @param stack Stack of the list
 * @param server Name of its server as the list shows it
 * @returns Searchable texts
 */
export function stackSearchFields(stack : ListedStack, server : string) : (string | undefined)[] {
    const services = Array.isArray(stack.services) ? stack.services : [];
    return [ stack.name, server, ...services.map((service) => service.name), ...services.map((service) => service.image) ];
}

/**
 * What a container outside every project can be found by
 * @param container Container of the list
 * @param server Name of its server as the list shows it
 * @returns Searchable texts
 */
export function containerSearchFields(container : StandaloneContainer, server : string) : string[] {
    return [ container.name, container.image, server ];
}

/**
 * Stopped by someone rather than crashed: a crash belongs under attention
 * @param stack Stack of the list
 * @returns Whether the stack is quietly stopped
 */
export function isStackStopped(stack : ListedStack) : boolean {
    return (stack.status === EXITED && !isStackFailed(stack.status, stack.issues)) || stack.status === CREATED_FILE || stack.status === CREATED_STACK;
}

/**
 * Whether a stack belongs to the pressed filter
 * @param stack Stack of the list
 * @param filter Pressed filter, empty for none
 * @returns Whether to show the row
 */
export function stackMatchesFilter(stack : ListedStack, filter : ListFilter | "") : boolean {
    switch (filter) {
        case "running":
            return stack.status === RUNNING;
        case "attention":
            return stackNeedsAttention(stack);
        case "stopped":
            return isStackStopped(stack);
        case "unknown":
            return stack.status === UNKNOWN;
        case "updates":
            return ("source" in stack ? stack.source?.behind ?? 0 : 0) > 0;
        default:
            return true;
    }
}

/**
 * Whether a container outside every project belongs to the pressed filter, judged by
 * the same words its state chip says
 * @param container Container of the list
 * @param filter Pressed filter, empty for none
 * @returns Whether to show the row
 */
export function containerMatchesFilter(container : StandaloneContainer, filter : ListFilter | "") : boolean {
    const state = containerStateName(container);
    switch (filter) {
        case "running":
            return state === "running";
        case "attention":
            return state === "attention" || state === "failed";
        case "stopped":
            return state === "stopped";
        case "unknown":
            return state === "unknown";
        case "updates":
            return false;
        default:
            return true;
    }
}

/**
 * Order of a stack in its group: a crashed or degraded stack is the one the user came to
 * look at, so it goes above the healthy ones
 * @param stack Stack of the list
 * @returns Smaller first
 */
export function stackRank(stack : ListedStack) : number {
    switch (stack.status) {
        case EXITED:
            return isStackFailed(stack.status, stack.issues) ? 0 : 3;
        case ATTENTION:
            return 1;
        case RUNNING:
            return 2;
        case CREATED_STACK:
            return 4;
        case CREATED_FILE:
            return 5;
        default:
            // UNKNOWN and anything unexpected go last
            return 6;
    }
}

/**
 * Compare two stacks for the list: by rank, then by name
 * @param a One stack
 * @param b Another stack
 * @returns Sort order
 */
export function compareStacks(a : ListedStack, b : ListedStack) : number {
    return stackRank(a) - stackRank(b) || a.name.localeCompare(b.name);
}

/**
 * The first rows of a group, and the open row if it lies further down: the list must
 * never hide the stack the page is showing
 * @param rows Rows of the group, already sorted
 * @param limit How many to draw
 * @param isCurrent Whether a row is the open one
 * @returns Rows to draw
 */
export function pageRows<T>(rows : readonly T[], limit : number, isCurrent : (row : T) => boolean) : T[] {
    if (rows.length <= limit) {
        return [ ...rows ];
    }
    const shown = rows.slice(0, limit);
    const current = rows.slice(limit).find(isCurrent);
    return current ? [ ...shown, current ] : shown;
}
