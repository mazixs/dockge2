import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "./util-common";

/** A status interval confirmed by successive observations, never an indefinite state. */
export interface StatusChange {
    status : number;
    at : number;
    /** Last confirmed sample. Missing on legacy records that did not track observation gaps. */
    until? : number;
}

export type AvailabilityVerdict = "noData" | "clean" | "degraded" | "stopped";

export interface Availability {
    verdict : AvailabilityVerdict;
    ratio : number | null;
    incidents : number;
    coveredMs : number;
    windowMs : number;
    currentForMs : number | null;
    currentStatus : number;
}

export const MIN_COVERAGE_MS = 30 * 60_000;
export const OBSERVATION_FRESHNESS_MS = 90_000;
const STOPPED = new Set([ EXITED, CREATED_FILE, CREATED_STACK ]);

/** Whether the Docker state was running and did not need attention. */
export function isHealthyStatus(status : number) : boolean {
    return status === RUNNING;
}

/** Time that the confirmed intervals of one window add up to */
interface Measured {
    coveredMs : number;
    healthyMs : number;
    stoppedMs : number;
    incidents : number;
}

/**
 * Describe the current state, when the last sample is recent enough to stand for it
 * @param last Latest confirmed interval, if there is one
 * @param now Moment the question is asked at
 * @returns The current status and how long it has held, or nothing when the reading is stale
 */
function describeCurrent(last : StatusChange | undefined, now : number) : Pick<Availability, "currentStatus" | "currentForMs"> | null {
    if (last?.until === undefined || last.until < last.at || now - last.until > OBSERVATION_FRESHNESS_MS) {
        return null;
    }
    return {
        currentStatus: last.status,
        currentForMs: last.status === UNKNOWN ? null : now - last.at,
    };
}

/**
 * Add up the confirmed intervals that fall inside the window
 * @param sorted Intervals in the order they started
 * @param windowMs Length of the window ending at `now`
 * @param now Moment the window ends at
 * @returns Covered, healthy and stopped time, and how many incidents there were
 */
function measure(sorted : readonly StatusChange[], windowMs : number, now : number) : Measured {
    const measured : Measured = {
        coveredMs: 0,
        healthyMs: 0,
        stoppedMs: 0,
        incidents: 0,
    };
    let lastEnd = -Infinity;
    let insideIncident = false;
    for (const [ index, change ] of sorted.entries()) {
        const start = Math.max(change.at, now - windowMs);
        const end = Math.min(change.until ?? change.at, sorted[index + 1]?.at ?? now, now);
        if (change.status === UNKNOWN || end <= start || !Number.isFinite(end)) {
            insideIncident = false;
            continue;
        }
        const duration = end - start;
        measured.coveredMs += duration;
        if (isHealthyStatus(change.status)) {
            measured.healthyMs += duration;
        }
        if (STOPPED.has(change.status)) {
            measured.stoppedMs += duration;
        }
        const degraded = change.status === ATTENTION;
        if (degraded && (!insideIncident || start > lastEnd)) {
            measured.incidents += 1;
        }
        insideIncident = degraded;
        lastEnd = end;
    }
    return measured;
}

/**
 * Calculate availability only inside explicitly confirmed observation intervals.
 * Legacy timestamps and gaps carry no duration. UNKNOWN means absence of evidence,
 * so neither healthy time nor downtime is invented when Docker cannot be read.
 */
export function computeAvailability(changes : readonly StatusChange[], windowMs : number, now : number) : Availability {
    const result : Availability = {
        verdict: "noData",
        ratio: null,
        incidents: 0,
        coveredMs: 0,
        windowMs,
        currentForMs: null,
        currentStatus: UNKNOWN,
    };
    if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(now)) {
        return result;
    }
    const sorted = changes.filter((change) => Number.isFinite(change.at) && change.at <= now)
        .slice().sort((a, b) => a.at - b.at);
    const current = describeCurrent(sorted.at(-1), now);
    if (current) {
        result.currentStatus = current.currentStatus;
        result.currentForMs = current.currentForMs;
    }
    const measured = measure(sorted, windowMs, now);
    result.incidents = measured.incidents;
    result.coveredMs = measured.coveredMs;
    if (measured.coveredMs === 0) {
        return result;
    }
    if (measured.stoppedMs === measured.coveredMs) {
        result.verdict = "stopped";
    } else if (measured.coveredMs >= MIN_COVERAGE_MS) {
        result.ratio = measured.healthyMs / measured.coveredMs;
        result.verdict = measured.healthyMs === measured.coveredMs ? "clean" : "degraded";
    }
    return result;
}
