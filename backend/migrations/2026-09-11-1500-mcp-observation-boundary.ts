import type { Knex } from "knex";

export async function up(knex : Knex) : Promise<void> {
    if (!await knex.schema.hasColumn("mcp_stack_identity", "created_at")) {
        await knex.schema.alterTable("mcp_stack_identity", (table) => {
            table.bigInteger("created_at").notNullable().defaultTo(0);
        });
    }
}

export async function down(knex : Knex) : Promise<void> {
    await knex.schema.alterTable("mcp_stack_identity", (table) => {
        table.dropColumn("created_at");
    });
}
