import test from "node:test";
import assert from "node:assert/strict";
import { DelegatedInvocation, delegatedSubjectId } from "../../backend/mcp-delegated-operations";
import type { MachineIdentity } from "../../backend/mcp-keys";

const identity : MachineIdentity = { keyId: delegatedSubjectId("origin", "a".repeat(32)),
    userId: "owner",
    role: "operator",
    actions: [ "stacks:control" ],
    mode: "automatic",
    servers: [ "local" ],
    stacks: [ "stack" ],
    resources: { local: [ "stack" ] },
    policyVersion: 1 };

test("delegated subjects cannot collide with local keys or the same key on another issuer", () => {
    assert.notEqual(identity.keyId, "a".repeat(32));
    assert.notEqual(identity.keyId, delegatedSubjectId("another", "a".repeat(32)));
    assert.notEqual(delegatedSubjectId("a:b", "c"), delegatedSubjectId("a", "b:c"));
});

test("each current-authority check refreshes the issuer and unbound calls fail closed", async () => {
    const invocation = new DelegatedInvocation();
    let valid = true;
    let refreshes = 0;
    await assert.rejects(invocation.refresh(identity.keyId));
    await invocation.run(identity, async () => {
        refreshes++;
        if (!valid) {
            throw new Error("revoked");
        }
        return identity;
    }, async () => {
        assert.deepEqual(await invocation.refresh(identity.keyId), identity);
        await assert.rejects(invocation.refresh("another-key"));
        valid = false;
        await assert.rejects(invocation.refresh(identity.keyId));
    });
    assert.equal(refreshes, 2);
    await assert.rejects(invocation.refresh(identity.keyId));
});

test("parallel invocations do not borrow another key's authority", async () => {
    const invocation = new DelegatedInvocation();
    const other = { ...identity,
        keyId: delegatedSubjectId("second", "a".repeat(32)) };
    await Promise.all([ identity, other ].map(subject => invocation.run(subject, async () => subject, async () => {
        await Promise.resolve();
        assert.equal((await invocation.refresh(subject.keyId)).keyId, subject.keyId);
        await assert.rejects(invocation.refresh(subject === identity ? other.keyId : identity.keyId));
    })));
});
