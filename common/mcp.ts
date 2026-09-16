/** Explicit machine permissions. None are ever granted to an observer. */
export const MCP_ACTIONS = [ "logs:read", "containers:control", "stacks:control", "files:read", "files:write", "git:read", "git:apply", "deploy" ] as const;
export type McpAction = typeof MCP_ACTIONS[number];
export type McpMode = "readonly" | "automatic" | "approval";
