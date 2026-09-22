import { Database } from "./database";
import { spawn } from "./child-process";
import { log } from "./log";
import { RETENTION_MS } from "./observations";
import { computeAvailability, type StatusChange } from "../common/availability";
import {
    buildStabilityHistory, containerUptime, normaliseContainerRuntime, runtimeStatus,
    STABILITY_SCAN_INTERVAL_MS, STABILITY_STALE_MS,
    type ContainerRuntime, type StabilityContainer, type StabilityGroup, type StabilityOverview, type StabilityWindow,
} from "../common/stability";
import { UNKNOWN } from "../common/util-common";

interface StackIdentity {
    name : string;
    path : string;
    isManagedByDockge : boolean;
}
interface StoredContainer extends ContainerRuntime {
    stackName : string;
    managed : boolean;
}
interface LastObservation {
    id : number;
    status : number;
    at : number;
}

/** Read only the runtime fields needed by the dashboard; environment and health logs never leave Docker. */
export async function readDockerRuntime() : Promise<ContainerRuntime[]> {
    const options = { encoding: "utf-8" as const,
        maxBuffer: 4 * 1024 * 1024,
        timeoutMs: 20_000 };
    const listed = await spawn("docker", [ "ps", "--all", "--no-trunc", "--format", "{{.ID}}" ], options);
    const ids = (listed.stdout?.toString() ?? "").trim().split(/\s+/).filter(Boolean);
    if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
        throw new Error("Docker returned an invalid container list");
    }
    // Docker omits Health entirely when no health check is configured. The template
    // uses index because direct .State.Health fails before an if can inspect it.
    const format = "{\"id\":{{json .Id}},\"name\":{{json .Name}},\"project\":{{json (index .Config.Labels \"com.docker.compose.project\")}},\"service\":{{json (index .Config.Labels \"com.docker.compose.service\")}},\"workingDir\":{{json (index .Config.Labels \"com.docker.compose.project.working_dir\")}},\"state\":{{json .State.Status}},\"health\":{{with (index .State \"Health\")}}{{json .Status}}{{else}}\"\"{{end}},\"startedAt\":{{json .State.StartedAt}},\"restartCount\":{{json .RestartCount}}}";
    const containers : ContainerRuntime[] = [];
    for (let start = 0; start < ids.length; start += 100) {
        const batch = ids.slice(start, start + 100);
        const inspected = await spawn("docker", [ "inspect", "--type", "container", "--format", format, ...batch ], options);
        const lines = (inspected.stdout?.toString() ?? "").split("\n").filter((line) => line.trim());
        if (lines.length !== batch.length) {
            throw new Error("Docker returned an incomplete runtime sample");
        }
        for (const line of lines) {
            const container = normaliseContainerRuntime(JSON.parse(line));
            if (!container || !batch.includes(container.id)) {
                throw new Error("Docker returned an invalid runtime sample");
            }
            containers.push(container);
        }
    }
    return containers;
}

/** One stored observation as the database returns it */
interface ObservationRow {
    container_id : string;
    observed_at : number;
    observed_until : number;
    status : number;
}

/** What every container of one reading is measured against */
interface ReadContext {
    windowMs : number;
    now : number;
    /** Whether the last observation is too old to stand for the present */
    stale : boolean;
    observedAt : number;
}

/**
 * Group the stored observations by the container they belong to
 * @param rows Observations that reach into the window
 * @returns Confirmed intervals of each container, oldest first
 */
function groupChanges(rows : readonly ObservationRow[]) : Map<string, StatusChange[]> {
    const changes = new Map<string, StatusChange[]>();
    for (const row of rows) {
        const own = changes.get(row.container_id) ?? [];
        own.push({ at: Number(row.observed_at),
            until: Number(row.observed_until),
            status: Number(row.status) });
        changes.set(row.container_id, own);
    }
    return changes;
}

/**
 * Describe one container of the dashboard.
 *
 * A stale reading says what was observed, never what is running now: the current
 * state, the uptime and the restart count are withheld rather than guessed.
 * @param container The container as the last snapshot stored it
 * @param own Its confirmed intervals inside the window
 * @param context Window, moment and freshness of the reading
 * @returns The container as the dashboard shows it
 */
function describeContainer(container : StoredContainer, own : readonly StatusChange[], context : ReadContext) : StabilityContainer {
    const availability = computeAvailability(own, context.windowMs, context.now);
    if (context.stale) {
        availability.currentStatus = UNKNOWN;
        availability.currentForMs = null;
    }
    return {
        id: container.id,
        name: container.name,
        service: container.service,
        state: context.stale ? "unknown" : container.state,
        health: context.stale ? "" : container.health,
        startedAt: container.startedAt,
        restartCount: context.stale ? null : container.restartCount,
        uptimeMs: context.stale ? null : containerUptime(container.state, container.startedAt, context.observedAt),
        availability,
        history: buildStabilityHistory(own, context.windowMs, context.now),
    };
}

/**
 * Put the containers of one reading under the stack they belong to
 * @param containers The containers of the last snapshot
 * @param changes Confirmed intervals of each container
 * @param context Window, moment and freshness of the reading
 * @returns Stacks and their containers, both in alphabetical order
 */
function groupByStack(containers : readonly StoredContainer[], changes : ReadonlyMap<string, StatusChange[]>, context : ReadContext) : StabilityGroup[] {
    const groups = new Map<string, StabilityGroup>();
    for (const container of containers) {
        const key = container.stackName;
        const group = groups.get(key) ?? { name: key,
            managed: container.managed,
            standalone: !container.project,
            containers: [] };
        group.containers.push(describeContainer(container, changes.get(container.id) ?? [], context));
        groups.set(key, group);
    }
    const stacks = [ ...groups.values() ].sort((a, b) => a.name.localeCompare(b.name));
    for (const group of stacks) {
        group.containers.sort((a, b) => a.name.localeCompare(b.name));
    }
    return stacks;
}

/**
 * Raised inside the write when a shutdown asks the round to give up.
 *
 * It is not a failure of Docker: nothing was learned about the containers, so the
 * collector keeps what it knew instead of reporting the state as unavailable.
 */
class ObservationCancelled extends Error {}

/** Persist bounded container observations independently of whether a dashboard is open. */
export class StabilityCollector {
    private previous = new Map<string, LastObservation>();
    private lastAttemptAt = -Infinity;
    private liveObservation = false;
    private failed = false;
    private inFlight = false;

    constructor(private readRuntime : () => Promise<ContainerRuntime[]> = readDockerRuntime) {}

    /**
     * At most one batched Docker sample per minute, including failed attempts.
     * @param stacks The stacks known to the panel, used to tell managed from standalone
     * @param now Current time, injectable for tests
     * @param ownProject Compose project the panel itself runs as; its containers are skipped
     * @param signal Abort of the round, checked after the Docker read and before every write
     */
    async observe(stacks : ReadonlyMap<string, StackIdentity>, now = Date.now(), ownProject = "", signal? : AbortSignal) : Promise<void> {
        if (this.inFlight || now - this.lastAttemptAt < STABILITY_SCAN_INTERVAL_MS) {
            return;
        }
        this.lastAttemptAt = now;
        this.inFlight = true;
        try {
            const runtime = await this.readRuntime();

            // Docker is what takes the time in a round, and a shutdown can start inside
            // that wait. What comes back then belongs to a panel whose database is
            // already being released, so it is dropped before the first query rather
            // than written into a connection that is about to close
            if (signal?.aborted) {
                return;
            }

            // The panel does not record itself. Availability here is measured from
            // observations the panel takes, so the one thing it can never observe is
            // its own downtime: while it is down nobody is sampling, and the gap
            // reads as "unknown" rather than as the outage it was. The row was also
            // dead weight - the panel is not a stack of its own, so its name is not
            // a link anywhere. That the panel is up is evident from the page being
            // there at all
            const observed = ownProject ? runtime.filter((container) => container.project !== ownProject) : runtime;
            const managedByPath = new Map([ ...stacks.values() ].filter(stack => stack.isManagedByDockge).map(stack => [ stack.path, stack ]));
            const containers : StoredContainer[] = observed.map((container) => {
                const managed = managedByPath.get(container.workingDir)
                    ?? stacks.get(container.project);
                return { ...container,
                    stackName: managed?.name ?? container.project,
                    managed: managed?.isManagedByDockge ?? false };
            });
            this.previous = await this.writeObservations(containers, now, signal);
            this.liveObservation = true;
            this.failed = false;
        } catch (e) {
            if (e instanceof ObservationCancelled) {
                // The round was asked back in the middle of the write. Nothing is known
                // about Docker that was not known before, so the collector keeps its
                // state instead of turning a shutdown into a reported failure
                return;
            }

            // Do not expose Docker stderr: it can include user-controlled diagnostics.
            this.failed = true;
            this.previous.clear();
            log.warn("stability", "Cannot record a Docker runtime observation");
        } finally {
            this.inFlight = false;
        }
    }

    /**
     * Write one sample of every container inside a single transaction.
     *
     * The signal is checked in front of each container, because the writes are awaited
     * one after another and a shutdown can land between two of them. Giving up throws,
     * so the transaction is rolled back rather than left half applied.
     * @param containers What Docker reported, already named and matched to stacks
     * @param now Time of this sample
     * @param signal Abort of the round
     * @returns The interval each container is in after this sample
     */
    private async writeObservations(containers : StoredContainer[], now : number, signal? : AbortSignal) : Promise<Map<string, LastObservation>> {
        const next = new Map<string, LastObservation>();

        await Database.getKnex().transaction(async (trx) => {
            for (const container of containers) {
                if (signal?.aborted) {
                    throw new ObservationCancelled("the observation was cancelled");
                }

                const status = runtimeStatus(container.state, container.health);
                const last = this.previous.get(container.id);
                if (last && now >= last.at && now - last.at <= STABILITY_STALE_MS) {
                    const updated = await trx("container_observation").where({ id: last.id }).update({ observed_until: now });
                    if (updated && last.status === status) {
                        next.set(container.id, { ...last,
                            at: now });
                        continue;
                    }
                }
                const [ id ] = await trx("container_observation").insert({ container_id: container.id,
                    status,
                    observed_at: now,
                    observed_until: now });
                next.set(container.id, { id: Number(id),
                    status,
                    at: now });
            }
            await trx("stability_snapshot").insert({ id: 1,
                observed_at: now,
                containers: JSON.stringify(containers) })
                .onConflict("id").merge();
            await trx("container_observation").where("observed_until", "<", now - RETENTION_MS).delete();
        });

        return next;
    }

    /** Read saved observations without causing Docker inspection for every connected viewer. */
    async read(windowHours : StabilityWindow, now = Date.now()) : Promise<StabilityOverview> {
        const knex = Database.getKnex();
        const snapshot = await knex("stability_snapshot").where({ id: 1 }).first();
        const observedAt = snapshot ? Number(snapshot.observed_at) : null;
        const stale = !this.liveObservation || this.failed || observedAt === null || now - observedAt > STABILITY_STALE_MS;
        const error = this.failed ? "dockerUnavailable" : !this.liveObservation || observedAt === null ? "noObservation" : null;
        const result : StabilityOverview = { observedAt,
            windowHours,
            stale,
            error,
            stacks: [] };
        if (!snapshot || observedAt === null) {
            return result;
        }
        const containers = JSON.parse(snapshot.containers) as StoredContainer[];
        const windowMs = windowHours * 3_600_000;
        const rows = await knex("container_observation").where("observed_until", ">=", now - windowMs).orderBy("observed_at", "asc") as ObservationRow[];
        result.stacks = groupByStack(containers, groupChanges(rows), { windowMs,
            now,
            stale,
            observedAt });
        return result;
    }
}

export const stabilityCollector = new StabilityCollector();

/**
 * Hook for the existing background stack scan.
 * @param stacks The stacks known to the panel
 * @param ownProject Compose project the panel itself runs as
 * @param signal Abort of the round, so a shutdown reaches the collector as well
 */
export async function observeContainerStability(stacks : ReadonlyMap<string, StackIdentity>, ownProject = "", signal? : AbortSignal) : Promise<void> {
    await stabilityCollector.observe(stacks, Date.now(), ownProject, signal);
}
