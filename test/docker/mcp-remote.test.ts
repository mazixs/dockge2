import test from "node:test";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { DelegationConfig } from "../../backend/mcp-delegation";

const runFile = promisify(execFile);
const allowedName = `mcp-remote-allowed-${process.pid}`;
const hiddenName = `mcp-remote-private-${process.pid}`;
const enabled = process.env.DOCKGE_DOCKER_INTEGRATION === "1";
const password = "isolated-mcp-test-password-1234";

async function freePort() {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    await new Promise<void>(resolve => server.close(() => resolve()));
    return address.port;
}

interface Instance {
    url : string;
    cookie : string;
    config : DelegationConfig;
    configPath : string;
    stacksPath : string;
    process : ChildProcess;
}

async function startInstance(root : string, serverId : string) : Promise<Instance> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const data = path.join(root, serverId, "data");
    const stacks = path.join(root, serverId, "stacks");
    await mkdir(data, { recursive: true });
    for (const name of [ allowedName, hiddenName ]) {
        await mkdir(path.join(stacks, name), { recursive: true });
        await writeFile(path.join(stacks, name, "compose.yaml"), `services:\n  app:\n    image: bash:5.2\n    command: ["bash", "-c", "sleep 180"]\n    environment:\n      PRIVATE_FIXTURE: never-expose-${name}\n`);
    }
    const keys = generateKeyPairSync("ed25519");
    const config : DelegationConfig = { serverId,
        privateKey: keys.privateKey.export({ type: "pkcs8",
            format: "pem" }).toString(),
        peers: [] };
    const configPath = path.join(root, serverId, "peers.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const token = randomBytes(32).toString("hex");
    const child = spawn(process.execPath, [ "--import", "tsx", "backend/index.ts" ], {
        cwd: process.cwd(),
        env: { ...process.env,
            NODE_ENV: "production",
            DOCKGE_PORT: String(port),
            DOCKGE_HOSTNAME: "127.0.0.1",
            DOCKGE_PUBLIC_URL: url,
            DOCKGE_DATA_DIR: data,
            DOCKGE_STACKS_DIR: stacks,
            DOCKGE_BOOTSTRAP_TOKEN: token,
            DOCKGE_MCP_DELEGATION_CONFIG: configPath },
        stdio: "ignore",
    });
    try {
        let ready = false;
        for (let attempt = 0; attempt < 150; attempt++) {
            if (child.exitCode !== null) {
                throw new Error(`Isolated Dockge ${serverId} exited with code ${child.exitCode}`);
            }
            try {
                const response = await fetch(url + "/api/auth/bootstrap-status", { signal: AbortSignal.timeout(500) });
                await response.body?.cancel();
                ready = true;
                break;
            } catch {
                await delay(200);
            }
        }
        assert(ready, "isolated Dockge must listen before bootstrap");
        const bootstrap = await fetch(url + "/api/auth/bootstrap", { method: "POST",
            headers: { "content-type": "application/json",
                origin: url },
            body: JSON.stringify({ token,
                username: "mcp.owner",
                name: "Isolated owner",
                email: "mcp@example.com",
                password }) });
        assert.equal(bootstrap.status, 200, "isolated owner bootstrap");
        await bootstrap.body?.cancel();
        const signin = await fetch(url + "/api/auth/sign-in/email", { method: "POST",
            headers: { "content-type": "application/json",
                origin: url },
            body: JSON.stringify({ email: "mcp@example.com",
                password }) });
        assert.equal(signin.status, 200);
        const cookie = signin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
        await signin.body?.cancel();
        assert(cookie.includes("session_token"));
        return { url,
            stacksPath: stacks,
            cookie,
            config,
            configPath,
            process: child };
    } catch (error) {
        child.kill("SIGTERM");
        throw error;
    }
}

async function admin(instance : Instance, action? : string, data? : unknown) {
    const response = await fetch(instance.url + "/api/mcp" + (action ? "/" + action : ""), {
        method: action ? "POST" : "GET",
        headers: { origin: instance.url,
            cookie: instance.cookie,
            "content-type": "application/json" },
        ...(action ? { body: JSON.stringify({ password,
            data }) } : {}),
    });
    assert.equal(response.status, 200, `owner MCP ${action || "catalog"}`);
    return response.json();
}

test("two isolated Dockge processes enforce remote scopes, one-time operator effects and revocation", { skip: !enabled,
    timeout: 180_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dockge-mcp-remote-"));
    const instances : Instance[] = [];
    const clients : Client[] = [];
    let composeFile = "";
    try {
        const origin = await startInstance(root, "origin");
        instances.push(origin);
        const target = await startInstance(root, "target");
        instances.push(target);
        const sourceCatalog = await admin(origin);
        const targetCatalog = await admin(target);
        const allowed = targetCatalog.stacks.find((stack : { name : string }) => stack.name === allowedName);
        const hidden = targetCatalog.stacks.find((stack : { name : string }) => stack.name === hiddenName);
        assert(allowed && hidden);
        composeFile = path.join(target.stacksPath, allowedName, "compose.yaml");
        await runFile("docker", [ "compose", "-f", composeFile, "-p", allowedName, "up", "-d" ], { timeout: 120_000 });
        const inspectRuntime = async () => {
            const ids = await runFile("docker", [ "compose", "-f", composeFile, "-p", allowedName, "ps", "-q" ], { timeout: 10_000 });
            assert(ids.stdout.trim(), "unique test container must exist");
            const inspected = await runFile("docker", [ "inspect", "--format", "{{json .State}}", ids.stdout.trim() ], { timeout: 10_000 });
            return JSON.parse(inspected.stdout) as { Running: boolean; StartedAt: string };
        };

        const { createPublicKey } = await import("node:crypto");
        for (const [ index, instance ] of instances.entries()) {
            const other = instances[1 - index]!;
            instance.config.peers = [{ id: other.config.serverId,
                name: "Isolated peer",
                url: other.url,
                publicKey: createPublicKey(other.config.privateKey).export({ type: "spki",
                    format: "pem" }).toString(),
                allowedStackIds: [ allowed.id, hidden.id ],
                actions: [ "stacks_list", "containers_list", "container_status", "stability_get" ],
                role: "viewer",
                ownerId: (index ? targetCatalog : sourceCatalog).users[0].id }];
            await writeFile(instance.configPath, JSON.stringify(instance.config), { mode: 0o600 });
            await admin(instance, "config", { enabled: true,
                url: instance.url + "/mcp" });
        }
        const issued = await admin(origin, "issue", { name: "Remote observer",
            userId: sourceCatalog.users[0].id,
            role: "viewer",
            servers: [ "target" ],
            stacks: [ allowed.id ],
            resources: { target: [ allowed.id ] },
            days: 1 });
        const client = new Client({ name: "real-remote-test",
            version: "1.0.0" });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(origin.url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + issued.secret } } }) as Transport);
        const listed = await client.callTool({ name: "stacks_list",
            arguments: { server_id: "target" } });
        assert.notEqual(listed.isError, true);
        const serialized = JSON.stringify(listed);
        assert(serialized.includes(allowed.id));
        assert(!serialized.includes(hidden.id));
        assert(!serialized.includes("never-expose"));
        const containers = await client.callTool({ name: "containers_list",
            arguments: { server_id: "target",
                stack_id: allowed.id } });
        assert.notEqual(containers.isError, true);
        assert(!JSON.stringify(containers).includes("never-expose"));
        for (const [ name, args ] of [[ "containers_list", { server_id: "target",
            stack_id: hidden.id }], [ "containers_list", { server_id: "local",
            stack_id: allowed.id }], [ "stack_stop", { server_id: "target",
            stack_id: allowed.id }], [ "stack_files_read", { server_id: "target",
            stack_id: allowed.id,
            path: "compose.yaml" }]] as const) {
            const denied = await client.callTool({ name,
                arguments: args });
            assert.equal(denied.isError, true);
            assert(!JSON.stringify(denied).includes("never-expose"));
        }
        assert.equal((await inspectRuntime()).Running, true, "viewer writes must not stop the unique container");
        for (const instance of instances) {
            instance.config.peers[0]!.role = "operator";
            instance.config.peers[0]!.actions.push("operation_prepare", "operation_apply", "operation_status", "stack_restart");
            await writeFile(instance.configPath, JSON.stringify(instance.config), { mode: 0o600 });
        }
        const operator = await admin(origin, "issue", { name: "Remote operator",
            userId: sourceCatalog.users[0].id,
            role: "operator",
            actions: [ "stacks:control" ],
            mode: "automatic",
            servers: [ "target" ],
            stacks: [ allowed.id ],
            resources: { target: [ allowed.id ] },
            days: 1 });
        const operatorClient = new Client({ name: "remote-operator-test",
            version: "1.0.0" });
        clients.push(operatorClient);
        await operatorClient.connect(new StreamableHTTPClientTransport(new URL(origin.url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + operator.secret } } }) as Transport);
        const decode = (result : Awaited<ReturnType<Client["callTool"]>>) => {
            assert.notEqual(result.isError, true, "permitted remote operation succeeds");
            const content = result.content as Array<{ type: string; text?: string }>;
            return JSON.parse(content[0]!.text!) as { operation_id: string; parameters_hash: string; state: string; server_id: string };
        };
        const prepareArgs = { server_id: "target",
            action: "stack_restart",
            request_id: "restart-once",
            parameters: { server_id: "target",
                stack_id: allowed.id } };
        assert.equal((await client.callTool({ name: "operation_prepare",
            arguments: prepareArgs })).isError, true);
        const prepared = decode(await operatorClient.callTool({ name: "operation_prepare",
            arguments: prepareArgs }));
        assert.equal(prepared.server_id, "target");
        assert.equal(decode(await operatorClient.callTool({ name: "operation_prepare",
            arguments: prepareArgs })).operation_id, prepared.operation_id);
        const before = await inspectRuntime();
        const applyArgs = { server_id: "target",
            operation_id: prepared.operation_id,
            parameters_hash: prepared.parameters_hash };
        const applied = decode(await operatorClient.callTool({ name: "operation_apply",
            arguments: applyArgs }));
        assert.equal(applied.state, "succeeded");
        const after = await inspectRuntime();
        assert(after.Running);
        assert.notEqual(after.StartedAt, before.StartedAt);
        assert.equal(decode(await operatorClient.callTool({ name: "operation_apply",
            arguments: applyArgs })).state, "succeeded");
        assert.equal((await inspectRuntime()).StartedAt, after.StartedAt, "retry must not restart the container twice");
        assert.equal((await operatorClient.callTool({ name: "operation_apply",
            arguments: { ...applyArgs,
                parameters_hash: "0".repeat(64) } })).isError, true);
        const approvalKey = await admin(origin, "issue", { name: "Remote approval",
            userId: sourceCatalog.users[0].id,
            role: "operator",
            actions: [ "stacks:control" ],
            mode: "approval",
            servers: [ "target" ],
            stacks: [ allowed.id ],
            resources: { target: [ allowed.id ] },
            days: 1 });
        const approvalClient = new Client({ name: "remote-approval-test",
            version: "1.0.0" });
        clients.push(approvalClient);
        await approvalClient.connect(new StreamableHTTPClientTransport(new URL(origin.url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + approvalKey.secret } } }) as Transport);
        const needsApproval = decode(await approvalClient.callTool({ name: "operation_prepare",
            arguments: { ...prepareArgs,
                request_id: "approval-restart" } }));
        assert.equal(needsApproval.state, "awaiting_approval");
        const approvalArgs = { server_id: "target",
            operation_id: needsApproval.operation_id,
            parameters_hash: needsApproval.parameters_hash };
        assert.equal((await approvalClient.callTool({ name: "operation_apply",
            arguments: approvalArgs })).isError, true);
        assert.equal((await operatorClient.callTool({ name: "operation_apply",
            arguments: approvalArgs })).isError, true, "another key cannot apply the operation");
        assert.equal((await inspectRuntime()).StartedAt, after.StartedAt, "unapproved request has no Docker effect");
        await admin(target, "approve", { id: needsApproval.operation_id });
        assert.equal(decode(await approvalClient.callTool({ name: "operation_apply",
            arguments: approvalArgs })).state, "succeeded");
        const approvedRuntime = await inspectRuntime();
        assert.notEqual(approvedRuntime.StartedAt, after.StartedAt);
        assert.equal(decode(await approvalClient.callTool({ name: "operation_apply",
            arguments: approvalArgs })).state, "succeeded");
        assert.equal((await inspectRuntime()).StartedAt, approvedRuntime.StartedAt, "approved request is still idempotent");
        target.config.peers[0]!.actions = target.config.peers[0]!.actions.filter(action => action !== "stack_restart");
        await writeFile(target.configPath, JSON.stringify(target.config), { mode: 0o600 });
        assert.equal((await operatorClient.callTool({ name: "operation_status",
            arguments: { server_id: "target",
                operation_id: prepared.operation_id } })).isError, true, "revoked concrete action cannot be accessed through operation_status");
        // Receiver trust withdrawal denies an otherwise valid source key immediately.
        target.config.peers[0]!.allowedStackIds = [ hidden.id ];
        await writeFile(target.configPath, JSON.stringify(target.config), { mode: 0o600 });
        assert.equal((await client.callTool({ name: "stacks_list",
            arguments: { server_id: "target" } })).isError, true);
        target.config.peers[0]!.allowedStackIds = [ allowed.id, hidden.id ];
        await writeFile(target.configPath, JSON.stringify(target.config), { mode: 0o600 });
        await admin(origin, "revoke", { id: issued.id });
        await assert.rejects(client.callTool({ name: "stacks_list",
            arguments: { server_id: "target" } }));
    } finally {
        await Promise.all(clients.map(client => client.close().catch(() => {})));
        await Promise.all(instances.map(instance => new Promise<void>(resolve => {
            if (instance.process.exitCode !== null) {
                resolve();
                return;
            }
            instance.process.once("exit", () => resolve());
            instance.process.kill("SIGTERM");
            const timer = setTimeout(() => instance.process.kill("SIGKILL"), 5000);
            timer.unref();
        })));
        if (composeFile) {
            await runFile("docker", [ "compose", "-f", composeFile, "-p", allowedName, "down", "--remove-orphans" ], { timeout: 30_000 });
        }
        await rm(root, { recursive: true,
            force: true });
    }
});

test("M6 SDK clones HTTP Git, previews real changes and applies exact edited bytes without deployment", { skip: !enabled,
    timeout: 120_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dockge-mcp-git-"));
    const repository = path.join(root, "source");
    const bare = path.join(root, "served", "fixture.git");
    let instance : Instance | undefined;
    let http : import("node:http").Server | undefined;
    let client : Client | undefined;
    try {
        const { default: express } = await import("express");
        const { readFile } = await import("node:fs/promises");
        await mkdir(repository, { recursive: true });
        const original = "# keep original header\nservices:\n  app:\n    image: 'bash:5.2' # pinned\n    command: [\"bash\", \"-c\", \"sleep 180\"]\n";
        await writeFile(path.join(repository, "compose.yaml"), original);
        const git = async (...args : string[]) => runFile("git", args, { cwd: repository,
            timeout: 15_000 });
        await git("init", "-b", "main");
        await git("add", "compose.yaml");
        await git("-c", "user.name=MCP fixture", "-c", "user.email=mcp@example.invalid", "commit", "-m", "Initial fixture");
        await mkdir(path.dirname(bare));
        await git("clone", "--bare", repository, bare);
        await git("--git-dir", bare, "update-server-info");
        const app = express();
        app.use(express.static(path.dirname(bare), { dotfiles: "deny" }));
        http = app.listen(0, "127.0.0.1");
        await new Promise<void>(resolve => http!.once("listening", resolve));
        const address = http.address();
        assert(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}/fixture.git`;
        instance = await startInstance(root, "git-server");
        await admin(instance, "config", { enabled: true,
            url: instance.url + "/mcp" });
        const catalog = await admin(instance);
        const reservation = await admin(instance, "reserve", { name: `mcp-git-${process.pid}` });
        const key = await admin(instance, "issue", { name: "Git fixture operator",
            userId: catalog.users[0].id,
            role: "operator",
            actions: [ "deploy", "git:read", "git:apply", "files:read" ],
            mode: "automatic",
            servers: [ "local" ],
            stacks: [ reservation.id ],
            resources: { local: [ reservation.id ] },
            days: 1 });
        client = new Client({ name: "real-git-test",
            version: "1.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(instance.url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + key.secret } } }) as Transport);
        const call = async (name : string, args : Record<string, unknown>) => {
            const response = await client!.callTool({ name,
                arguments: args });
            assert.notEqual(response.isError, true, `${name} should succeed`);
            const content = response.content as Array<{ type: string; text?: string }>;
            return JSON.parse(content[0]!.text!);
        };
        let requestNumber = 0;
        const prepare = (action : string, parameters : Record<string, unknown>) => call("operation_prepare", { action,
            request_id: `git-${++requestNumber}`,
            parameters: { server_id: "local",
                stack_id: reservation.id,
                ...parameters } });
        const apply = (operation : { operation_id: string; parameters_hash: string }) => call("operation_apply", { operation_id: operation.operation_id,
            parameters_hash: operation.parameters_hash });
        const clone = await prepare("git_clone", { repository: url,
            branch: "main",
            compose_file: "compose.yaml",
            env_files: [],
            deploy: false });
        const cloned = await apply(clone);
        assert.equal(cloned.state, "succeeded");
        assert.deepEqual(cloned.result, { saved: true,
            deployed: false });
        const destination = path.join(instance.stacksPath, reservation.name, "compose.yaml");
        assert.equal(await readFile(destination, "utf8"), original);
        const upstream = original.replace("# pinned", "# upstream comment");
        await writeFile(path.join(repository, "compose.yaml"), upstream);
        await git("add", "compose.yaml");
        await git("-c", "user.name=MCP fixture", "-c", "user.email=mcp@example.invalid", "commit", "-m", "Upstream fixture change");
        await git("push", bare, "main");
        await git("--git-dir", bare, "update-server-info");
        const local = original + "# keep local footer\n";
        await writeFile(destination, local);
        const previewOperation = await apply(await prepare("git_preview", {}));
        assert.equal(previewOperation.state, "succeeded");
        const preview = await call("git_preview_result", { server_id: "local",
            stack_id: reservation.id,
            preview_id: previewOperation.result.preview_id });
        assert.notEqual(preview.currentCommit, preview.targetCommit);
        const compose = preview.files.find((file : {path: string}) => file.path === "compose.yaml");
        assert.equal(compose.serverText, local);
        assert.equal(compose.gitText, upstream);
        const edited = upstream + "# keep local footer\n";
        const preparedApply = await prepare("git_apply", { preview_id: preview.id,
            choices: { "compose.yaml": "edited" },
            edited_contents: { "compose.yaml": edited },
            deploy: false });
        assert.equal(await readFile(destination, "utf8"), local, "preparation must not write selected bytes");
        const saved = await apply(preparedApply);
        assert.equal(saved.state, "succeeded");
        assert.deepEqual(saved.result, { saved: true,
            deployed: false });
        assert.equal(await readFile(destination, "utf8"), edited);
        const read = await call("stack_files_read", { server_id: "local",
            stack_id: reservation.id,
            file_name: "compose.yaml" });
        assert.equal(read.content, edited);
        assert.equal((await apply(preparedApply)).state, "succeeded");
        assert.equal(await readFile(destination, "utf8"), edited, "idempotent apply preserves exact selected text");
        const running = await runFile("docker", [ "ps", "-aq", "--filter", `label=com.docker.compose.project=${reservation.name}` ], { timeout: 10_000 });
        assert.equal(running.stdout.trim(), "", "deploy=false must never create a container");
    } finally {
        await client?.close().catch(() => {});
        if (instance && instance.process.exitCode === null) {
            const child = instance.process;
            await new Promise<void>(resolve => {
                child.once("exit", () => resolve());
                child.kill("SIGTERM");
                const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
                timer.unref();
            });
        }
        if (http) {
            http.closeAllConnections();
            await new Promise<void>(resolve => http!.close(() => resolve()));
        }
        await rm(root, { recursive: true,
            force: true });
    }
});
