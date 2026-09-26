import { strict as assert } from "node:assert";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PanelUpdate, runDocker, type PanelInstallation } from "../../backend/panel-update";
import { PANEL_UPDATE_LABELS, type PanelUpdateStatus } from "../../common/panel-update";

const enabled = process.env.DOCKGE_DOCKER_INTEGRATION === "1";
const IMAGE = "bash:5.2";
const FROM = "0.0.13";
const TO = "0.0.14";

/**
 * Stands in for the installed updater. It prints the lines of `<mode>.lines` (a `sleep N`
 * line waits), exits with `<mode>.exit`, and on SIGTERM prints `<mode>.onterm` and exits 1.
 * The arguments and the environment it was given are left next to it.
 */
const FAKE_UPDATER = `#!/bin/sh
dir=$(dirname "$0")
mode=status
for arg in "$@"; do
    case "$arg" in
        --dry-run) mode=preview ;;
        --yes) mode=apply ;;
    esac
done
printf '%s\\n' "$@" > "$dir/$mode.args" 2>/dev/null
env > "$dir/$mode.env" 2>/dev/null
trap 'cat "$dir/$mode.onterm" 2>/dev/null; exit 1' TERM
while IFS= read -r line; do
    case "$line" in
        sleep*) sleep "\${line#sleep }" & wait $! ;;
        *) printf '%s\\n' "$line" ;;
    esac
done < "$dir/$mode.lines"
exit "$(cat "$dir/$mode.exit")"
`;

function line(fields : Record<string, unknown>) : string {
    return JSON.stringify({ v: 1,
        op: "op-it",
        from: FROM,
        to: TO,
        ...fields });
}

const phase = (name : string) => line({ dockge2: "phase",
    phase: name,
    at: new Date().toISOString() });
const previewed = [
    line({ dockge2: "preview",
        channel: "stable",
        fields: [ "image" ],
        schemaChanges: false }),
    line({ dockge2: "result",
        outcome: "previewed",
        phase: "prepared" }),
];

interface Fixture {
    installation : PanelInstallation;
    updaterDir : string;
    script : (mode : "preview" | "apply" | "status", lines : string[], exitCode : number, onTerm? : string[]) => Promise<void>;
    observer : (version : string) => { panel : PanelUpdate; published : PanelUpdateStatus[] };
}

async function docker(...args : string[]) : Promise<string> {
    const res = await runDocker(args, { timeoutMs: 180_000 });
    assert.equal(res.code, 0, `docker ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
}

async function until(what : string, check : () => boolean, timeoutMs = 30_000) : Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

/**
 * A throwaway installation with the fake updater, a unique project and label, and a
 * cleanup that removes only the helpers of that installation
 */
async function withInstallation(callback : (fixture : Fixture) => Promise<void>) : Promise<void> {
    if ((await runDocker([ "image", "inspect", IMAGE ])).code !== 0) {
        await docker("pull", IMAGE);
    }
    const imageId = await docker("image", "inspect", "--format", "{{.Id}}", IMAGE);
    const root = await mkdtemp(path.join(os.tmpdir(), "dockge2-panel-update-it-"));
    const installDir = path.join(root, "inst");
    const updaterDir = path.join(installDir, ".dockge2");
    const dataDir = path.join(root, "data");
    await mkdir(updaterDir, { recursive: true });
    await mkdir(dataDir);
    await writeFile(path.join(updaterDir, "update"), FAKE_UPDATER);
    await chmod(path.join(updaterDir, "update"), 0o755);
    const project = `dockge2test${randomBytes(6).toString("hex")}`;
    const installation : PanelInstallation = { installDir,
        project,
        imageId,
        dataDir,
        dockerSocket: "/var/run/docker.sock" };
    const observers : PanelUpdate[] = [];

    const fixture : Fixture = {
        installation,
        updaterDir,
        script: async (mode, lines, exitCode, onTerm = []) => {
            await writeFile(path.join(updaterDir, `${mode}.lines`), lines.map((item) => `${item}\n`).join(""));
            await writeFile(path.join(updaterDir, `${mode}.exit`), `${exitCode}\n`);
            await writeFile(path.join(updaterDir, `${mode}.onterm`), onTerm.map((item) => `${item}\n`).join(""));
        },
        observer: (version) => {
            const published : PanelUpdateStatus[] = [];
            const panel = new PanelUpdate({ version,
                discover: async () => ({ managed: "yes",
                    installDir,
                    installation }),
                publish: (status) => published.push(status) });
            observers.push(panel);
            return { panel,
                published };
        },
    };

    try {
        await callback(fixture);
    } finally {
        for (const panel of observers) {
            panel.stop();
        }
        // Only what carries this installation's unique label, and the unique names
        const labelled = await runDocker([ "ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${PANEL_UPDATE_LABELS.installation}=${installDir}` ]);
        const ids = labelled.stdout.split("\n").map((item) => item.trim()).filter(Boolean);
        const names = [ "preview", "apply", "status" ].map((kind) => `dockge2-update-${project}-${kind}`);
        for (const ref of [ ...ids, ...names ]) {
            await runDocker([ "rm", "--force", ref ]);
        }
        await rm(root, { recursive: true,
            force: true });
    }
}

test("the observer follows real helpers and derives previewed, success, refused and unknown", {
    skip: enabled ? false : "set DOCKGE_DOCKER_INTEGRATION=1 to run against Docker",
    timeout: 240_000,
}, async () => {
    await withInstallation(async ({ script, observer, updaterDir, installation }) => {
        const { panel, published } = observer(FROM);
        await panel.start();

        // A dry run, followed until its result
        await script("preview", [ phase("prepared"), "sleep 1", ...previewed ], 0);
        const previewRequest = randomUUID();
        const started = await panel.preview(previewRequest, TO);
        assert.equal(started.operation?.kind, "preview");
        await until("the dry run result", () => published.at(-1)?.operation?.result?.outcome === "previewed");
        assert.equal((await readFile(path.join(updaterDir, "preview.args"), "utf8")).trim().split("\n").join(" "), `--progress json --version ${TO} --dry-run`);
        assert.doesNotMatch(await readFile(path.join(updaterDir, "preview.env"), "utf8"), /DOCKGE/);
        const labels = JSON.parse(await docker("inspect", "--format", "{{json .Config.Labels}}", `dockge2-update-${installation.project}-preview`)) as Record<string, string>;
        assert.equal(labels[PANEL_UPDATE_LABELS.request], previewRequest);
        assert.equal(labels[PANEL_UPDATE_LABELS.from], FROM);
        assert.equal(await docker("inspect", "--format", "{{.HostConfig.LogConfig.Type}} {{.HostConfig.RestartPolicy.Name}} {{.Config.User}}", `dockge2-update-${installation.project}-preview`), "json-file no 0:0");

        // The update runs, is followed through its phases, and the panel that answers
        // afterwards - the new version - reads it as a success
        await script("apply", [ phase("prepared"), "sleep 1", phase("downloaded"), "sleep 1", phase("checking-target"), line({ dockge2: "result",
            outcome: "success",
            phase: "success" }) ], 0);
        const applyRequest = randomUUID();
        await panel.apply(applyRequest, previewRequest, TO);
        await until("a running phase", () => published.some((status) => status.operation?.requestId === applyRequest && status.operation.running && status.operation.phase !== undefined));
        await until("the end of the update", () => published.at(-1)?.operation?.running === false);
        assert.equal(published.at(-1)?.operation?.result?.code, "version-mismatch", "the old version never reports success");
        const next = observer(TO);
        const after = await next.panel.status();
        assert.equal(after.operation?.result?.outcome, "success");
        assert.equal((await next.panel.dismiss(applyRequest)).operation, undefined);

        // A refused dry run
        await script("preview", [ line({ dockge2: "result",
            op: "",
            outcome: "refused",
            phase: "",
            error: "the release is not signed" }) ], 1);
        const refusedRequest = randomUUID();
        await panel.preview(refusedRequest, TO);
        await until("the refusal", () => published.at(-1)?.operation?.requestId === refusedRequest && published.at(-1)?.operation?.result?.outcome === "refused");

        // An update killed without a result is read from the journal by a status helper
        await script("preview", [ phase("prepared"), ...previewed ], 0);
        const secondPreview = randomUUID();
        await panel.preview(secondPreview, TO);
        await until("the second dry run", () => published.at(-1)?.operation?.requestId === secondPreview && published.at(-1)?.operation?.result?.outcome === "previewed");
        await script("apply", [ phase("prepared"), phase("downloaded"), phase("stopping") ], 137);
        await script("status", [ line({ dockge2: "journal",
            phase: "starting-target" }) ], 0);
        const killedRequest = randomUUID();
        await panel.apply(killedRequest, secondPreview, TO);
        await until("the interrupted update", () => published.at(-1)?.operation?.requestId === killedRequest && published.at(-1)?.operation?.result?.outcome === "unknown");
        assert.equal(published.at(-1)?.operation?.result?.code, "interrupted");
        assert.equal(published.at(-1)?.operation?.phase, "starting-target");
        assert.equal(await docker("ps", "--all", "--quiet", "--filter", `name=dockge2-update-${installation.project}-status`), "", "the status helper removed itself");
        await panel.dismiss(killedRequest);

        // A dry run is cancelled with SIGTERM and says so
        await script("preview", [ phase("prepared"), "sleep 60" ], 0, [ line({ dockge2: "result",
            outcome: "failed-before-cutover",
            phase: "failed-before-cutover",
            error: "cancelled" }) ]);
        const cancelRequest = randomUUID();
        await panel.preview(cancelRequest, TO);
        await until("the dry run to print its first phase", () => published.at(-1)?.operation?.requestId === cancelRequest && published.at(-1)?.operation?.phase === "prepared");
        await panel.cancel(cancelRequest);
        await until("the cancelled dry run", () => published.at(-1)?.operation?.requestId === cancelRequest && published.at(-1)?.operation?.running === false);
        assert.equal(published.at(-1)?.operation?.result?.outcome, "failed-before-cutover");
    });
});
