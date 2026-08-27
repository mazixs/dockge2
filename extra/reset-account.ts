import readline from "readline";
import { Database } from "../backend/database";
import { DockgeServer } from "../backend/dockge-server";
import { log } from "../backend/log";

/**
 * Remove the account of this Dockge instance, so the setup screen can create a new one.
 *
 * Passwords are hashed and managed by the auth library, and this tool deliberately does
 * not touch hashes or sessions: it deletes the account rows and lets the normal setup
 * flow create the next owner. Stacks, settings and agents are left alone.
 */
console.log("== Dockge Reset Account Tool ==");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const server = new DockgeServer();

/**
 * Ask a question on the terminal
 * @param question Text to show
 * @returns Answer of the user
 */
function ask(question : string) : Promise<string> {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer));
    });
}

export const main = async () => {
    console.log("Connecting the database");

    try {
        await Database.init(server);
    } catch (e) {
        if (e instanceof Error) {
            log.error("server", "Failed to connect to your database: " + e.message);
        }
        process.exit(1);
    }

    try {
        const knex = Database.getKnex();
        const users = await knex("user").select("id", "email");

        if (users.length === 0) {
            console.log("There is no account yet. Open Dockge and create one.");
            return;
        }

        console.log("Account: " + users.map((user) => user.email).join(", "));
        console.log("");
        console.log("This removes the account and all its sessions. Stacks, settings and agents stay.");
        console.log("Afterwards Dockge shows the setup screen again, so create the new account there.");

        if (!process.env.TEST_BACKEND) {
            const answer = await ask("Remove the account? [y/N] ");

            if (answer.trim().toLowerCase() !== "y") {
                console.log("Nothing was changed.");
                return;
            }

            // One transaction, because a half removed account is worse than none:
            // a user row without its credentials cannot sign in and cannot be replaced,
            // since the setup screen only appears while there is no account at all
            await knex.transaction(async (trx) => {
                // Order matters: rows that reference the user go first
                await trx("session").del();
                await trx("account").del();

                if (await trx.schema.hasTable("twoFactor")) {
                    await trx("twoFactor").del();
                }

                await trx("user").del();
            });

            console.log("The account was removed. Restart Dockge if it is running, then open the UI.");
        }
    } catch (e) {
        if (e instanceof Error) {
            log.error("server", e.message);
        }
    } finally {
        rl.close();
        await Database.close();
    }
};

if (!process.env.TEST_BACKEND) {
    await main();
}
