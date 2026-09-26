// The docker arguments of an update helper exactly as the panel builds them, NUL separated,
// so the release gate runs the production helper rather than a copy of it
import { randomUUID } from "node:crypto";
import { panelUpdateRunArgs } from "../../backend/panel-update";

const [ kind, installDir, project, dataDir, imageId, from, to ] = process.argv.slice(2);
if (kind !== "preview" && kind !== "apply" && kind !== "status") {
    throw new Error(`Unknown helper kind: ${kind}`);
}
if (!installDir || !project || !dataDir || !imageId || !from || !to) {
    throw new Error("Usage: helper-args.ts <kind> <install dir> <project> <data dir> <image> <from> <to>");
}
const args = panelUpdateRunArgs({ installDir,
    project,
    imageId,
    dataDir,
    dockerSocket: "/var/run/docker.sock" }, { kind,
    requestId: randomUUID(),
    from,
    to,
    startedAt: new Date().toISOString() });
process.stdout.write(`${args.join("\0")}\0`);
