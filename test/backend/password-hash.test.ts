import { strict as assert } from "node:assert";
import test from "node:test";
import {
    SHAKE256_LENGTH,
    generatePasswordHash,
    needRehashPassword,
    shake256,
    verifyPassword,
} from "../../backend/password-hash";

test("password hashing verifies the password and rejects a different one", () => {
    const hash = generatePasswordHash("correct horse battery staple");

    assert.notEqual(hash, "correct horse battery staple");
    assert.equal(verifyPassword("correct horse battery staple", hash), true);
    assert.equal(verifyPassword("wrong password", hash), false);
    assert.equal(needRehashPassword(hash), false);
});

test("shake256 returns the configured hexadecimal digest length", () => {
    assert.equal(shake256("", SHAKE256_LENGTH), "");
    const digest = shake256("Dockge", SHAKE256_LENGTH);
    assert.equal(digest.length, SHAKE256_LENGTH * 2);
    assert.equal(shake256("Dockge", SHAKE256_LENGTH), digest);
    assert.notEqual(shake256("Dockge!", SHAKE256_LENGTH), digest);
});
