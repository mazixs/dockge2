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
    const last = sorted.at(-1);
    if (last?.until !== undefined && last.until >= last.at && now - last.until <= OBSERVATION_FRESHNESS_MS) {
        result.currentStatus = last.status;
        result.currentForMs = last.status === UNKNOWN ? null : now - last.at;
    }
    let healthyMs = 0;
    let stoppedMs = 0;
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
        result.coveredMs += duration;
        if (isHealthyStatus(change.status)) {
            healthyMs += duration;
        }
        if (STOPPED.has(change.status)) {
            stoppedMs += duration;
        }
        const degraded = change.status === ATTENTION;
        if (degraded && (!insideIncident || start > lastEnd)) {
            result.incidents += 1;
        }
        insideIncident = degraded;
        lastEnd = end;
    }
    if (result.coveredMs === 0) {
        return result;
    }
    if (stoppedMs === result.coveredMs) {
        result.verdict = "stopped";
    } else if (result.coveredMs >= MIN_COVERAGE_MS) {
        result.ratio = healthyMs / result.coveredMs;
        result.verdict = healthyMs === result.coveredMs ? "clean" : "degraded";
    }
    return result;
}
