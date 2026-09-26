import { strict as assert } from "node:assert";
import test from "node:test";
import {
    compareStacks,
    containerMatchesFilter,
    containerSearchFields,
    listQuery,
    matchesSearch,
    pageRows,
    readListFilter,
    stackMatchesFilter,
    stackSearchFields,
    withListQuery,
    type ListedStack,
} from "../../frontend/src/stack-list-model";
import type { StandaloneContainer } from "../../common/types/container";
import { ATTENTION, CREATED_FILE, EXITED, RUNNING, UNKNOWN } from "../../common/util-common";

/**
 * A viewer-shaped stack row
 * @param name Stack name
 * @param status Aggregated status
 * @param extra Other fields
 * @returns Stack row
 */
function stack(name : string, status : number, extra : Partial<ListedStack> = {}) : ListedStack {
    return { name,
        status,
        endpoint: "",
        isManagedByDockge: true,
        availability: null,
        services: [],
        issues: [],
        ...extra };
}

/**
 * A standalone container row
 * @param name Container name
 * @param state Docker state
 * @param exitCode Last exit code
 * @returns Container row
 */
function container(name : string, state : string, exitCode : number | null = null) : StandaloneContainer {
    return { id: name.padEnd(64, "0"),
        name,
        image: `${name}:1`,
        state,
        status: "",
        health: "",
        exitCode,
        source: "standalone",
        lastSeen: 0 };
}

test("the list keeps only its own keys of the address, and drops empty ones", () => {
    assert.deepEqual(listQuery({ q: "web",
        filter: "attention",
        tab: "logs" }), { q: "web",
        filter: "attention" });
    assert.deepEqual(listQuery({ q: "",
        filter: [ "a", "b" ] }), {});
    assert.deepEqual(withListQuery({ q: "web",
        tab: "logs" }, "q", ""), { tab: "logs" });
    assert.deepEqual(withListQuery({ tab: "logs" }, "filter", "stopped"), { tab: "logs",
        filter: "stopped" });
    assert.equal(readListFilter("attention"), "attention");
    assert.equal(readListFilter("everything"), "");
    assert.equal(readListFilter(undefined), "");
});

test("a stack is found by its name, its server, and the names and images of its services", () => {
    const row = stack("media", RUNNING, { services: [{ name: "gotenberg",
        state: "running",
        isOneShot: false,
        image: "gotenberg/gotenberg:8" }, { name: "db",
        state: "running",
        isOneShot: false }] });
    const fields = stackSearchFields(row, "Office NAS");

    for (const needle of [ "", "media", "gotenberg", "gotenberg/gotenberg:8", "office nas" ]) {
        assert.ok(matchesSearch(needle, fields), needle);
    }
    assert.ok(!matchesSearch("postgres", fields));
    assert.ok(matchesSearch("tool:1", containerSearchFields(container("tool", "running"), "")));
    assert.ok(matchesSearch("office", containerSearchFields(container("tool", "running"), "Office NAS")));
});

test("filters sort stacks and standalone containers by the same words their chips say", () => {
    assert.ok(stackMatchesFilter(stack("a", RUNNING), "running"));
    assert.ok(stackMatchesFilter(stack("b", ATTENTION), "attention"));
    assert.ok(stackMatchesFilter(stack("c", EXITED), "stopped"), "exited on purpose is stopped");
    assert.ok(stackMatchesFilter(stack("d", CREATED_FILE), "stopped"));
    assert.ok(stackMatchesFilter(stack("e", UNKNOWN), "unknown"));
    assert.ok(!stackMatchesFilter(stack("f", RUNNING), "updates"), "a viewer row has no source");
    assert.ok(stackMatchesFilter(stack("g", RUNNING, { source: { kind: "git",
        remote: "",
        branch: "main",
        behind: 2,
        checkedAt: null,
        dirty: false } } as Partial<ListedStack>), "updates"));

    assert.ok(containerMatchesFilter(container("up", "running"), "running"));
    assert.ok(containerMatchesFilter(container("crashed", "exited", 1), "attention"), "a crash needs attention");
    assert.ok(containerMatchesFilter(container("done", "exited", 0), "stopped"));
    assert.ok(containerMatchesFilter(container("lost", "unknown"), "unknown"));
    assert.ok(!containerMatchesFilter(container("up", "running"), "updates"));
    assert.ok(containerMatchesFilter(container("up", "running"), ""));
});

test("alarming stacks come first, then by name", () => {
    const rows = [ stack("zeta", RUNNING), stack("alpha", RUNNING), stack("beta", ATTENTION), stack("gamma", UNKNOWN) ];
    assert.deepEqual(rows.sort(compareStacks).map((row) => row.name), [ "beta", "alpha", "zeta", "gamma" ]);
});

test("a long group shows its first page and never hides the open row", () => {
    const rows = Array.from({ length: 120 }, (_, index) => index);
    assert.equal(pageRows(rows, 50, () => false).length, 50);
    assert.deepEqual(pageRows(rows, 50, (row) => row === 99).slice(-2), [ 49, 99 ]);
    assert.deepEqual(pageRows(rows.slice(0, 10), 50, () => false), rows.slice(0, 10));
});

test("grouping five hundred stacks stays well under the time of a frame", () => {
    const rows = Array.from({ length: 500 }, (_, index) => stack(`stack-${index}`, index % 7 === 0 ? ATTENTION : RUNNING, {
        services: [{ name: `svc-${index}`,
            state: "running",
            isOneShot: false,
            image: `registry.example/app-${index}:1` }],
    }));
    const started = performance.now();
    for (let round = 0; round < 10; round++) {
        const found = rows.filter((row) => stackMatchesFilter(row, "") && matchesSearch("app-4", stackSearchFields(row, "")));
        found.sort(compareStacks);
        pageRows(found, 50, () => false);
    }
    assert.ok((performance.now() - started) / 10 < 16, "search, sort and paging of 500 rows");
});
