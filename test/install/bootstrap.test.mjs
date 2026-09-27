import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const installer = path.resolve("install.sh");
// Absolute, so that a test can leave the host's commands off PATH.
const bash = execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
// Shell command boundaries are controlled here; real cryptographic verification is a release CI gate.
async function fixture(t, extra = {}, { without = [] } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "dockge-bootstrap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const files = {
        uname: '#!/bin/sh\necho "${TEST_UNAME:-Linux}"\n',
        docker: '#!/bin/sh\nexit 99\n',
        sha256sum: '#!/bin/sh\ncat >/dev/null\nexit "${CHECKSUM_EXIT:-0}"\n',
        curl: `#!/bin/bash
while (($#)); do
    case "$1" in
        https://*) url="$1" ;;
        -o) output="$2"; shift ;;
    esac
    shift
done
printf '%s\\n' "$url" >> "$TRACE"
[[ "\${DOWNLOAD_EXIT:-0}" == 0 ]] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit "$DOWNLOAD_EXIT"; }
case "$url" in
    */releases/latest) printf 'https://github.com/mazixs/dockge2/releases/tag/v1.2.3' ;;
    */cosign-linux-*) cp "$FIXTURE/verifier" "$output" ;;
    *.sigstore.json) printf '{}' > "$output" ;;
    */dockge2-update-linux-*) cp "$FIXTURE/updater" "$output" ;;
    *) exit 91 ;;
esac
`,
    };
    // Make the host architecture deterministic without claiming to execute an ARM binary.
    files.uname = '#!/bin/sh\nif [ "$1" = -s ]; then echo "${TEST_OS:-Linux}"; else echo "${TEST_ARCH:-x86_64}"; fi\n';
    for (const [name, content] of Object.entries(files)) {
        if (!without.includes(name)) {
            await writeFile(path.join(bin, name), content, { mode: 0o700 });
        }
    }
    const PATH = without.length ? bin : `${bin}:${process.env.PATH}`;
    await writeFile(path.join(root, "verifier"), `#!/bin/sh
printf '%s\\n' "$@" > "$FIXTURE/verify-args"
exit "\${VERIFY_EXIT:-0}"
`, { mode: 0o700 });
    await writeFile(path.join(root, "updater"), `#!/bin/bash
printf '%s\\n' "$@" > "$FIXTURE/update-args"
if [[ "\${WAIT_FOR_SIGNAL:-}" == 1 ]]; then
    trap 'test -f "$(dirname "$0")/cosign" || exit 92; sleep 0.1; touch "$FIXTURE/recovered"; exit 73' TERM
    touch "$FIXTURE/started"
    while true; do sleep 0.1; done
fi
exit "\${UPDATER_EXIT:-0}"
`, { mode: 0o700 });
    const start = (args = []) => {
        const child = spawn(bash, [installer, "--dir", path.join(root, "installation"), ...args], {
            env: { ...process.env, PATH, FIXTURE: root, TRACE: path.join(root, "trace"), ...extra },
            stdio: ["ignore", "pipe", "pipe"],
        });
        // The streams are separate pipes, so only text within one of them keeps its order.
        let output = "", stdout = "", stderr = "";
        child.stdout.on("data", chunk => { output += chunk; stdout += chunk; });
        child.stderr.on("data", chunk => { output += chunk; stderr += chunk; });
        const done = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, output, stdout, stderr })));
        t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
        return { child, done };
    };
    return { root, start };
}

test("bootstrap verifies the exact tagged workflow before forwarding updater arguments and exit status", async t => {
    const f = await fixture(t, { UPDATER_EXIT: "23" });
    const result = await f.start(["--version", "v1.2.3", "--dry-run", "--compose-override", "/tmp/a b.yml"]).done;
    assert.equal(result.code, 23, result.output);
    const verify = await readFile(path.join(f.root, "verify-args"), "utf8");
    assert.match(verify, /--certificate-identity\nhttps:\/\/github.com\/mazixs\/dockge2\/\.github\/workflows\/release.yml@refs\/tags\/v1.2.3\n/);
    assert.match(verify, /--certificate-oidc-issuer\nhttps:\/\/token.actions.githubusercontent.com\n/);
    const args = await readFile(path.join(f.root, "update-args"), "utf8");
    assert.ok(args.includes("--compose-override\n/tmp/a b.yml\n"));
    assert.ok(args.includes("--dry-run\n"));
    assert.doesNotMatch(await readFile(path.join(f.root, "trace"), "utf8"), /\/main\//);
    assert.ok(result.stdout.startsWith([
        "Dockge2 installer", "", "Host", "  ok       Linux amd64", "  ok       curl", "  ok       sha256sum", "  ok       docker",
        "", "Updater", "  ok       Cosign 3.1.3 matches its pinned checksum", "  ok       updater 1.2.3 is signed by the v1.2.3 release workflow", "",
    ].join("\n")), result.stdout);
    assert.doesNotMatch(result.output, /\x1b/);
});

test("bootstrap names every unmet requirement with its fix before it downloads anything", async t => {
    const f = await fixture(t, { TEST_ARCH: "riscv64" }, { without: ["curl", "sha256sum", "docker"] });
    const result = await f.start(["--version", "1.2.3"]).done;
    assert.equal(result.code, 1, result.output);
    for (const line of [
        "  failed   Linux riscv64\n           Dockge2 runs on Linux amd64 or arm64.\n",
        "  missing  curl\n           Install it with the package manager, for example: apt install curl\n",
        "  missing  sha256sum\n",
        "  missing  docker\n           Install Docker Engine 24 or newer with the Compose plugin, then run this again:\n           https://docs.docker.com/engine/install/\n",
        "\nStopped: 4 requirements are not met.\nNothing was downloaded or changed.\n",
    ]) {
        assert.ok(result.stderr.includes(line), `${line}\n---\n${result.stderr}`);
    }
    await assert.rejects(access(path.join(f.root, "trace")));
});

for (const [name, env] of Object.entries({ download: { DOWNLOAD_EXIT: "22" }, checksum: { CHECKSUM_EXIT: "1" }, signature: { VERIFY_EXIT: "1" }, platform: { TEST_ARCH: "riscv64" } })) {
    test(`bootstrap ${name} failure cannot execute the updater or create an installation`, async t => {
        const f = await fixture(t, env);
        const result = await f.start(["--version", "1.2.3"]).done;
        assert.notEqual(result.code, 0);
        if (name !== "platform") {
            assert.match(result.stderr, /^  failed   .+\n(.|\n)*\nStopped: nothing was installed or changed\.\n$/);
        }
        if (name === "download") {
            assert.ok(result.stderr.includes("  failed   downloading Cosign 3.1.3\n           curl: (22) The requested URL returned error: 404\n"), result.stderr);
        }
        await assert.rejects(access(path.join(f.root, "update-args")));
        await assert.rejects(access(path.join(f.root, "installation")));
    });
}

test("a signal to the bootstrap reaches its updater and waits for recovery before cleanup", { timeout: 10000 }, async t => {
    const f = await fixture(t, { WAIT_FOR_SIGNAL: "1" });
    const { child, done } = f.start(["--version", "1.2.3", "--yes"]);
    for (let i = 0; i < 100; i++) {
        try { await access(path.join(f.root, "started")); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    await access(path.join(f.root, "started"));
    child.kill("SIGTERM");
    const result = await done;
    assert.equal(result.code, 73, result.output);
    await access(path.join(f.root, "recovered"));
});


test("the update script delegates offline to the installed updater with the deployment directory and exact arguments", async t => {
    const root = await mkdtemp(path.join(tmpdir(), "dockge-update-wrapper-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, ".dockge2"));
    await writeFile(path.join(root, ".dockge2", "update"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const result = execFileSync("bash", [path.resolve("extra/update-dockge.sh"), "--dry-run", "--version", "1.2.3", "--compose-override", "/tmp/a b.yml"], {
        cwd: root, encoding: "utf8",
    });
    assert.equal(result, ["--update", "--dir", root, "--dry-run", "--version", "1.2.3", "--compose-override", "/tmp/a b.yml", ""].join("\n"));
});
