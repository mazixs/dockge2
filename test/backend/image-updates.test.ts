import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearImageUpdateCache, readImageUpdates } from "../../backend/image-updates";

const IMAGE = "registry.example.com/demo/app:1";
const DIGEST_A = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const DIGEST_C = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

/**
 * A stand-in for the docker CLI whose answers the test controls.
 *
 * The real command talks to a registry and to the local image store, and neither may be
 * touched by a unit test - least of all on a machine that runs other people's stacks.
 * @returns The directory to put in front of PATH, and how to steer the answers
 */
function dockerStub() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dockge-docker-stub-"));
    const localFile = path.join(dir, "local");
    const remoteFile = path.join(dir, "remote");
    const callsFile = path.join(dir, "registry-calls");

    fs.writeFileSync(callsFile, "");

    fs.writeFileSync(path.join(dir, "docker"), `#!/bin/sh
case "$1 $2" in
    "image inspect")
        printf '["registry.example.com/demo/app@%s"]' "$(cat ${localFile})"
        ;;
    "buildx imagetools")
        echo "call" >> ${callsFile}
        printf '"%s"' "$(cat ${remoteFile})"
        ;;
    *)
        exit 1
        ;;
esac
`, { mode: 0o755 });

    return {
        dir,
        setLocal: (digest : string) => fs.writeFileSync(localFile, digest),
        setRemote: (digest : string) => fs.writeFileSync(remoteFile, digest),
        registryCalls: () => fs.readFileSync(callsFile, "utf8").split("\n").filter((line) => line !== "").length,
        remove: () => fs.rmSync(dir, { recursive: true,
            force: true }),
    };
}

test("a preview right after an update shows the new state without waiting for the cache", async () => {
    const stub = dockerStub();
    const originalPath = process.env.PATH;
    process.env.PATH = `${stub.dir}:${originalPath}`;
    clearImageUpdateCache();

    try {
        const now = Date.now();

        stub.setLocal(DIGEST_A);
        stub.setRemote(DIGEST_B);

        const before = await readImageUpdates([ IMAGE ], now);
        assert.equal(before[0]?.newer, true);
        assert.equal(before[0]?.local, DIGEST_A);
        assert.equal(stub.registryCalls(), 1);

        // The update pulled the image the registry serves
        stub.setLocal(DIGEST_B);

        const after = await readImageUpdates([ IMAGE ], now + 1000);
        assert.equal(after[0]?.newer, false, "the update that just happened must not still be announced");
        assert.equal(after[0]?.local, DIGEST_B);
        assert.equal(stub.registryCalls(), 1, "the registry answer is still reused inside its lifetime");
    } finally {
        process.env.PATH = originalPath;
        stub.remove();
        clearImageUpdateCache();
    }
});

test("forgetting one image asks the registry again, an expired entry too", async () => {
    const stub = dockerStub();
    const originalPath = process.env.PATH;
    process.env.PATH = `${stub.dir}:${originalPath}`;
    clearImageUpdateCache();

    try {
        const now = Date.now();

        stub.setLocal(DIGEST_B);
        stub.setRemote(DIGEST_B);

        assert.equal((await readImageUpdates([ IMAGE ], now))[0]?.newer, false);
        assert.equal(stub.registryCalls(), 1);

        stub.setRemote(DIGEST_C);
        clearImageUpdateCache([ IMAGE ]);

        const asked = await readImageUpdates([ IMAGE ], now + 1000);
        assert.equal(asked[0]?.newer, true);
        assert.equal(asked[0]?.remote, DIGEST_C);
        assert.equal(stub.registryCalls(), 2);

        // Eleven minutes later the kept answer may not be used any more
        const later = await readImageUpdates([ IMAGE ], now + 11 * 60_000);
        assert.equal(later[0]?.remote, DIGEST_C);
        assert.equal(stub.registryCalls(), 3);
    } finally {
        process.env.PATH = originalPath;
        stub.remove();
        clearImageUpdateCache();
    }
});

test("an unreadable registry leaves the answer unknown instead of guessing", async () => {
    const stub = dockerStub();
    const originalPath = process.env.PATH;
    process.env.PATH = `${stub.dir}:${originalPath}`;
    clearImageUpdateCache();

    try {
        stub.setLocal(DIGEST_A);
        stub.setRemote("");

        const result = await readImageUpdates([ IMAGE ], Date.now());

        assert.equal(result[0]?.newer, null);
        assert.equal(result[0]?.reason, "registryUnreachable");
    } finally {
        process.env.PATH = originalPath;
        stub.remove();
        clearImageUpdateCache();
    }
});
