import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "./util-common";

/**
 * Availability of a stack, computed from recorded status changes.
 *
 * The rule of this file is honesty: a window nobody watched is not a green window,
 * and a stack that ran for eleven seconds does not have a percentage. Every verdict
 * says what is actually known.
 */

/** One recorded status change: the stack was in `status` from `at` until the next entry */
export interface StatusChange {
    status : number;
    /** Milliseconds since the epoch */
    at : number;
}

/** What the row and the inspector may say about availability */
export type AvailabilityVerdict = "noData" | "clean" | "degraded" | "stopped";

export interface Availability {
    verdict : AvailabilityVerdict;
    /** Share of the observed time the stack was healthy, null when there is no verdict to give */
    ratio : number | null;
    /** How many separate degraded stretches the window holds */
    incidents : number;
    /** Milliseconds of the window that were actually observed */
    coveredMs : number;
    /** Length of the asked window */
    windowMs : number;
    /** How long the current state has lasted, null when nothing is recorded */
    currentForMs : number | null;
    /** Status the stack is in right now, UNKNOWN when nothing is recorded */
    currentStatus : number;
}

/**
 * A window shorter than this cannot carry a percentage: with two minutes of data,
 * one restart would read as "50% availability", which says nothing true.
 */
export const MIN_COVERAGE_MS = 30 * 60_000;

/** States that count as the stack doing its job */
const HEALTHY = new Set([ RUNNING ]);

/** States that mean the stack is deliberately not running */
const STOPPED = new Set([ EXITED, CREATED_FILE, CREATED_STACK ]);

/**
 * Whether a status counts as healthy.
 * ATTENTION and UNKNOWN never do - a degraded or unreadable stack is not fine.
 * @param status Numeric stack status
 * @returns True when the stack was doing its job
 */
export function isHealthyStatus(status : number) : boolean {
    return HEALTHY.has(status);
}

/**
 * Compute availability over a window from recorded changes.
 *
 * Changes may start before the window: the last change before it describes the state
 * the window opens with. Time that no change describes is not counted at all, so a
 * gap in observations lowers the coverage instead of inventing a green stretch.
 * @param changes Recorded changes, any order
 * @param windowMs Length of the window ending at `now`
 * @param now End of the window, milliseconds since the epoch
 * @returns What can be said about this window
 */
export function computeAvailability(changes : readonly StatusChange[], windowMs : number, now : number) : Availability {
    const empty : Availability = {
        verdict: "noData",
        ratio: null,
        incidents: 0,
        coveredMs: 0,
        windowMs,
        currentForMs: null,
        currentStatus: UNKNOWN,
    };

    if (changes.length === 0 || windowMs <= 0) {
        return empty;
    }

    const sorted = [ ...changes ].sort((a, b) => a.at - b.at).filter((change) => change.at <= now);

    if (sorted.length === 0) {
        return empty;
    }

    const from = now - windowMs;
    const last = sorted[sorted.length - 1] as StatusChange;

    // Segments of the window, each with the status that was in effect
    const segments : { status : number; start : number; end : number }[] = [];

    for (const [ index, change ] of sorted.entries()) {
        const next = sorted[index + 1];
        const start = Math.max(change.at, from);
        const end = Math.min(next?.at ?? now, now);

        if (end > start) {
            segments.push({ status: change.status,
                start,
                end });
        }
    }

    const coveredMs = segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0);
    const currentForMs = now - last.at;

    if (coveredMs === 0) {
        return { ...empty,
            currentStatus: last.status,
            currentForMs };
    }

    const healthyMs = segments
        .filter((segment) => isHealthyStatus(segment.status))
        .reduce((sum, segment) => sum + (segment.end - segment.start), 0);

    // Degraded stretches are counted as stretches, not as samples: one long outage
    // is one incident, and that is what the owner counts too
    let incidents = 0;
    let insideIncident = false;

    for (const segment of segments) {
        const degraded = segment.status === ATTENTION || segment.status === UNKNOWN;

        if (degraded && !insideIncident) {
            incidents += 1;
        }

        insideIncident = degraded;
    }

    const stoppedThroughWindow = segments.every((segment) => STOPPED.has(segment.status));

    if (stoppedThroughWindow) {
        return {
            verdict: "stopped",
            ratio: null,
            incidents: 0,
            coveredMs,
            windowMs,
            currentForMs,
            currentStatus: last.status,
        };
    }

    // Not enough observed time for a number: say so instead of dividing eleven seconds
    if (coveredMs < MIN_COVERAGE_MS) {
        return {
            verdict: "noData",
            ratio: null,
            incidents,
            coveredMs,
            windowMs,
            currentForMs,
            currentStatus: last.status,
        };
    }

    if (incidents === 0 && healthyMs === coveredMs) {
        return {
            verdict: "clean",
            ratio: 1,
            incidents: 0,
            coveredMs,
            windowMs,
            currentForMs,
            currentStatus: last.status,
        };
    }

    return {
        verdict: "degraded",
        ratio: healthyMs / coveredMs,
        incidents,
        coveredMs,
        windowMs,
        currentForMs,
        currentStatus: last.status,
    };
}
