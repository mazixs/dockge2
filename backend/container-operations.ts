import path from "node:path";
import { createHash } from "node:crypto";
import { readComposeServices } from "../common/compose-status";
import type { ContainerRuntime } from "../common/stability";
import type { Stack } from "./stack";
import { spawn, type ChildProcessResult } from "./child-process";
import { readDockerRuntime } from "./stability";

/** Bind lifecycle preparation to the exact instance and observed start state. */
export function containerOperationFingerprint(row: ContainerRuntime): string {
    return createHash("sha256").update(JSON.stringify([ row.id, row.workingDir, row.service, row.state, row.startedAt ])).digest("hex");
}

/** Transport-independent container service binds every command to a current managed stack. */
export class ContainerOperations {
    constructor(private runtime: () => Promise<ContainerRuntime[]> = readDockerRuntime,
        private execute: (args: string[], maxBuffer: number) => Promise<ChildProcessResult> = (args, maxBuffer) => spawn("docker", args, { encoding: "utf8",
            maxBuffer,
            timeoutMs: 120_000 })) {}

    /** Never trust a caller-provided stack name or a short/reusable container name. */
    async inspect(stack: Stack, containerId: string): Promise<ContainerRuntime> {
        if (!/^[a-f0-9]{64}$/.test(containerId) || !stack.isManagedByDockge) {
            throw new Error("mcpPermissionDenied");
        }
        const row = (await this.runtime()).find(item => item.id === containerId);
        if (!row || !row.workingDir || path.resolve(row.workingDir) !== path.resolve(stack.path) || !readComposeServices(stack.composeYAML).includes(row.service)) {
            throw new Error("mcpPermissionDenied");
        }
        return row;
    }

    /** Execute only an enumerated lifecycle operation against an immutable container ID. */
    async control(stack: Stack, containerId: string, action: "start" | "stop" | "restart", guard: () => Promise<void> = async () => {}, expectedFingerprint?: string): Promise<void> {
        if (![ "start", "stop", "restart" ].includes(action)) {
            throw new Error("mcpPermissionDenied");
        }
        const current = await this.inspect(stack, containerId);
        if (expectedFingerprint && containerOperationFingerprint(current) !== expectedFingerprint) {
            throw new Error("mcpOperationStale");
        }
        await guard();
        try {
            await this.execute([ action, containerId ], 64 * 1024);
        } catch {
            throw new Error("mcpOperationFailed");
        }
    }

    /** Bound both the time range and captured bytes; diagnostics never escape on failure. */
    async logs(stack: Stack, containerId: string, tail: number, sinceSeconds: number, guard: () => Promise<void> = async () => {}): Promise<string> {
        if (!Number.isInteger(tail) || tail < 1 || tail > 200 || !Number.isInteger(sinceSeconds) || sinceSeconds < 1 || sinceSeconds > 86400) {
            throw new Error("mcpPermissionDenied");
        }
        await this.inspect(stack, containerId);
        await guard();
        try {
            const result = await this.execute([ "logs", "--tail", String(tail), "--since", `${sinceSeconds}s`, containerId ], 64 * 1024);
            return await stack.redactSecrets((result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? ""));
        } catch {
            throw new Error("mcpOperationFailed");
        }
    }
}
