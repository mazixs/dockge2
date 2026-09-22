import assert from "node:assert/strict";
import test from "node:test";
import { TerminalBuffer } from "../../backend/utils/terminal-buffer";

test("terminal replay stays bounded under burst output and preserves UTF-8", () => {
    const buffer = new TerminalBuffer(11, 3);
    buffer.pushItem("hello");
    assert.equal(buffer.read(), "hello");
    buffer.pushItem("🙂🙂🙂🙂");
    assert.ok(buffer.bytes <= 11);
    assert.match(buffer.read(), /Earlier terminal output omitted/);
    assert.ok(buffer.read().endsWith("🙂🙂"));
    assert.ok(!buffer.read().includes("�"));
    for (let i = 0; i < 1000; i++) {
        buffer.pushItem("x");
    }
    assert.equal(buffer.bytes, 3);
    assert.ok(buffer.read().endsWith("xxx"));
});
