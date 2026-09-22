import { log } from "./log";
import type { DockgeServer } from "./dockge-server";
import fs from "fs";
import path from "path";
import knex from "knex";
import type { Knex } from "knex";

interface DBConfig {
    type?: "sqlite" | "mysql";
    hostname?: string;
    port?: string;
    database?: string;
    username?: string;
    password?: string;
}

export class Database {
    /**
     * SQLite file path (Default: ./data/dockge.db)
     * @type {string}
     */
    static sqlitePath : string;

    static dbConfig: DBConfig = {};

    static knexMigrationsPath = "./backend/migrations";

    private static server : DockgeServer;

    private static knexInstance: Knex | undefined;

    static async init(server : DockgeServer) {
        this.server = server;

        log.debug("server", "Connecting to the database");
        await Database.connect();
        log.info("server", "Connected to the database");

        // Patch the database
        await Database.patch();
    }

    /**
     * Return the active Knex connection.
     * @throws {Error} If the database is not connected.
     */
    static getKnex() : Knex {
        if (!Database.knexInstance) {
            throw new Error("Database is not connected");
        }

        return Database.knexInstance;
    }

    /**
     * Read the database config
     * @throws {Error} If the config is invalid
     * @typedef {string|undefined} envString
     * @returns {{type: "sqlite"} | {type:envString, hostname:envString, port:envString, database:envString, username:envString, password:envString}} Database config
     */
    static readDBConfig() : DBConfig {
        const dbConfigString = fs.readFileSync(path.join(this.server.config.dataDir, "db-config.json")).toString("utf-8");
        const dbConfig = JSON.parse(dbConfigString);

        if (typeof dbConfig !== "object" || dbConfig === null) {
            throw new Error("Invalid db-config.json, it must be an object");
        }

        if (typeof dbConfig.type !== "string") {
            throw new Error("Invalid db-config.json, type must be a string");
        }
        return dbConfig;
    }

    /**
     * @typedef {string|undefined} envString
     * @param dbConfig the database configuration that should be written
     * @returns {void}
     */
    static writeDBConfig(dbConfig : DBConfig) {
        fs.writeFileSync(path.join(this.server.config.dataDir, "db-config.json"), JSON.stringify(dbConfig, null, 4));
    }

    /**
     * Connect to the database.
     * @param {boolean} _autoloadModels Kept for compatibility with the old database API.
     * @returns {Promise<void>}
     */
    static async connect(_autoloadModels = true) {
        let dbConfig : DBConfig;
        try {
            dbConfig = this.readDBConfig();
            Database.dbConfig = dbConfig;
        } catch (err) {
            if (err instanceof Error) {
                log.warn("db", err.message);
            }

            dbConfig = {
                type: "sqlite",
            };
            Database.dbConfig = dbConfig;
            this.writeDBConfig(dbConfig);
        }

        log.info("db", `Database Type: ${dbConfig.type}`);

        if (dbConfig.type !== "sqlite") {
            throw new Error("Unknown Database type: " + dbConfig.type);
        }

        this.sqlitePath = path.join(this.server.config.dataDir, "dockge.db");
        Database.knexInstance = knex({
            client: "better-sqlite3",
            connection: {
                filename: Database.sqlitePath,
            },
            useNullAsDefault: true,
            pool: {
                min: 1,
                max: 1,
            },
        });

        if (process.env.SQL_LOG === "1") {
            Database.knexInstance.on("query", (query) => {
                log.debug("db", query.sql);
            });
        }

        await this.initSQLite();
        this.restrictSQLiteAccess();
    }

    /**
     * Keep the database readable by its owner only.
     *
     * It holds the password hash and the secret that signs session cookies, so a
     * world readable file would let any local account forge a session or take the
     * hash offline. The write ahead log and shared memory file hold page data of
     * the same database, so they get the same treatment.
     * @returns {void}
     */
    static restrictSQLiteAccess() {
        // Windows has no POSIX mode bits, and chmod there only toggles the read only flag
        if (process.platform === "win32") {
            return;
        }

        for (const suffix of [ "", "-wal", "-shm" ]) {
            const file = `${Database.sqlitePath}${suffix}`;

            try {
                if (fs.existsSync(file)) {
                    fs.chmodSync(file, 0o600);
                }
            } catch (e) {
                // A read only mount or a foreign owner is not fatal, but has to be visible
                log.warn("db", `Could not restrict the permissions of ${file}: ${e instanceof Error ? e.message : e}`);
            }
        }
    }

    /**
     * Configure SQLite for safe concurrent access and predictable performance.
     * @returns {Promise<void>}
     */
    static async initSQLite() {
        const db = Database.getKnex();

        await db.raw("PRAGMA foreign_keys = ON");
        await db.raw("PRAGMA journal_mode = WAL");
        await db.raw("PRAGMA cache_size = -12000");
        await db.raw("PRAGMA auto_vacuum = INCREMENTAL");

        // This ensures that an operating system crash or power failure will not corrupt the database.
        // FULL synchronous is very safe, but it is also slower.
        // Read more: https://sqlite.org/pragma.html#pragma_synchronous
        await db.raw("PRAGMA synchronous = NORMAL");

        log.debug("db", "SQLite config:");
        log.debug("db", await db.raw("PRAGMA journal_mode"));
        log.debug("db", await db.raw("PRAGMA cache_size"));
        const versionResult = await db.raw("SELECT sqlite_version()");
        log.debug("db", "SQLite Version: " + versionResult[0]?.["sqlite_version()"]);
    }

    /**
     * Patch the database
     * @returns {Promise<void>}
     */
    static async patch() {
        // Using knex migrations
        // https://knexjs.org/guide/migrations.html
        // https://gist.github.com/NigelEarle/70db130cc040cc2868555b29a0278261
        try {
            await Database.getKnex().migrate.latest({
                directory: Database.knexMigrationsPath,
            });
        } catch (e) {
            log.error("db", "Database migration failed; restore a compatible snapshot before downgrading.");
            throw e;
        }
    }

    /**
     * Close the database connection.
     * @returns {Promise<void>}
     */
    static async close() {
        const db = Database.knexInstance;
        if (!db) {
            return;
        }

        log.info("db", "Closing the database");

        // Flush WAL to main database
        if (Database.dbConfig.type === "sqlite") {
            await db.raw("PRAGMA wal_checkpoint(TRUNCATE)");
        }

        await db.destroy();
        Database.knexInstance = undefined;
        log.info("db", "Database closed");
    }

    /**
     * Get the size of the database (SQLite only)
     * @returns {number} Size of database
     */
    static getSize() {
        if (Database.dbConfig.type === "sqlite") {
            log.debug("db", "Database.getSize()");
            const stats = fs.statSync(Database.sqlitePath);
            log.debug("db", stats);
            return stats.size;
        }
        return 0;
    }

    /**
     * Shrink the database
     * @returns {Promise<void>}
     */
    static async shrink() {
        if (Database.dbConfig.type === "sqlite") {
            await Database.getKnex().raw("VACUUM");
        }
    }
}
