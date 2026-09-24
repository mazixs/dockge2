import type { Knex } from "knex";

export async function up(knex : Knex) : Promise<void> {
    await knex.schema.alterTable("mcp_audit", (table) => {
        table.string("client_name").nullable();
        table.string("client_version").nullable();
        table.string("protocol_version").nullable();
        table.string("address").nullable();
        table.string("reason").nullable();
        table.string("detail").nullable();
        table.integer("attempts").notNullable().defaultTo(1);
        table.index([ "outcome", "id" ]);
    });
}

export async function down(knex : Knex) : Promise<void> {
    await knex.schema.alterTable("mcp_audit", (table) => {
        table.dropIndex([ "outcome", "id" ]);
        table.dropColumn("client_name");
        table.dropColumn("client_version");
        table.dropColumn("protocol_version");
        table.dropColumn("address");
        table.dropColumn("reason");
        table.dropColumn("detail");
        table.dropColumn("attempts");
    });
}
