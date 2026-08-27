import { strict as assert } from "node:assert";
import { stat } from "node:fs/promises";
import test from "node:test";
import { Database } from "../../backend/database";
import { Agent } from "../../backend/models/agent";
import { Settings } from "../../backend/settings";
import { withDatabase } from "../helpers/database";

test("Database creates the SQLite schema, reads configuration and closes cleanly", async () => {
    await withDatabase(async ({ dataDir }) => {
        const db = Database.getKnex();
        const tables = await db("sqlite_master")
            .select("name")
            .where("type", "table")
            .orderBy("name");

        // Our own migrations create these, the auth tables come from better-auth
        for (const expected of [ "agent", "knex_migrations", "setting" ]) {
            assert.ok(tables.some((table) => table.name === expected), `${expected} table is missing`);
        }

        for (const authTable of [ "user", "session", "account", "verification", "twoFactor" ]) {
            assert.ok(tables.some((table) => table.name === authTable), `${authTable} table is missing`);
        }
        assert.equal(Database.readDBConfig().type, "sqlite");
        assert.ok(Database.getSize() > 0);

        await Database.shrink();
        await Database.close();
        assert.throws(() => Database.getKnex(), /Database is not connected/);

        await Database.init({
            config: {
                dataDir,
                stacksDir: "unused",
            },
        } as never);
    });
});

test("Database rejects malformed and unsupported configuration", async () => {
    await withDatabase(async ({ dataDir }) => {
        const configPath = `${dataDir}/db-config.json`;
        const fs = await import("node:fs/promises");

        await fs.writeFile(configPath, JSON.stringify({ type: 42 }));
        assert.throws(() => Database.readDBConfig(), /type must be a string/);

        await fs.writeFile(configPath, JSON.stringify({ type: "mysql" }));
        await assert.rejects(Database.connect(), /Unknown Database type: mysql/);
    });
});

test("Settings persists values, uses the cache and respects setting types", async () => {
    await withDatabase(async () => {
        await Settings.set("number", 42, "general");
        await Settings.set("object", { enabled: true }, "general");
        await Settings.set("text", "raw", "other");

        assert.equal(await Settings.get("number"), 42);
        assert.deepEqual(await Settings.get("object"), { enabled: true });
        assert.equal(await Settings.get("missing"), undefined);

        await Settings.set("number", 43, "general");
        assert.equal(await Settings.get("number"), 43);

        assert.deepEqual(await Settings.getSettings("general"), {
            number: 43,
            object: { enabled: true },
        });

        await Settings.setSettings("general", {
            number: 44,
            added: [ "a", "b" ],
            text: "must-not-overwrite-other-type",
        });
        assert.deepEqual(await Settings.getSettings("general"), {
            number: 44,
            object: { enabled: true },
            added: [ "a", "b" ],
        });
        assert.equal(await Settings.get("text"), "raw");

        Settings.deleteCache([ "number" ]);
        assert.equal(await Settings.get("number"), 44);
        Settings.stopCacheCleaner();
        assert.equal(Settings.cacheCleaner, undefined);
    });
});

test("Agent model creates, serializes, updates, lists and deletes agents", async () => {
    await withDatabase(async () => {
        const created = await Agent.create("https://agent.example.test:8443", "agent-user", "agent-password", "Primary");
        assert.equal(created.endpoint, "agent.example.test:8443");
        assert.deepEqual(created.toJSON(), {
            url: "https://agent.example.test:8443",
            username: "agent-user",
            endpoint: "agent.example.test:8443",
            name: "Primary",
        });

        assert.equal(await Agent.findByUrl("https://missing.example.test"), null);
        const list = await Agent.getAgentList();
        assert.equal(list[created.endpoint]?.name, "Primary");

        const updated = await Agent.updateName(created.url, "Updated");
        assert.ok(updated);
        assert.equal(updated.name, "Updated");
        assert.equal((await Agent.findByUrl(created.url))?.name, "Updated");

        const deleted = await Agent.deleteByUrl(created.url);
        assert.ok(deleted);
        assert.equal(await Agent.findByUrl(created.url), null);
        assert.equal(await Agent.deleteByUrl(created.url), null);
        assert.equal(await Agent.updateName(created.url, "No-op"), null);
    });
});

test("the database file is readable by its owner only", async (t) => {
    if (process.platform === "win32") {
        t.skip("POSIX mode bits do not exist on Windows");
        return;
    }

    await withDatabase(async () => {
        // The file carries the password hash and the secret that signs session cookies
        const mode = (await stat(Database.sqlitePath)).mode & 0o777;
        assert.equal(mode.toString(8), "600");

        // The write ahead log holds the same pages, so it must not be readable either
        const wal = await stat(`${Database.sqlitePath}-wal`).catch(() => null);

        if (wal) {
            assert.equal((wal.mode & 0o777).toString(8), "600");
        }
    });
});
