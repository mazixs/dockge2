import type { Knex } from "knex";

export async function up(knex : Knex) : Promise<void> {
    await knex.schema.alterTable("mcp_audit", (table) => {
        table.string("server_id").nullable();
        table.string("stack_id").nullable();
        table.string("request_id").nullable();
        table.string("action").nullable();
    });
}

export async function down(knex : Knex) : Promise<void> {
    await knex.schema.alterTable("mcp_audit", (table) => {
        table.dropColumn("server_id");
        table.dropColumn("stack_id");
        table.dropColumn("request_id");
        table.dropColumn("action");
    });
}
