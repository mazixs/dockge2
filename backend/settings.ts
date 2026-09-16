import { Database } from "./database";
import { log } from "./log";
import { LooseObject } from "../common/util-common";

export class Settings {

    /**
     *  Example:
     *      {
     *         key1: {
     *             value: "value2",
     *             timestamp: 12345678
     *         },
     *         key2: {
     *             value: 2,
     *             timestamp: 12345678
     *         },
     *     }
     */
    static cacheList : LooseObject = {

    };

    static cacheCleaner : NodeJS.Timeout | undefined;

    /**
     * Retrieve value of setting based on key
     * @param key Key of setting to retrieve
     * @returns Value
     */
    static async get(key : string) {

        // Start cache clear if not started yet
        if (!Settings.cacheCleaner) {
            Settings.cacheCleaner = setInterval(() => {
                log.debug("settings", "Cache Cleaner is just started.");
                for (const cacheKey in Settings.cacheList) {
                    if (Date.now() - Settings.cacheList[cacheKey].timestamp > 60 * 1000) {
                        log.debug("settings", "Cache Cleaner deleted: " + cacheKey);
                        delete Settings.cacheList[cacheKey];
                    }
                }

            }, 60 * 1000);

            // The cache cleaner must never keep the process alive on its own
            Settings.cacheCleaner.unref?.();
        }

        // Query from cache
        if (key in Settings.cacheList) {
            const v = Settings.cacheList[key].value;
            log.debug("settings", `Get Setting (cache): ${key}`);
            return v;
        }

        const row = await Database.getKnex()("setting")
            .select("value")
            .where("key", key)
            .first();
        const value = row?.value;

        try {
            const v = JSON.parse(value);
            log.debug("settings", `Get Setting: ${key}`);

            Settings.cacheList[key] = {
                value: v,
                timestamp: Date.now()
            };

            return v;
        } catch {
            return value;
        }
    }

    /**
     * Sets the specified setting to specified value
     * @param key Key of setting to set
     * @param value Value to set to
     * @param {?string} type Type of setting
     * @returns {Promise<void>}
     */
    static async set(key : string, value : object | string | number | boolean, type : string | null = null) {
        const db = Database.getKnex();
        const setting = await db("setting").where("key", key).first();
        const data = {
            type,
            value: JSON.stringify(value),
        };

        if (setting) {
            await db("setting").where("id", setting.id).update(data);
        } else {
            await db("setting").insert({
                key,
                ...data,
            });
        }

        Settings.deleteCache([ key ]);
    }

    /**
     * Get settings based on type
     * @param type The type of setting
     * @returns Settings
     */
    static async getSettings(type : string) {
        const list = await Database.getKnex()("setting")
            .select("key", "value")
            .where("type", type);

        const result : LooseObject = {};

        for (const row of list) {
            try {
                result[row.key] = JSON.parse(row.value);
            } catch {
                result[row.key] = row.value;
            }
        }

        return result;
    }

    /**
     * Set settings based on type
     * @param type Type of settings to set
     * @param data Values of settings
     * @returns {Promise<void>}
     */
    static async setSettings(type : string, data : LooseObject) {
        const db = Database.getKnex();
        const keyList = Object.keys(data);
        const promiseList : Promise<unknown>[] = [];

        for (const key of keyList) {
            const setting = await db("setting").where("key", key).first();
            const value = JSON.stringify(data[key]);

            if (setting == null) {
                promiseList.push(db("setting").insert({
                    key,
                    type,
                    value,
                }));
            } else if (setting.type === type) {
                promiseList.push(db("setting").where("id", setting.id).update({ value }));
            }
        }

        await Promise.all(promiseList);

        Settings.deleteCache(keyList);
    }

    /**
     * Delete selected keys from settings cache
     * @param {string[]} keyList Keys to remove
     * @returns {void}
     */
    static deleteCache(keyList : string[]) {
        for (const key of keyList) {
            delete Settings.cacheList[key];
        }
    }

    /**
     * Stop the cache cleaner if running
     * @returns {void}
     */
    static stopCacheCleaner() {
        if (Settings.cacheCleaner) {
            clearInterval(Settings.cacheCleaner);
            Settings.cacheCleaner = undefined;
        }
    }
}
