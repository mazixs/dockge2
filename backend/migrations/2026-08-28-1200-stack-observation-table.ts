import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // Status changes of stacks. Only changes are stored, not samples: a ten second
    // cron writing every tick would add millions of rows a month and say nothing more.
    await knex.schema.createTable("stack_observation", (table) => {
        table.increments("id");
        table.string("stack_name", 255).notNullable();
        // Empty string means the local host, an agent stack carries its endpoint
        table.string("endpoint", 255).notNullable().defaultTo("");
        table.integer("status").notNullable();
        // Milliseconds since the epoch, so the value needs no timezone
        table.bigInteger("observed_at").notNullable();
    });

    // The only query is "changes of this stack since a moment", in that order
    await knex.schema.alterTable("stack_observation", (table) => {
        table.index([ "stack_name", "endpoint", "observed_at" ], "stack_observation_lookup");
    });
}

export async function down(knex: Knex): Promise<void> {
    return knex.schema.dropTable("stack_observation");
}
