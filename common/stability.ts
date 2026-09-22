import type { Availability, StatusChange } from "./availability";
import { ATTENTION, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "./util-common";

export const STABILITY_WINDOWS = [ 24, 168, 720 ] as const;
export type StabilityWindow = typeof STABILITY_WINDOWS[number];
export type StabilityState = "running" | "attention" | "stopped" | "unknown";
export const STABILITY_SCAN_INTERVAL_MS = 60_000;
export const STABILITY_STALE_MS = 90_000;

export interface ContainerRuntime {
    id : string;
    name : string;
    project : string;
    service : string;
    workingDir : string;
    state : string;
    health : string;
    startedAt : number | null;
    restartCount : number | null;
}

export interface StabilityHistoryBucket {
    from : number;
    to : number;
    state : StabilityState;
    coverage : number;
}

export interface StabilityContainer extends Omit<ContainerRuntime, "workingDir" | "project"> {
    uptimeMs : number | null;
    availability : Availability;
    history : StabilityHistoryBucket[];
}

export interface StabilityGroup {
    name : string;
    managed : boolean;
    standalone : boolean;
    containers : StabilityContainer[];
}

export interface StabilityOverview {
    observedAt : number | null;
    windowHours : StabilityWindow;
    stale : boolean;
    error : "dockerUnavailable" | "noObservation" | null;
    stacks : StabilityGroup[];
}

/** Return only Docker runtime fields that are safe to persist and expose to viewers. */
export function normaliseContainerRuntime(value : unknown) : ContainerRuntime | null {
    if (!value || typeof value !== "object") {
        return null;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.id) || typeof row.name !== "string" || !row.name) {
        return null;
    }
    const text = (key : string) => typeof row[key] === "string" ? row[key] as string : "";
    const timestamp = Date.parse(text("startedAt"));
    return {
        id: row.id,
        name: row.name.replace(/^\//, ""),
        project: text("project"),
        service: text("service"),
        workingDir: text("workingDir"),
        state: text("state").toLowerCase(),
        health: text("health").toLowerCase(),
        startedAt: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null,
        restartCount: typeof row.restartCount === "number" && Number.isInteger(row.restartCount) && row.restartCount >= 0 ? row.restartCount : null,
    };
}

/** Classify Docker runtime; absent or unreadable data never counts as running. */
export function runtimeStatus(state : string, health : string) : number {
    if (state === "running") {
        return health === "unhealthy" || health === "starting" ? ATTENTION : RUNNING;
    }
    if ([ "restarting", "paused", "dead", "removing" ].includes(state)) {
        return ATTENTION;
    }
    if (state === "created") {
        return CREATED_STACK;
    }
    return state === "exited" ? EXITED : UNKNOWN;
}

/** Time since Docker StartedAt as of the last successful sample, not application uptime. */
export function containerUptime(state : string, startedAt : number | null, observedAt : number) : number | null {
    return state === "running" && startedAt !== null && startedAt > 0 && startedAt <= observedAt
        ? observedAt - startedAt : null;
}

/** Build a compact history whose partial buckets retain the amount of missing evidence. */
export function buildStabilityHistory(changes : readonly StatusChange[], windowMs : number, now : number, count = 48) : StabilityHistoryBucket[] {
    const sorted = changes.slice().sort((a, b) => a.at - b.at);
    const width = windowMs / count;
    const beginning = now - windowMs;
    const buckets = Array.from({ length: count }, (_, index) => ({
        from: beginning + index * width,
        to: beginning + (index + 1) * width,
        knownMs: 0,
        runningMs: 0,
        attentionMs: 0,
    }));
    for (const [ index, change ] of sorted.entries()) {
        if (change.status === UNKNOWN) {
            continue;
        }
        const from = Math.max(beginning, change.at);
        const to = Math.min(now, change.until ?? change.at, sorted[index + 1]?.at ?? now);
        if (!(to > from)) {
            continue;
        }
        // Visit only intersecting buckets rather than scanning every interval 48 times.
        for (let bucketIndex = Math.max(0, Math.floor((from - beginning) / width)); bucketIndex < count; bucketIndex++) {
            const bucket = buckets[bucketIndex]!;
            if (bucket.from >= to) {
                break;
            }
            const overlap = Math.max(0, Math.min(to, bucket.to) - Math.max(from, bucket.from));
            bucket.knownMs += overlap;
            if (change.status === RUNNING) {
                bucket.runningMs += overlap;
            } else if (change.status === ATTENTION) {
                bucket.attentionMs += overlap;
            }
        }
    }
    return buckets.map(({ from, to, knownMs, runningMs, attentionMs }) => ({
        from,
        to,
        state: knownMs === 0 ? "unknown" : (attentionMs > 0 || (runningMs > 0 && runningMs < knownMs)) ? "attention" : runningMs > 0 ? "running" : "stopped",
        coverage: Math.min(1, knownMs / (to - from)),
    }));
}
