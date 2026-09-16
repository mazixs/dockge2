import type { Knex } from "knex";

export async function up(knex : Knex) : Promise<void> {
    await knex.schema.alterTable("stack_observation", (table) => {
        table.bigInteger("observed_until").nullable();
    });
    // Old rows have no heartbeat evidence. Preserve their timestamps without
    // inventing continuous observation of the time between status changes.
    await knex("stack_observation").update({ observed_until: knex.ref("observed_at") });
    await knex.schema.createTable("container_observation", (table) => {
        table.increments("id");
        table.string("container_id", 64).notNullable();
        table.integer("status").notNullable();
        table.bigInteger("observed_at").notNullable();
        table.bigInteger("observed_until").notNullable();
        table.index([ "container_id", "observed_until" ]);
    });
    await knex.schema.createTable("stability_snapshot", (table) => {
        table.integer("id").primary();
        table.bigInteger("observed_at").notNullable();
        table.text("containers").notNullable();
    });
}

export async function down(knex : Knex) : Promise<void> {
    await knex.schema.dropTable("stability_snapshot");
    await knex.schema.dropTable("container_observation");
    await knex.schema.alterTable("stack_observation", (table) => {
        table.dropColumn("observed_until");
    });
}
