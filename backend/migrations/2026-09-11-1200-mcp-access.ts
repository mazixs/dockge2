import type { Knex } from "knex";

export async function up(knex : Knex) : Promise<void> {
    await knex.schema.createTable("mcp_key", (table) => {
        table.string("id").primary();
        table.string("name").notNullable();
        table.string("user_id").notNullable();
        table.string("secret_hash", 64).notNullable();
        table.string("role").notNullable();
        table.text("servers").notNullable();
        table.text("stacks").notNullable();
        table.bigInteger("created_at").notNullable();
        table.bigInteger("expires_at").notNullable();
        table.bigInteger("revoked_at").nullable();
        table.bigInteger("last_used_at").nullable();
        table.integer("policy_version").notNullable().defaultTo(1);
    });
    await knex.schema.createTable("mcp_stack_identity", (table) => {
        table.string("id").primary();
        table.string("name").notNullable().unique();
        table.string("fingerprint").notNullable();
    });
    await knex.schema.createTable("mcp_audit", (table) => {
        table.increments("id");
        table.bigInteger("at").notNullable().index();
        table.string("key_id").nullable();
        table.string("tool").notNullable();
        table.string("outcome").notNullable();
        table.integer("duration_ms").notNullable();
    });
}

export async function down(knex : Knex) : Promise<void> {
    await knex.schema.dropTable("mcp_audit");
    await knex.schema.dropTable("mcp_stack_identity");
    await knex.schema.dropTable("mcp_key");
}
