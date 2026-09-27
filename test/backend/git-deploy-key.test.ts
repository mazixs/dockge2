import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { GitDeployKeys, publicKey, repositoryIdentity } from "../../backend/git-deploy-key";
import { sshCommand } from "../../backend/git-command";
import { remoteRefusal } from "../../backend/stack-git";

async function keys(t: test.TestContext) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dockge-deploy-key-"));
    t.after(() => fs.rm(root, { recursive: true,
        force: true }));
    const dir = path.join(root, "git-keys");
    return { dir,
        keys: new GitDeployKeys(dir) };
}

const repository = "git@github.com:example/private.git";

test("a deploy key is created once, private to the server, and found however the address is typed", async (t) => {
    const f = await keys(t);
    assert.equal(await f.keys.get(repository), null);
    assert.equal(await f.keys.keyFile(repository), undefined);

    const created = await f.keys.create(repository);
    assert.match(created.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+ dockge2$/);
    const file = await f.keys.keyFile(repository);
    assert.ok(file);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.dir)).mode & 0o777, 0o700);
    assert.equal(created.fingerprint, execFileSync("ssh-keygen", [ "-lf", `${file}.pub` ]).toString().split(" ")[1]);

    const bytes = await fs.readFile(file);
    assert.deepEqual(await f.keys.create(repository), created);
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.deepEqual(await f.keys.get("git@github.com:example/private"), created);
    assert.deepEqual((await fs.readdir(f.dir)).sort(), [ path.basename(file), `${path.basename(file)}.pub` ].sort());
    assert.equal(await f.keys.get("git@github.com:example/other.git"), null);
});

test("a deploy key is only for SSH addresses", async (t) => {
    const f = await keys(t);
    for (const address of [ "https://github.com/example/private.git", "", "ext::sh -c id" ]) {
        await assert.rejects(f.keys.create(address), { message: "gitDeployKeyNeedsSsh" });
        assert.equal(await f.keys.keyFile(address), undefined);
    }
    assert.equal(repositoryIdentity(" ssh://git@gitlab.com/a/b.git/ "), "ssh://git@gitlab.com/a/b");
});

test("only an ed25519 public line is reported", () => {
    assert.throws(() => publicKey("ssh-rsa AAAA dockge2"), { message: "gitDeployKeyFailed" });
    assert.throws(() => publicKey("-----BEGIN OPENSSH PRIVATE KEY-----"), { message: "gitDeployKeyFailed" });
    assert.equal(publicKey("ssh-ed25519 AAAA someone@host").publicKey, "ssh-ed25519 AAAA dockge2");
});

test("ssh gets the pinned hosts and, with a key, that key alone", () => {
    const plain = sshCommand();
    assert.match(plain, /^ssh -oBatchMode=yes -o 'GlobalKnownHostsFile=".*ssh_known_hosts" \/etc\/ssh\/ssh_known_hosts'$/);
    assert.doesNotMatch(plain, /IdentitiesOnly/);
    assert.equal(sshCommand("/data/git keys/it's"), `${plain} -oIdentitiesOnly=yes -oIdentityAgent=none -i '/data/git keys/it'\\''s'`);
    for (const unusable of [ "/data/\"key", "/data/%d", "/data/\nkey" ]) {
        assert.throws(() => sshCommand(unusable));
    }
});

test("a refusal names the fix only when the remote said what it was", () => {
    assert.equal(remoteRefusal({ stderr: "Host key verification failed.\nfatal: Could not read from remote repository." }), "gitHostKeyUnknown");
    assert.equal(remoteRefusal({ stderr: "git@github.com: Permission denied (publickey)." }), "gitAccessDenied");
    assert.equal(remoteRefusal({ stderr: "ERROR: Repository not found." }), "gitAccessDenied");
    assert.equal(remoteRefusal({ stderr: "fatal: could not read Username for 'https://github.com'" }), "gitAccessDenied");
    assert.equal(remoteRefusal({ stderr: "fatal: unable to access: Could not resolve host" }), "gitRemoteOperationFailed");
    assert.equal(remoteRefusal(undefined), "gitRemoteOperationFailed");
});
