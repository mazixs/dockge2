import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const installer = path.resolve("install.sh");
// Shell command boundaries are controlled here; real cryptographic verification is a release CI gate.
async function fixture(t, extra = {}) {
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
[[ "\${DOWNLOAD_EXIT:-0}" == 0 ]] || exit "$DOWNLOAD_EXIT"
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
        await writeFile(path.join(bin, name), content, { mode: 0o700 });
    }
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
        const child = spawn("bash", [installer, "--dir", path.join(root, "installation"), ...args], {
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: root, TRACE: path.join(root, "trace"), ...extra },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { output += chunk; });
        const done = new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, output })));
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
});

for (const [name, env] of Object.entries({ download: { DOWNLOAD_EXIT: "22" }, checksum: { CHECKSUM_EXIT: "1" }, signature: { VERIFY_EXIT: "1" }, platform: { TEST_ARCH: "riscv64" } })) {
    test(`bootstrap ${name} failure cannot execute the updater or create an installation`, async t => {
        const f = await fixture(t, env);
        assert.notEqual((await f.start(["--version", "1.2.3"]).done).code, 0);
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
