import { Database } from "./database";
import { spawn } from "./child-process";
import { log } from "./log";
import { RETENTION_MS } from "./observations";
import { computeAvailability, type StatusChange } from "../common/availability";
import {
    buildStabilityHistory, containerUptime, normaliseContainerRuntime, runtimeStatus,
    STABILITY_SCAN_INTERVAL_MS, STABILITY_STALE_MS,
    type ContainerRuntime, type StabilityGroup, type StabilityOverview, type StabilityWindow,
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
     */
    async observe(stacks : ReadonlyMap<string, StackIdentity>, now = Date.now(), ownProject = "") : Promise<void> {
        if (this.inFlight || now - this.lastAttemptAt < STABILITY_SCAN_INTERVAL_MS) {
            return;
        }
        this.lastAttemptAt = now;
        this.inFlight = true;
        try {
            const runtime = await this.readRuntime();
            // The panel does not record itself. Availability here is measured from
            // observations the panel takes, so the one thing it can never observe is
            // its own downtime: while it is down nobody is sampling, and the gap
            // reads as "unknown" rather than as the outage it was. The row was also
            // dead weight - the panel is not a stack of its own, so its name is not
            // a link anywhere. That the panel is up is evident from the page being
            // there at all
            const observed = ownProject ? runtime.filter((container) => container.project !== ownProject) : runtime;
            const containers : StoredContainer[] = observed.map((container) => {
                const managed = [ ...stacks.values() ].find((stack) => stack.isManagedByDockge && stack.path === container.workingDir)
                    ?? stacks.get(container.project);
                return { ...container,
                    stackName: managed?.name ?? container.project,
                    managed: managed?.isManagedByDockge ?? false };
            });
            const next = new Map<string, LastObservation>();
            await Database.getKnex().transaction(async (trx) => {
                for (const container of containers) {
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
            this.previous = next;
            this.liveObservation = true;
            this.failed = false;
        } catch (e) {
            // Do not expose Docker stderr: it can include user-controlled diagnostics.
            this.failed = true;
            this.previous.clear();
            log.warn("stability", "Cannot record a Docker runtime observation");
        } finally {
            this.inFlight = false;
        }
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
        const rows = await knex("container_observation").where("observed_until", ">=", now - windowMs).orderBy("observed_at", "asc");
        const changes = new Map<string, StatusChange[]>();
        for (const row of rows) {
            const own = changes.get(row.container_id) ?? [];
            own.push({ at: Number(row.observed_at),
                until: Number(row.observed_until),
                status: Number(row.status) });
            changes.set(row.container_id, own);
        }
        const groups = new Map<string, StabilityGroup>();
        for (const container of containers) {
            const key = container.stackName;
            const group = groups.get(key) ?? { name: key,
                managed: container.managed,
                standalone: !container.project,
                containers: [] };
            const own = changes.get(container.id) ?? [];
            const availability = computeAvailability(own, windowMs, now);
            if (stale) {
                availability.currentStatus = UNKNOWN;
                availability.currentForMs = null;
            }
            group.containers.push({
                id: container.id,
                name: container.name,
                service: container.service,
                state: stale ? "unknown" : container.state,
                health: stale ? "" : container.health,
                startedAt: container.startedAt,
                restartCount: stale ? null : container.restartCount,
                uptimeMs: stale ? null : containerUptime(container.state, container.startedAt, observedAt),
                availability,
                history: buildStabilityHistory(own, windowMs, now),
            });
            groups.set(key, group);
        }
        result.stacks = [ ...groups.values() ].sort((a, b) => a.name.localeCompare(b.name));
        for (const group of result.stacks) {
            group.containers.sort((a, b) => a.name.localeCompare(b.name));
        }
        return result;
    }
}

export const stabilityCollector = new StabilityCollector();

/**
 * Hook for the existing background stack scan.
 * @param stacks The stacks known to the panel
 * @param ownProject Compose project the panel itself runs as
 */
export async function observeContainerStability(stacks : ReadonlyMap<string, StackIdentity>, ownProject = "") : Promise<void> {
    await stabilityCollector.observe(stacks, Date.now(), ownProject);
}
