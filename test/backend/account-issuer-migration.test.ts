import { strict as assert } from "node:assert";
import test from "node:test";
import knex from "knex";
import { down, up } from "../../backend/migrations/2026-09-26-1200-account-issuer";

// What Better Auth 1.7.2 created in the database of every installation from 0.0.10 to 0.0.13
const betterAuth172 = [
    "CREATE TABLE \"user\" (\"id\" text not null primary key, \"email\" text not null)",
    "CREATE TABLE \"account\" (\"id\" text not null primary key, \"issuer\" text not null, \"accountId\" text not null, \"providerId\" text not null, \"userId\" text not null references \"user\" (\"id\") on delete cascade, \"accessToken\" text, \"refreshToken\" text, \"idToken\" text, \"accessTokenExpiresAt\" date, \"refreshTokenExpiresAt\" date, \"scope\" text, \"password\" text, \"createdAt\" date not null, \"updatedAt\" date not null)",
    "CREATE INDEX \"account_userId_idx\" on \"account\" (\"userId\")",
    "CREATE UNIQUE INDEX \"account_issuer_accountId_uidx\" on \"account\" (\"issuer\", \"accountId\")",
];

async function database(t : test.TestContext) {
    const db = knex({ client: "better-sqlite3",
        connection: { filename: ":memory:" },
        useNullAsDefault: true });
    t.after(() => db.destroy());
    await db.raw("PRAGMA foreign_keys = ON");
    return db;
}

async function indexes(db : knex.Knex) : Promise<string[]> {
    const rows : { name : string }[] = await db.raw("PRAGMA index_list(\"account\")");
    return rows.map(row => row.name);
}

function account(id : string, userId : string) {
    return { id,
        accountId: userId,
        providerId: "credential",
        userId,
        password: "hash",
        createdAt: 1,
        updatedAt: 1 };
}

test("an account made by Better Auth 1.7.2 survives and a new one can be added after the upgrade", async (t) => {
    const db = await database(t);
    for (const statement of betterAuth172) {
        await db.raw(statement);
    }
    await db("user").insert({ id: "owner",
        email: "owner@example.com" });
    await db("user").insert({ id: "viewer",
        email: "viewer@example.com" });
    await db("account").insert({ ...account("a1", "owner"),
        issuer: "local:credential" });

    // Without the migration the newer Better Auth writes no issuer and the insert breaks NOT NULL
    await assert.rejects(db("account").insert(account("a2", "viewer")), /NOT NULL/);

    await up(db);

    assert.equal(await db.schema.hasColumn("account", "issuer"), false);
    assert.ok(!(await indexes(db)).includes("account_issuer_accountId_uidx"));
    assert.ok((await indexes(db)).includes("account_userId_idx"), "the index Better Auth still uses stays");
    assert.deepEqual(await db("account").select("id", "userId", "password"), [{ id: "a1",
        userId: "owner",
        password: "hash" }]);

    await db("account").insert(account("a2", "viewer"));
    assert.equal((await db("account")).length, 2);

    // A second run, or a database that is already clean, changes nothing
    await up(db);
    assert.equal((await db("account")).length, 2);
});

test("rolling the migration back gives every password account the issuer 1.7.2 expects", async (t) => {
    const db = await database(t);
    for (const statement of betterAuth172) {
        await db.raw(statement);
    }
    await db("user").insert({ id: "owner",
        email: "owner@example.com" });
    await db("account").insert({ ...account("a1", "owner"),
        issuer: "local:credential" });
    await up(db);

    await down(db);

    assert.equal(await db.schema.hasColumn("account", "issuer"), true);
    assert.ok((await indexes(db)).includes("account_issuer_accountId_uidx"));
    assert.deepEqual(await db("account").select("id", "issuer"), [{ id: "a1",
        issuer: "local:credential" }]);
});

test("a fresh installation has no account table yet and the migration leaves it to Better Auth", async (t) => {
    const db = await database(t);

    await up(db);
    await down(db);

    assert.equal(await db.schema.hasTable("account"), false);
});
