import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DockgeServer } from "../../backend/dockge-server";
import { Database } from "../../backend/database";
import { Settings } from "../../backend/settings";

export interface DatabaseFixture {
    dataDir: string;
    stacksDir: string;
}

export async function withDatabase<T>(callback: (fixture: DatabaseFixture) => Promise<T>): Promise<T> {
    Settings.stopCacheCleaner();
    Settings.cacheList = {};
    await Database.close();

    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dockge-test-data-"));
    const stacksDir = path.join(dataDir, "stacks");
    await mkdir(stacksDir);

    const server = {
        config: {
            dataDir,
            stacksDir,
        },
    } as unknown as DockgeServer;

    try {
        await Database.init(server);
        return await callback({ dataDir,
            stacksDir });
    } finally {
        Settings.stopCacheCleaner();
        Settings.cacheList = {};
        await Database.close();
        await rm(dataDir, { recursive: true,
            force: true });
    }
}
