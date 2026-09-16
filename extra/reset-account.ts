import readline from "readline";
import { Database } from "../backend/database";
import { DockgeServer } from "../backend/dockge-server";
import { resetInstanceAccounts } from "../backend/auth-access";
import { log } from "../backend/log";

/**
 * Remove all accounts locally, so protected setup can issue a replacement owner.
 *
 * The command removes credentials, sessions and the one-use setup claim together.
 * Normal setup creates the next owner after restart. Stacks, settings and agents stay.
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
        console.log("This removes ALL user accounts and their sessions. Stacks, settings and agents stay.");
        console.log("Afterwards Dockge shows the setup screen again, so create the new account there.");

        if (!process.env.TEST_BACKEND) {
            const answer = await ask("Remove ALL user accounts? [y/N] ");

            if (answer.trim().toLowerCase() !== "y") {
                console.log("Nothing was changed.");
                return;
            }

            await resetInstanceAccounts();

            console.log("All accounts were removed. Restart Dockge, read the new bootstrap-token in its data directory, then open the UI.");
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
