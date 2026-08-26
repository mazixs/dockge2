import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";
import { DockerSocketHandler } from "../../backend/agent-socket-handlers/docker-socket-handler";
import type { DockgeServer } from "../../backend/dockge-server";
import { Stack } from "../../backend/stack";
import type { DockgeSocket } from "../../backend/util-server";
import { withDatabase } from "../helpers/database";

/** A compose file using everything a naive rebuild would destroy */
const trickySource = `# managed by hand, do not reformat
include:
  - compose.base.yaml

x-common: &common
  restart: unless-stopped

services:
  app:
    <<: *common
    image: nginx # keep this comment
    environment:
      ENABLED: yes
      DISABLED: no
    volumes: !reset []
    tmpfs:
      mode: 01777
    command: ["sh", "-c", "sleep 600"]
`;

/**
 * Call an agent socket event and wait for its callback
 * @param agentSocket Agent socket the handler is registered on
 * @param eventName Event to call
 * @param args Arguments without the callback
 * @returns Callback response
 */
function call(agentSocket : AgentSocket, eventName : string, ...args : unknown[]) : Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        agentSocket.call(eventName, ...args, (response : Record<string, unknown>) => resolve(response));
    });
}

test("reading a stack never rewrites its compose file", async () => {
    await withDatabase(async () => {
        const stacksDir = await mkdtemp(path.join(os.tmpdir(), "dockge-source-"));
        const stackDir = path.join(stacksDir, "tricky-stack");
        await mkdir(stackDir);
        await writeFile(path.join(stackDir, "compose.yaml"), trickySource);
        await writeFile(path.join(stackDir, ".env"), "STAGE=base\n");

        try {
            const server = { stacksDir } as never;
            const stack = await Stack.getStack(server, "tricky-stack");

            // Reading the stack, its status details and its files leaves the file alone
            await stack.toJSON("");
            await stack.loadFileConfig();
            await stack.listSecretFiles();

            assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), trickySource);
            assert.equal(stack.composeYAML, trickySource);
        } finally {
            await rm(stacksDir, { recursive: true,
                force: true });
        }
    });
});

test("saving a stack writes exactly the text it was given", async () => {
    await withDatabase(async ({ stacksDir }) => {
        const stackDir = path.join(stacksDir, "tricky-stack");
        await mkdir(stackDir);
        await writeFile(path.join(stackDir, "compose.yaml"), trickySource);

        const socket = { userID: 1,
            endpoint: "" } as DockgeSocket;
        const server = { stacksDir,
            sendStackList: () => undefined } as unknown as DockgeServer;
        const agentSocket = new AgentSocket();
        new DockerSocketHandler().create(socket, server, agentSocket);

        // A save without any edit round-trips the original bytes
        const saved = await call(agentSocket, "saveStack", "tricky-stack", trickySource, "", false);
        assert.equal(saved.ok, true);
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), trickySource);

        // An edit is written verbatim, the server does not reformat it
        const edited = trickySource.replace("image: nginx # keep this comment", "image: nginx:1.27 # keep this comment");
        const savedEdit = await call(agentSocket, "saveStack", "tricky-stack", edited, "", false);
        assert.equal(savedEdit.ok, true);
        assert.equal(await readFile(path.join(stackDir, "compose.yaml"), "utf8"), edited);
    });
});
