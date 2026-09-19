import { strict as assert } from "node:assert";
import test from "node:test";
import { agentIsTooOld } from "../../backend/agent-manager";
import { AGENT_PROTOCOL_VERSION, MIN_AGENT_PROTOCOL_VERSION } from "../../common/agent-socket";
import packageJSON from "../../package.json" with { type: "json" };

test("an agent of this fork is accepted whatever its release number is", () => {
    // The release number restarted at 0.0.1 in this fork. Compared against the
    // upstream 1.4.0 it looks ancient, so a version comparison would disconnect
    // every agent - including a panel talking to its own build
    assert.equal(agentIsTooOld({ version: packageJSON.version,
        agentProtocol: AGENT_PROTOCOL_VERSION }), false);

    assert.equal(agentIsTooOld({ version: "0.0.1",
        agentProtocol: AGENT_PROTOCOL_VERSION }), false);
});

test("an agent speaking a protocol nobody understands any more is refused", () => {
    assert.equal(agentIsTooOld({ version: "9.9.9",
        agentProtocol: MIN_AGENT_PROTOCOL_VERSION - 1 }), true);

    // The protocol decides even when the release number looks fine
    assert.equal(agentIsTooOld({ version: "2.0.0",
        agentProtocol: 0 }), true);
});

test("an upstream Dockge is still judged on its version", () => {
    // Upstream has no protocol field, and there the release number does mean
    // something: agents only exist from 1.4.0 on
    assert.equal(agentIsTooOld({ version: "1.3.0" }), true);
    assert.equal(agentIsTooOld({ version: "1.4.0" }), false);
    assert.equal(agentIsTooOld({ version: "1.5.2" }), false);
});

test("the packet sent before sign-in is not held against an agent", () => {
    // The first info packet of a connection carries no version and no protocol
    // on purpose. Judging it would drop every agent at the handshake
    assert.equal(agentIsTooOld({}), false);
    assert.equal(agentIsTooOld({ version: undefined,
        agentProtocol: undefined }), false);

    // Nor is a malformed packet a reason to decide it is too old
    assert.equal(agentIsTooOld({ version: 5,
        agentProtocol: "1" }), false);
});
