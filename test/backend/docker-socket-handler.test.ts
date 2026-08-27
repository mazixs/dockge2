import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";
import { DockerSocketHandler } from "../../backend/agent-socket-handlers/docker-socket-handler";
import type { DockgeServer } from "../../backend/dockge-server";
import { createTestAccount, makeAuthenticatedSocket, TEST_PASSWORD, withDatabase } from "../helpers/database";

interface CallbackResponse {
    ok? : boolean;
    msg? : string;
    content? : string;
    inventory? : Record<string, unknown>;
    secretFiles? : Array<Record<string, unknown>>;
    config? : Record<string, unknown>;
    [key : string] : unknown;
}

const password = TEST_PASSWORD;

const composeYAML = `services:
  app:
    image: nginx # keep me
  db:
    image: mariadb
`;

/**
 * Call an agent socket event and wait for its callback
 * @param agentSocket Agent socket the handler is registered on
 * @param eventName Event to call
 * @param args Arguments without the callback
 * @returns Callback response
 */
function call(agentSocket : AgentSocket, eventName : string, ...args : unknown[]) : Promise<CallbackResponse> {
    return new Promise((resolve) => {
        agentSocket.call(eventName, ...args, (response : CallbackResponse) => resolve(response));
    });
}

test("stack file and secret events keep secret content behind a password", async () => {
    await withDatabase(async ({ stacksDir }) => {
        // A real account created through better-auth, so the password check is the real one
        const cookie = await createTestAccount("secret-admin@example.com");

        const stackDir = path.join(stacksDir, "secret-stack");
        await mkdir(stackDir);
        await writeFile(path.join(stackDir, "compose.yaml"), composeYAML);
        await writeFile(path.join(stackDir, "staging.yml"), composeYAML);
        await writeFile(path.join(stackDir, ".env"), "BASE=1\n");
        await writeFile(path.join(stackDir, ".env.dev"), "STAGE=dev\n");

        const socket = makeAuthenticatedSocket({ cookie });
        const server = { stacksDir,
            sendStackList: () => undefined } as unknown as DockgeServer;
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(socket, server, agentSocket);

        // The inventory lists what is on disk and asks for a compose decision
        const inventory = await call(agentSocket, "getStackFiles", "secret-stack");
        assert.equal(inventory.ok, true);
        assert.deepEqual(inventory.inventory?.composeFileNames, [ "compose.yaml", "staging.yml" ]);
        assert.equal(inventory.inventory?.needsComposeSelection, true);

        // Selecting files is a normal action
        const selected = await call(agentSocket, "setStackFiles", "secret-stack", {
            composeFileName: "staging.yml",
            envFileNames: [ ".env", ".env.dev" ],
            activeEnvFileName: ".env.dev",
            secretBindings: [],
        });
        assert.equal(selected.ok, true);
        assert.equal(selected.config?.composeFileName, "staging.yml");

        // A selection that points outside the directory is refused
        const escape = await call(agentSocket, "setStackFiles", "secret-stack", {
            composeFileName: "../compose.yaml",
            envFileNames: [],
            activeEnvFileName: "",
            secretBindings: [],
        });
        assert.equal(escape.ok, false);

        // Writing an env file writes exactly that file
        const savedEnv = await call(agentSocket, "saveEnvFile", "secret-stack", ".env.dev", "STAGE=dev2\n");
        assert.equal(savedEnv.ok, true);
        assert.equal(await readFile(path.join(stackDir, ".env.dev"), "utf8"), "STAGE=dev2\n");
        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "BASE=1\n");

        // Writing a secret needs the current password
        const refusedWrite = await call(agentSocket, "saveSecret", "secret-stack", ".secret.db", "db-password", "wrong-password");
        assert.equal(refusedWrite.ok, false);
        assert.match(String(refusedWrite.msg), /Incorrect current password/);

        const savedSecret = await call(agentSocket, "saveSecret", "secret-stack", ".secret.db", "db-password", password);
        assert.equal(savedSecret.ok, true);

        // Listing secrets returns metadata only
        const listed = await call(agentSocket, "listSecrets", "secret-stack");
        assert.equal(listed.ok, true);
        assert.equal(listed.secretFiles?.length, 1);
        assert.equal(JSON.stringify(listed).includes("db-password"), false);

        // Reading the content is refused without the password and works with it
        const refusedReveal = await call(agentSocket, "revealSecret", "secret-stack", ".secret.db", "wrong-password");
        assert.equal(refusedReveal.ok, false);
        assert.equal(refusedReveal.content, undefined);

        const revealed = await call(agentSocket, "revealSecret", "secret-stack", ".secret.db", password);
        assert.equal(revealed.ok, true);
        assert.equal(revealed.content, "db-password");

        // The stack response itself never carries the secret.
        // The `getStack` event is not used here on purpose: it attaches a live log terminal.

        // Binding is an explicit action and edits the selected compose file
        const bound = await call(agentSocket, "bindSecret", "secret-stack", "db_password", ".secret.db", [ "db" ]);
        assert.equal(bound.ok, true);

        const stagingYAML = await readFile(path.join(stackDir, "staging.yml"), "utf8");
        assert.match(stagingYAML, /db_password:\n {4}file: \.\/\.secret\.db/);
        assert.match(stagingYAML, /image: nginx # keep me/);

        // The other compose file of the directory is untouched
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), composeYAML);

        const unbound = await call(agentSocket, "unbindSecret", "secret-stack", "db_password");
        assert.equal(unbound.ok, true);
        assert.equal((await readFile(path.join(stackDir, "staging.yml"), "utf8")).includes("db_password"), false);

        // Deleting the secret needs the password too
        const refusedDelete = await call(agentSocket, "deleteSecret", "secret-stack", ".secret.db", "wrong-password");
        assert.equal(refusedDelete.ok, false);

        const deleted = await call(agentSocket, "deleteSecret", "secret-stack", ".secret.db", password);
        assert.equal(deleted.ok, true);
        assert.deepEqual(deleted.secretFiles, []);
    });
});

test("stack file events reject wrong types with a type error, not by accident", async () => {
    await withDatabase(async ({ stacksDir }) => {
        // A stack that exists, so a refusal can only come from the type checks themselves
        const stackDir = path.join(stacksDir, "typed-stack");
        await mkdir(stackDir);
        await writeFile(path.join(stackDir, "compose.yaml"), composeYAML);
        await writeFile(path.join(stackDir, ".env"), "BASE=1\n");

        const socket = makeAuthenticatedSocket();
        const server = { stacksDir,
            sendStackList: () => undefined } as unknown as DockgeServer;
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(socket, server, agentSocket);

        // A correct call on the same stack succeeds, which proves the refusals below come
        // from the arguments and not from a missing stack
        const healthy = await call(agentSocket, "getStackFiles", "typed-stack");
        assert.equal(healthy.ok, true);

        const cases : Array<[string, unknown[], RegExp]> = [
            [ "getStackFiles", [ 123 ], /must be a string/ ],
            [ "setStackFiles", [ "typed-stack", "not-an-object" ], /must be an object/ ],
            [ "setStackFiles", [ "typed-stack", { composeFileName: 1,
                envFileNames: [] }], /composeFileName must be a string/ ],
            [ "setStackFiles", [ "typed-stack", { composeFileName: "compose.yaml",
                envFileNames: "nope" }], /envFileNames must be a string array/ ],
            [ "setStackFiles", [ "typed-stack", { composeFileName: "compose.yaml",
                envFileNames: Array.from({ length: 100 }, () => ".env") }], /Too many env files/ ],
            [ "saveEnvFile", [ "typed-stack", ".env", 5 ], /Content must be a string/ ],
            [ "listSecrets", [ null ], /must be a string/ ],
            [ "bindSecret", [ "typed-stack", "name", ".secret", "not-an-array" ], /must be a string array/ ],
        ];

        for (const [ event, args, expected ] of cases) {
            const response = await call(agentSocket, event, ...args);
            assert.equal(response.ok, false, `${event} should refuse ${JSON.stringify(args)}`);
            assert.match(String(response.msg), expected, `${event} should say why it refused`);
        }

        // None of the refused calls touched the env file
        assert.equal(await readFile(path.join(stackDir, ".env"), "utf8"), "BASE=1\n");
    });
});
