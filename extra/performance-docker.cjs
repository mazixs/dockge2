#!/usr/bin/env node
// Synthetic read-only Docker protocol fixture. Used only by performance-audit.ts
// through an isolated PATH; it never forwards commands to the host daemon.
const { appendFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const count = Number(process.env.DOCKGE_PERF_CONTAINERS);
const stacks = Number(process.env.DOCKGE_PERF_STACKS);
if (!Number.isInteger(count) || count < 1 || count > 5000 || !Number.isInteger(stacks) || stacks < 1 || stacks > 1000) {
    throw new Error("Invalid synthetic Docker fixture sizes");
}
const rows = Array.from({ length: count }, (_, index) => {
    const project = `perf-${String(index % stacks).padStart(3, "0")}`;
    return { id: (index + 1).toString(16).padStart(64, "0"), name: `${project}-app-${index + 1}`,
        project, service: "app", workingDir: path.join(process.env.DOCKGE_STACKS_DIR, project),
        state: "running", health: "healthy", startedAt: "2026-09-01T00:00:00.000Z", restartCount: 0 };
});
let operation;
let result;
if (args[0] === "ps") {
    operation = args.includes("{{.ID}}") ? "runtime-ids" : "instances";
    const filter = args.find(arg => arg.startsWith("label=com.docker.compose.project.working_dir="));
    const selected = filter ? rows.filter(row => row.workingDir === filter.slice(filter.indexOf("=", 6) + 1)) : rows;
    result = operation === "runtime-ids" ? selected.map(row => row.id).join("\n") : selected.map(row => JSON.stringify({
        ID: row.id, Names: row.name, State: row.state, Status: "Up 2 hours (healthy)", HealthStatus: row.health,
        Labels: `com.docker.compose.project=${row.project},com.docker.compose.service=app,com.docker.compose.project.working_dir=${row.workingDir}`,
    })).join("\n");
} else if (args[0] === "inspect" && args[1] === "--type") {
    operation = "inspect-batch";
    result = rows.filter(row => args.includes(row.id)).map(row => JSON.stringify(row)).join("\n");
} else if (args[0] === "compose" && args[1] === "ls") {
    operation = "compose-list";
    result = JSON.stringify(Array.from(new Set(rows.map(row => row.project)), name => ({
        Name: name, Status: "running(1)", ConfigFiles: path.join(process.env.DOCKGE_STACKS_DIR, name, "compose.yaml"),
    })));
} else if (args[0] === "stats") {
    operation = "stats";
    result = rows.map(row => JSON.stringify({ Name: row.name, CPUPerc: "0.10%", MemUsage: "8MiB / 1GiB", MemPerc: "0.78%" })).join("\n");
} else {
    operation = "REJECTED";
}
appendFileSync(process.env.DOCKGE_PERF_COMMAND_LOG, JSON.stringify({ at: Date.now(), operation }) + "\n");
if (operation === "REJECTED") {
    process.stderr.write("Performance fixture rejected an unsupported Docker command\n");
    process.exitCode = 1;
} else {
    process.stdout.write(result + "\n");
}
