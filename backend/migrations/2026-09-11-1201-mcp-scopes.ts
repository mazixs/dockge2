import type { Knex } from "knex";

export async function up(knex : Knex) : Promise<void> {
    await knex.schema.alterTable("mcp_key", (table) => {
        table.text("resources").notNullable().defaultTo("{}");
        table.text("actions").notNullable().defaultTo("[]");
        table.string("mode").notNullable().defaultTo("readonly");
    });
    const rows = await knex("mcp_key").select("id", "stacks");
    for (const row of rows) {
        await knex("mcp_key").where({ id: row.id }).update({ resources: JSON.stringify({ local: JSON.parse(row.stacks) }) });
    }
}

export async function down(knex : Knex) : Promise<void> {
    await knex.schema.alterTable("mcp_key", (table) => {
        table.dropColumn("resources");
        table.dropColumn("actions");
        table.dropColumn("mode");
    });
}
