import { strict as assert } from "node:assert";
import test from "node:test";
import { verifyTotpToken } from "../../backend/totp";

test("TOTP verification accepts the RFC 6238 SHA-1 vector", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    assert.equal(verifyTotpToken("287082", secret, 59_000), true);
    assert.equal(verifyTotpToken("287083", secret, 59_000), false);
    assert.equal(verifyTotpToken("287082", "invalid!", 59_000), false);
    assert.equal(verifyTotpToken("287082", undefined, 59_000), false);
});
