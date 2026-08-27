import { defineConfig, devices } from "@playwright/test";

/**
 * End to end tests run against the real backend, the real frontend and a real Chromium.
 * Nothing is stubbed: the clipboard, xterm, Socket.IO and Docker are the real ones,
 * because these tests exist to catch exactly the problems a stub would hide.
 */
const dataDir = process.env.DOCKGE_E2E_DATA_DIR ?? "/tmp/dockge-e2e/data";
const stacksDir = process.env.DOCKGE_E2E_STACKS_DIR ?? "/tmp/dockge-e2e/stacks";

export default defineConfig({
    testDir: "./test/e2e",
    globalSetup: "./test/e2e/global-setup.ts",
    globalTeardown: "./test/e2e/global-teardown.ts",
    timeout: 60_000,
    expect: {
        timeout: 15_000,
    },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: process.env.CI ? [[ "list" ], [ "github" ]] : [[ "list" ]],
    use: {
        baseURL: "http://localhost:5000",
        // Signed in by the global setup: the session is a cookie, so the state carries it
        storageState: "test/e2e/.auth/state.json",
        trace: "retain-on-failure",
        permissions: [ "clipboard-read", "clipboard-write" ],
        ...devices["Desktop Chrome"],
    },
    projects: [
        {
            name: "chromium",
            use: {
                ...devices["Desktop Chrome"],
                channel: "chromium",
            },
        },
    ],
    webServer: [
        {
            // The seed runs first, so the backend starts with the owner account in place
            command: "cross-env NODE_ENV=development tsx ./test/e2e/seed.ts && cross-env NODE_ENV=development tsx ./backend/index.ts",
            url: "http://localhost:5001",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
            env: {
                DOCKGE_DATA_DIR: dataDir,
                DOCKGE_STACKS_DIR: stacksDir,
                DOCKGE_PORT: "5001",
            },
        },
        {
            command: "cross-env NODE_ENV=development vite --config ./frontend/vite.config.ts",
            url: "http://localhost:5000",
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
        },
    ],
});
