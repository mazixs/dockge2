import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("mcp_operation", table => {
        table.string("id").primary();
        table.string("key_id").notNullable();
        table.string("request_id").notNullable();
        table.string("action").notNullable();
        table.string("permission").notNullable();
        table.string("server_id").notNullable();
        table.string("stack_id").notNullable();
        table.string("parameters_hash").notNullable();
        table.string("fingerprint").notNullable();
        table.integer("policy_version").notNullable();
        table.string("summary").notNullable();
        table.string("state").notNullable();
        table.bigInteger("expires_at").notNullable();
        table.bigInteger("created_at").notNullable();
        table.string("approved_by").nullable();
        table.text("result").nullable();
        table.unique([ "key_id", "request_id" ]);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable("mcp_operation");
}
