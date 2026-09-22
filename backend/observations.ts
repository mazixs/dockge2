import { Database } from "./database";
import { log } from "./log";
import { computeAvailability, type Availability, type StatusChange } from "../common/availability";

/**
 * Recorded history of stack statuses.
 *
 * Only changes are stored. The ten second cron knows the status of every stack on every
 * tick, but writing all of them would add millions of rows a month while carrying no
 * more information. Each row also records its last confirmed sample; a delayed scan
 * or a process restart starts a new interval instead of hiding an observation gap.
 */

/** How long history is kept: the longest window the UI offers is thirty days */
export const RETENTION_MS = 31 * 24 * 3_600_000;

/** How often old rows are removed, so pruning does not run on every tick */
const PRUNE_EVERY_MS = 6 * 3_600_000;

/** Last known interval per stack; unchanged samples update its end without adding rows. */
const lastStatus = new Map<string, { id : number; status : number; at : number }>();

/** The ten second scan can miss one tick without joining a longer outage. */
const MAX_SCAN_GAP_MS = 30_000;

let lastPruneAt = 0;

/**
 * Key of one stack in the in-memory state
 * @param stackName Stack name
 * @param endpoint Agent endpoint, empty for the local host
 * @returns Key
 */
function keyOf(stackName : string, endpoint : string) : string {
    return `${endpoint}//${stackName}`;
}

/**
 * Confirm the current interval or start a new interval after a status change or gap.
 * @param stackName Stack name
 * @param endpoint Agent endpoint, empty for the local host
 * @param status Numeric status
 * @param now Current time, injectable for tests
 * @returns True when a new interval was inserted
 */
export async function recordStatus(stackName : string, endpoint : string, status : number, now = Date.now()) : Promise<boolean> {
    const key = keyOf(stackName, endpoint);

    const previous = lastStatus.get(key);
    try {
        const knex = Database.getKnex();
        if (previous && now >= previous.at && now - previous.at <= MAX_SCAN_GAP_MS) {
            const updated = await knex("stack_observation").where({ id: previous.id }).update({ observed_until: now });
            if (updated && previous.status === status) {
                previous.at = now;
                return false;
            }
        }
        const [ id ] = await knex("stack_observation").insert({
            stack_name: stackName,
            endpoint,
            status,
            observed_at: now,
            observed_until: now,
        });

        lastStatus.set(key, { id: Number(id),
            status,
            at: now });
        return true;
    } catch (e) {
        // History is a convenience, not a promise: a failed write must not break the list
        if (e instanceof Error) {
            log.warn("observations", `Cannot record the status of ${stackName}: ${e.message}`);
        }
        return false;
    }
}

/**
 * Record the statuses of a whole scan and prune old rows from time to time.
 * @param stacks Stack name, endpoint and status of every stack of this scan
 * @param now Current time, injectable for tests
 * @param signal Abort of the round, checked before every write
 * @returns How many rows were written
 */
export async function recordScan(
    stacks : readonly { name : string; endpoint : string; status : number }[],
    now = Date.now(),
    signal? : AbortSignal,
) : Promise<number> {
    let written = 0;
    for (const [ key, previous ] of lastStatus) {
        if (now - previous.at > MAX_SCAN_GAP_MS) {
            lastStatus.delete(key);
        }
    }

    for (const stack of stacks) {
        // Every stack is a separate write with a wait in front of it, so a shutdown can
        // land between two of them. What is already written stays; the rest is dropped
        // rather than carried into a database that is being released
        if (signal?.aborted) {
            return written;
        }

        if (await recordStatus(stack.name, stack.endpoint, stack.status, now)) {
            written += 1;
        }
    }

    if (!signal?.aborted && now - lastPruneAt > PRUNE_EVERY_MS) {
        lastPruneAt = now;
        await pruneOldObservations(now);
    }

    return written;
}

/**
 * Remove rows older than the retention window
 * @param now Current time, injectable for tests
 * @returns How many rows were removed
 */
export async function pruneOldObservations(now = Date.now()) : Promise<number> {
    try {
        return await Database.getKnex()("stack_observation")
            .where("observed_until", "<", now - RETENTION_MS)
            .delete();
    } catch (e) {
        if (e instanceof Error) {
            log.warn("observations", `Cannot prune the history: ${e.message}`);
        }
        return 0;
    }
}

/**
 * Read the changes that describe a window.
 *
 * The change right before the window is included, because it says which state the
 * window opens with - without it a stack that has been running for a month would
 * look like it has no history at all.
 * @param stackName Stack name
 * @param endpoint Agent endpoint, empty for the local host
 * @param windowMs Length of the window ending at `now`
 * @param now End of the window
 * @returns Changes in ascending order
 */
export async function readChanges(stackName : string, endpoint : string, windowMs : number, now = Date.now()) : Promise<StatusChange[]> {
    const from = now - windowMs;

    try {
        const knex = Database.getKnex();

        const inside = await knex("stack_observation")
            .select("status", "observed_at", "observed_until")
            .where({ stack_name: stackName,
                endpoint })
            .andWhere("observed_at", ">=", from)
            .orderBy("observed_at", "asc");

        const before = await knex("stack_observation")
            .select("status", "observed_at", "observed_until")
            .where({ stack_name: stackName,
                endpoint })
            .andWhere("observed_at", "<", from)
            .orderBy("observed_at", "desc")
            .limit(1);

        return [ ...before, ...inside ].map((row) => ({
            status: Number(row.status),
            at: Number(row.observed_at),
            until: Number(row.observed_until ?? row.observed_at),
        }));
    } catch (e) {
        if (e instanceof Error) {
            log.warn("observations", `Cannot read the history of ${stackName}: ${e.message}`);
        }
        return [];
    }
}

/**
 * Availability of one stack over a window
 * @param stackName Stack name
 * @param endpoint Agent endpoint, empty for the local host
 * @param windowMs Length of the window ending at `now`
 * @param now End of the window
 * @returns What is known about the window
 */
export async function readAvailability(stackName : string, endpoint : string, windowMs : number, now = Date.now()) : Promise<Availability> {
    const changes = await readChanges(stackName, endpoint, windowMs, now);
    return computeAvailability(changes, windowMs, now);
}

/** Read one endpoint's selected stacks in bounded SQL batches, including the left-edge interval. */
export async function readAvailabilityBatch(names : readonly string[], endpoint : string, windowMs : number, now = Date.now()) : Promise<Map<string, Availability>> {
    const changes = new Map(names.map(name => [ name, [] as StatusChange[] ]));
    const knex = Database.getKnex();
    for (let offset = 0; offset < names.length; offset += 400) {
        const rows = await knex("stack_observation")
            .select("stack_name", "status", "observed_at", "observed_until")
            .where({ endpoint })
            .whereIn("stack_name", names.slice(offset, offset + 400))
            .andWhere("observed_until", ">=", now - windowMs)
            .orderBy("observed_at", "asc");
        for (const row of rows) {
            changes.get(row.stack_name)?.push({ status: Number(row.status),
                at: Number(row.observed_at),
                until: Number(row.observed_until) });
        }
    }
    return new Map([ ...changes ].map(([ name, rows ]) => [ name, computeAvailability(rows, windowMs, now) ]));
}

/** Release disappeared stacks without deleting their historical observations. */
export function forgetObservation(stackName : string, endpoint = "") : void {
    lastStatus.delete(keyOf(stackName, endpoint));
}

/**
 * Forget the in-memory state, used by tests and after the database is replaced
 * @returns void
 */
export function resetObservationState() : void {
    lastStatus.clear();
    lastPruneAt = 0;
}
