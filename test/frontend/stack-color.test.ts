import { strict as assert } from "node:assert";
import test from "node:test";
import { stackColor } from "../../frontend/src/stack-color";

test("a stack keeps the same colour whatever is happening to it", () => {
    // The colour is a way to find a row again, not a statement about health: the same
    // name has to look the same on every screen and after every restart
    assert.equal(stackColor("adguard"), stackColor("adguard"));
    assert.equal(stackColor("adguard"), stackColor("  Adguard  "));

    const known = [ "green", "purple", "blue", "teal", "gray" ];

    for (const name of [ "app", "immich", "uptime", "vault", "zabbix", "3proxy", "-weird", "", "ЯндексДиск" ]) {
        assert.ok(known.includes(stackColor(name)), `${name} got ${stackColor(name)}`);
    }
});

test("names starting with different letters are told apart", () => {
    assert.notEqual(stackColor("app"), stackColor("immich"));
    assert.notEqual(stackColor("uptime"), stackColor("vault"));
});
