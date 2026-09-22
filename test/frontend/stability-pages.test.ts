import assert from "node:assert/strict";
import test from "node:test";
import { stabilityPage } from "../../frontend/src/stability-pages";
import type { StabilityContainer } from "../../common/stability";

test("large stack groups span pages without losing or cloning container identities", () => {
    const containers = Array.from({ length: 123 }, (_, index) => ({ id: String(index) } as StabilityContainer));
    const stacks = [{ name: "large",
        managed: true,
        standalone: false,
        containers: containers.slice(0, 80) },
    { name: "small",
        managed: true,
        standalone: false,
        containers: containers.slice(80) }];
    const first = stabilityPage(stacks);
    const second = stabilityPage(stacks, 2);
    const last = stabilityPage(stacks, 999);
    assert.equal(first.total, 123);
    assert.equal(first.pages, 3);
    assert.deepEqual(second.groups.map(group => group.containers.length), [ 30, 20 ]);
    assert.deepEqual(second.groups.map(group => group.totalContainers), [ 80, 43 ]);
    assert.equal(last.current, 3);
    const all = [ first, second, last ].flatMap(page => page.groups.flatMap(group => group.containers));
    assert.equal(all.length, 123);
    all.forEach((container, index) => assert.equal(container, containers[index]));
    assert.equal(stabilityPage([], 3).current, 1);
    assert.deepEqual(stabilityPage([], 3).groups, []);
});
