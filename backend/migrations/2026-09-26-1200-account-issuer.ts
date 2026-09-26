import type { Knex } from "knex";

// Better Auth 1.7.0-1.7.2 created the account table with a required issuer and a unique index on
// it; 1.7.3 went back to identifying an account by provider and account ID and no longer writes
// the issuer, so a new account would break the NOT NULL. The steps are the SQLite ones of
// https://better-auth.com/docs/guides/1-7-upgrade-guide. The auth tables are created after the
// Knex migrations, so a fresh installation has no account table here yet.

export async function up(knex : Knex) : Promise<void> {
    if (!await knex.schema.hasTable("account") || !await knex.schema.hasColumn("account", "issuer")) {
        return;
    }
    await knex.raw("DROP INDEX IF EXISTS \"account_issuer_accountId_uidx\"");
    await knex.raw("ALTER TABLE \"account\" DROP COLUMN \"issuer\"");
}

// The panel has only password accounts, and 1.7.2 gave each of them this issuer
export async function down(knex : Knex) : Promise<void> {
    if (!await knex.schema.hasTable("account") || await knex.schema.hasColumn("account", "issuer")) {
        return;
    }
    await knex.raw("ALTER TABLE \"account\" ADD COLUMN \"issuer\" text not null default 'local:credential'");
    await knex.raw("CREATE UNIQUE INDEX \"account_issuer_accountId_uidx\" on \"account\" (\"issuer\", \"accountId\")");
}
