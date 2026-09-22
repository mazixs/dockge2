import { mkdir, copyFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

/** Bound fixture input before creating temporary directories or processes. */
export function fixtureSize(value : string | undefined, fallback : number) : number {
    const count = Number(value ?? fallback);
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
        throw new Error("Performance fixture sizes must be integers between 1 and 1000");
    }
    return count;
}

interface RuntimeOptions {
    root : string;
    work : string;
    output : string;
    scope : string;
    stackCount : number;
    port : number;
    dataDir : string;
    stacksDir : string;
}

/** Launch only this probe's backend, optionally with a synthetic read-only Docker CLI. */
export async function launchBackend(options : RuntimeOptions) {
    const { root, work, output, scope, stackCount, port, dataDir, stacksDir } = options;
    const fixture = process.env.DOCKGE_PERF_CONTAINERS;
    const bin = path.join(work, "bin");
    if (fixture) {
        fixtureSize(fixture, 1);
        await mkdir(bin);
        await copyFile(path.join(root, "extra/performance-docker.cjs"), path.join(bin, "docker"));
        await chmod(path.join(bin, "docker"), 0o700);
    }
    const backendArgs = [ "--import", "tsx", path.join(root, "backend/index.ts") ];
    return spawn(scope ? "systemd-run" : process.execPath, scope
        ? [ "--user", "--scope", "--quiet", `--unit=${scope}`, "-p", "MemoryMax=1G", "-p", "CPUQuota=100%", process.execPath, ...backendArgs ]
        : backendArgs, {
        cwd: work,
        env: { ...process.env,
            PATH: fixture ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH,
            DOCKGE_PERF_STACKS: String(stackCount),
            DOCKGE_PERF_COMMAND_LOG: path.join(output, "docker-commands.jsonl"),
            DOCKGE_DATA_DIR: dataDir,
            DOCKGE_STACKS_DIR: stacksDir,
            DOCKGE_PORT: String(port),
            DOCKGE_HOSTNAME: "127.0.0.1",
            NODE_ENV: "production" },
        stdio: [ "ignore", "pipe", "pipe" ],
    });
}
