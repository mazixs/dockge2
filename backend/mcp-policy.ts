import { createHash } from "node:crypto";
import type { MachineIdentity } from "./mcp-keys";
import type { UserRole } from "./auth-access";

export const MCP_READ_TOOLS = [ "servers_list", "stacks_list", "containers_list", "container_status", "stability_get" ] as const;

/** Machine credentials are accepted exclusively in the Bearer header. */
export function parseBearer(header : string | undefined) : string | null {
    return /^Bearer dg2?_[a-f0-9]{32}\.[a-f0-9]{64}$/.test(header ?? "") ? header!.slice(7) : null;
}

/** High entropy secrets need a one-way digest, never reversible encryption. */
export function hashKey(key : string) : string {
    return createHash("sha256").update(key).digest("hex");
}

/** Deny unknown actions, including actions not advertised by tools/list. */
export function permittedTool(role : UserRole, tool : string) : boolean {
    return [ "viewer", "operator", "admin" ].includes(role) && (MCP_READ_TOOLS as readonly string[]).includes(tool);
}

/** The first transport exposes local resources only, with explicit stable identifiers. */
export function validScope(servers : string[], stacks : string[]) : boolean {
    return servers.length > 0 && servers.length <= 20 && new Set(servers).size === servers.length && servers.every((id) => /^[a-zA-Z0-9-]{1,64}$/.test(id)) && stacks.length > 0 && stacks.length <= 100 && new Set(stacks).size === stacks.length && stacks.every((id) => /^[a-zA-Z0-9-]{1,64}$/.test(id));
}

/** Never return raw Docker inspection or filesystem locations to a machine observer. */
export function safeContainer(row : Record<string, unknown>) {
    return { id: row.id,
        name: row.name,
        state: row.state,
        health: row.health,
        startedAt: row.startedAt,
        restartCount: row.restartCount };
}

/** Enforce action and exact server/stack pair again at the execution boundary. */
export function assertMcpAccess(identity : MachineIdentity, action : string, serverId : string, stackId : string) : void {
    if (identity.role !== "operator" || !identity.actions.includes(action) || identity.mode === "readonly" || !identity.servers.includes(serverId) || !identity.resources[serverId]?.includes(stackId)) {
        throw new Error("mcpPermissionDenied");
    }
}
