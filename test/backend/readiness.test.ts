import { strict as assert } from "node:assert";
import test from "node:test";
import { Readiness } from "../../backend/readiness";

test("readiness requires initialization and a working database; shutdown invalidates it", async () => {
    const state = new Readiness();
    let calls = 0;
    const query = async () => {
        calls++;
    };
    assert.equal(await state.check(() => false, query), false);
    assert.equal(calls, 0);
    state.initialized = true;
    assert.equal(await state.check(() => false, query), true);
    assert.equal(await state.check(() => false, async () => {
        throw new Error("missing auth table");
    }), false);
    assert.equal(await state.check(() => true, query), false);
});

test("readiness shares an in-flight query and rechecks shutdown after it", async () => {
    const state = new Readiness();
    state.initialized = true;
    let stopping = false;
    let finish! : () => void;
    let calls = 0;
    const query = () => {
        calls++;
        return new Promise<void>(resolve => {
            finish = resolve;
        });
    };
    const a = state.check(() => stopping, query);
    const b = state.check(() => stopping, query);
    assert.equal(calls, 1);
    stopping = true;
    finish();
    assert.deepEqual(await Promise.all([ a, b ]), [ false, false ]);
});

test("an unresponsive database has a bounded readiness response", async () => {
    const state = new Readiness();
    state.initialized = true;
    assert.equal(await state.check(() => false, () => new Promise(() => {})), false);
});

test("a database with a future migration cannot silently start an older application", async () => {
    const { withDatabase } = await import("../helpers/database");
    const { Database } = await import("../../backend/database");
    await withDatabase(async () => {
        await Database.getKnex()("knex_migrations").insert({ name: "2099-01-01-future-schema.ts",
            batch: 999,
            migration_time: new Date() });
        await assert.rejects(Database.patch(), /following files are missing/);
    });
});
