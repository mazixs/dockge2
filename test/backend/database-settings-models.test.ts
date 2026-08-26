import { strict as assert } from "node:assert";
import test from "node:test";
import jwt from "jsonwebtoken";
import { Database } from "../../backend/database";
import { Agent } from "../../backend/models/agent";
import { User } from "../../backend/models/user";
import { generatePasswordHash, verifyPassword } from "../../backend/password-hash";
import { Settings } from "../../backend/settings";
import { withDatabase } from "../helpers/database";

test("Database creates the SQLite schema, reads configuration and closes cleanly", async () => {
    await withDatabase(async ({ dataDir }) => {
        const db = Database.getKnex();
        const tables = await db("sqlite_master")
            .select("name")
            .where("type", "table")
            .orderBy("name");

        assert.deepEqual(tables.map((table) => table.name), [
            "agent",
            "knex_migrations",
            "knex_migrations_lock",
            "setting",
            "sqlite_sequence",
            "user",
        ]);
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

test("User model supports active filtering, password reset and JWT creation", async () => {
    await withDatabase(async () => {
        const db = Database.getKnex();
        const oldPassword = generatePasswordHash("old-password");
        await db("user").insert([
            {
                username: "active-user",
                password: oldPassword,
                active: 1,
                twofa_status: 0,
            },
            {
                username: "inactive-user",
                password: generatePasswordHash("inactive-password"),
                active: 0,
                twofa_status: 0,
            },
        ]);

        const first = await User.findFirst();
        assert.ok(first);
        assert.equal(first.username, "active-user");

        const active = await User.findByUsername("active-user");
        assert.ok(active);
        assert.equal(active.active, 1);
        assert.equal(await User.findByUsername("inactive-user"), null);

        const inactive = await User.findByUsername("inactive-user", false);
        assert.ok(inactive);
        assert.equal(inactive.active, 0);
        assert.deepEqual(await User.findById(active.id), active);
        assert.equal(await User.findById(inactive.id), null);

        const token = User.createJWT(active, "jwt-secret");
        const decoded = jwt.verify(token, "jwt-secret") as { username: string; h: string };
        assert.equal(decoded.username, "active-user");
        assert.equal(typeof decoded.h, "string");

        await active.resetPassword("new-password");
        const updated = await User.findById(active.id, false);
        assert.ok(updated);
        assert.equal(verifyPassword("new-password", updated.password), true);
        assert.equal(verifyPassword("old-password", updated.password), false);

        await User.resetPassword(active.id, "final-password");
        const finalUser = await User.findById(active.id, false);
        assert.ok(finalUser);
        assert.equal(verifyPassword("final-password", finalUser.password), true);
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
