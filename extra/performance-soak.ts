import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

/** Sample the isolated systemd scope, including the backend's Docker/Git CLI children. */
export async function sampleScope(unit : string) : Promise<Record<string, string>> {
    const { stdout } = await execute("systemctl", [ "--user", "show", `${unit}.scope`,
        "--property=MemoryCurrent,MemoryPeak,MemoryMax,CPUUsageNSec,CPUQuotaPerSecUSec,TasksCurrent" ]);
    return Object.fromEntries(stdout.trim().split("\n").map(line => {
        const at = line.indexOf("=");
        return [ line.slice(0, at), line.slice(at + 1) ];
    }));
}

/** Keep only this task's scoped backend under observation; no workload is deployed. */
export async function soak(unit : string, origin : string, durationMs : number, output : string) : Promise<void> {
    const started = Date.now();
    const samples : { elapsedMs : number; healthy : boolean; resources : Record<string, string> }[] = [];
    do {
        const healthy = (await fetch(origin, { signal: AbortSignal.timeout(10_000) })).ok;
        samples.push({ elapsedMs: Date.now() - started,
            healthy,
            resources: await sampleScope(unit) });
        await writeFile(output, JSON.stringify({ durationMs,
            samples }, null, 4) + "\n");
        if (!healthy) {
            throw new Error("Isolated backend failed its soak request");
        }
        await delay(Math.min(60_000, Math.max(0, durationMs - (Date.now() - started))));
    } while (Date.now() - started < durationMs);
}

/** Stop the exact transient scope created by this probe, including child processes. */
export async function stopScope(unit : string) : Promise<void> {
    await execute("systemctl", [ "--user", "stop", `${unit}.scope` ]);
}
