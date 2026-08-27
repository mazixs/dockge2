import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DockgeServer } from "../../backend/dockge-server";
import { initAuth, getAuth, resetAuth } from "../../backend/auth";
import { Database } from "../../backend/database";
import { Settings } from "../../backend/settings";
import type { DockgeSocket } from "../../backend/util-server";

export interface DatabaseFixture {
    dataDir : string;
    stacksDir : string;
}

/** Password used by the accounts the tests create */
export const TEST_PASSWORD = "test-only-password-1234";

/**
 * Run a callback against a fresh database with authentication initialised.
 * Everything lives in a temporary directory that is removed afterwards.
 * @param callback Test body
 * @returns Whatever the callback returns
 */
export async function withDatabase<T>(callback: (fixture: DatabaseFixture) => Promise<T>, options: { ssl? : boolean } = {}): Promise<T> {
    Settings.stopCacheCleaner();
    Settings.cacheList = {};
    await Database.close();

    // A secret in the environment would skip the branch that generates and stores one
    const secretFromEnv = process.env.DOCKGE_AUTH_SECRET;
    delete process.env.DOCKGE_AUTH_SECRET;

    const dataDir = await mkdtemp(path.join(os.tmpdir(), "dockge-test-data-"));
    const stacksDir = path.join(dataDir, "stacks");
    await mkdir(stacksDir);

    const server = {
        config: {
            dataDir,
            stacksDir,
            port: 5001,
        },
        // Running behind TLS changes the cookie flags, so a test can ask for it
        isSSL: () => (options.ssl ? { key: "test" } : undefined),
        getBaseURL: () => (options.ssl ? "https://localhost:5001" : "http://localhost:5001"),
    } as unknown as DockgeServer;

    try {
        await Database.init(server);
        await initAuth(server);
        return await callback({ dataDir,
            stacksDir });
    } finally {
        Settings.stopCacheCleaner();
        Settings.cacheList = {};
        resetAuth();
        await Database.close();
        await rm(dataDir, { recursive: true,
            force: true });

        if (secretFromEnv !== undefined) {
            process.env.DOCKGE_AUTH_SECRET = secretFromEnv;
        }
    }
}

/**
 * Create the account of this Dockge instance and return its session cookie.
 * The account is created through better-auth, so the password is hashed the same way
 * the running application does it.
 * @param email Address of the account
 * @param password Password of the account
 * @returns Cookie header value carrying the session
 */
export async function createTestAccount(email = "owner@example.com", password = TEST_PASSWORD) : Promise<string> {
    const response = await getAuth().api.signUpEmail({
        body: {
            email,
            password,
            name: "Owner",
        },
        asResponse: true,
    });

    if (!response.ok) {
        throw new Error(`Could not create the test account: ${response.status} ${await response.text()}`);
    }

    const setCookie = response.headers.get("set-cookie");

    if (!setCookie) {
        throw new Error("The sign-up response carried no session cookie");
    }

    // Only the name=value part is needed as a request cookie
    return setCookie.split(";")[0] ?? "";
}

/**
 * A socket that looks like a signed in client to the server code
 * @param options Session cookie and endpoint of the fake client
 * @returns Fake socket
 */
export function makeAuthenticatedSocket(options : { cookie? : string, userID? : string, endpoint? : string, id? : string } = {}) : DockgeSocket {
    return {
        id: options.id ?? "test-socket",
        userID: options.userID ?? "test-user",
        endpoint: options.endpoint ?? "",
        connected: true,
        emitAgent: () => undefined,
        join: () => undefined,
        request: {
            headers: options.cookie ? { cookie: options.cookie } : {},
        },
    } as unknown as DockgeSocket;
}
