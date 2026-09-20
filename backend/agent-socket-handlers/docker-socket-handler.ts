import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, doubleCheckPassword, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { readAvailability } from "../observations";
import { readImageUpdates } from "../image-updates";
import { readStackSource } from "../stack-source";
import { hasBuildServices, readComposeImages } from "../../common/compose-status";
import { Terminal } from "../terminal";
import { getComposeTerminalName } from "../../common/util-common";
import { ContainerInstanceStatus } from "../../common/compose-status";
import type { StackFileBaseline, StackFileConfig } from "../../common/types/stack";
import { isSafeStackFileName } from "../../common/stack-files";
import { AgentSocket } from "../../common/agent-socket";
import type { AgentRequestContract, AgentRequestResult } from "../../common/agent-events";
import { runInBackground } from "../background";

/** A file hash as the write service produces it */
const FILE_HASH = /^[0-9a-f]{64}$/;

/**
 * Read the optional baseline of a save, whichever argument shape the caller used.
 *
 * The baseline arrived with a later generation of the agent protocol, so an older caller
 * simply passes its callback where the baseline now is. Saving without one is still
 * allowed: it is what an explicit "overwrite anyway" sends after a conflict was shown.
 * @param baselineOrCallback Fifth argument of the event
 * @returns The baseline to check against, or undefined when the caller sent none
 * @throws {ValidationError} If the baseline is not a pair of hashes
 */
function readSaveBaseline(baselineOrCallback : unknown) : StackFileBaseline | undefined {
    if (typeof baselineOrCallback === "function" || baselineOrCallback === undefined || baselineOrCallback === null) {
        return undefined;
    }

    if (typeof baselineOrCallback !== "object" || Array.isArray(baselineOrCallback)) {
        throw new ValidationError("Baseline must be an object");
    }

    const raw = baselineOrCallback as Record<string, unknown>;
    const baseline : StackFileBaseline = {};

    for (const key of [ "compose", "env" ] as const) {
        if (!(key in raw)) {
            continue;
        }
        const value = raw[key];
        if (value !== null && (typeof value !== "string" || !FILE_HASH.test(value))) {
            throw new ValidationError("Baseline must hold file hashes");
        }
        baseline[key] = value;
    }

    // The names travel with the hashes: a save is for the files the editor read, and an
    // unsafe name is refused here rather than being compared against a selection
    for (const key of [ "composeFileName", "envFileName" ] as const) {
        if (!(key in raw) || raw[key] === undefined) {
            continue;
        }
        const value = raw[key];
        if (typeof value !== "string" || !isSafeStackFileName(value)) {
            throw new ValidationError("Baseline must hold safe file names");
        }
        baseline[key] = value;
    }

    return baseline;
}

/** What a save answers, whichever of the two events it was */
type SaveAck = (response : AgentRequestResult<"saveStack">) => void;

/**
 * The acknowledgement of a save, whichever argument shape the caller used.
 *
 * Which argument holds it depends on the generation the caller speaks, so it is picked
 * out here and named as the acknowledgement of a save. That the caller really sent a
 * function is decided when it is answered, not here.
 * @param baselineOrCallback Fifth argument of the event
 * @param maybeCallback Sixth argument of the event, when there is one
 * @returns The acknowledgement to answer
 */
function readSaveCallback(baselineOrCallback : unknown, maybeCallback : unknown) : SaveAck {
    return (typeof baselineOrCallback === "function" ? baselineOrCallback : maybeCallback) as SaveAck;
}

/** Окна, которые предлагает интерфейс: сутки, неделя, месяц */
const AVAILABILITY_WINDOWS = [ 24, 168, 720 ];

export class DockerSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket<AgentRequestContract>) {
        // Do not call super.create()

        agentSocket.on("deployStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, baselineOrCallback : unknown, maybeCallback : unknown) => {
            const callback = readSaveCallback(baselineOrCallback, maybeCallback);
            try {
                checkLogin(socket);
                const { stack, fileHashes } = await this.saveStack(server, name, composeYAML, composeENV, isAdd, readSaveBaseline(baselineOrCallback));
                await stack.deploy(socket);
                runInBackground("stack list", () => server.sendStackList());
                callbackResult({
                    ok: true,
                    msg: "Deployed",
                    msgi18n: true,
                    fileHashes,
                }, callback);
                stack.joinCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, baselineOrCallback : unknown, maybeCallback : unknown) => {
            const callback = readSaveCallback(baselineOrCallback, maybeCallback);
            try {
                checkLogin(socket);
                const { fileHashes } = await this.saveStack(server, name, composeYAML, composeENV, isAdd, readSaveBaseline(baselineOrCallback));
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                    fileHashes,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("deleteStack", async (name : unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof(name) !== "string") {
                    throw new ValidationError("Name must be a string");
                }
                const stack = await Stack.getStack(server, name);

                try {
                    await stack.delete(socket);
                } catch (e) {
                    runInBackground("stack list", () => server.sendStackList());
                    throw e;
                }

                runInBackground("stack list", () => server.sendStackList());
                callbackResult({
                    ok: true,
                    msg: "Deleted",
                    msgi18n: true,
                }, callback);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("getStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (stack.isManagedByDockge) {
                    stack.joinCombinedTerminal(socket);
                }

                callbackResult({
                    ok: true,
                    stack: await stack.toJSON(socket.endpoint),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // requestStackList
        agentSocket.on("requestStackList", async (callback) => {
            try {
                checkLogin(socket);
                runInBackground("stack list", () => server.sendStackList());
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // startStack
        agentSocket.on("startStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.start(socket);
                callbackResult({
                    ok: true,
                    msg: "Started",
                    msgi18n: true,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());

                stack.joinCombinedTerminal(socket);

            } catch (e) {
                callbackError(e, callback);
            }
        });

        // stopStack
        agentSocket.on("stopStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.stop(socket);
                callbackResult({
                    ok: true,
                    msg: "Stopped",
                    msgi18n: true,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());

                stack.leaveCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // restartStack
        agentSocket.on("restartStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.restart(socket);
                callbackResult({
                    ok: true,
                    msg: "Restarted",
                    msgi18n: true,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // updateStack
        agentSocket.on("updateStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.update(socket);
                callbackResult({
                    ok: true,
                    msg: "Updated",
                    msgi18n: true,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // down stack
        agentSocket.on("downStack", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.down(socket);
                callbackResult({
                    ok: true,
                    msg: "Downed",
                    msgi18n: true,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Services status
        agentSocket.on("serviceStatusList", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                // Not skipFSOperations: the selected compose file is needed for `-f`
                const stack = await Stack.getStack(server, stackName);
                const detailed = await stack.getDetailedStatus();
                const serviceStatusList : Record<string, ContainerInstanceStatus[]> = {};

                for (const instance of detailed.instances) {
                    const list = serviceStatusList[instance.service] ?? [];
                    list.push(instance);
                    serviceStatusList[instance.service] = list;
                }

                callbackResult({
                    ok: true,
                    serviceStatusList,
                    stackStatus: detailed.status,
                    issues: detailed.issues,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // What an update would do: what the working copy says and what the registry serves.
        // Nothing is pulled and nothing is started here - this is the preview state.
        agentSocket.on("stackUpdatePreview", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                if (!stack.isManagedByDockge) {
                    throw new ValidationError("This stack is not managed by Dockge.");
                }

                // Images come from the file the server parsed itself, never from the client
                const images = readComposeImages(stack.composeYAML);

                callbackResult({
                    ok: true,
                    source: await readStackSource(stack.path),
                    images: await readImageUpdates(images),
                    // A built image has no registry to ask, and the preview would
                    // otherwise be an empty list with nothing said about it
                    builds: hasBuildServices(stack.composeYAML),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Stop a running compose command of this stack
        agentSocket.on("abortCompose", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                // The name is built by the shared helper, so only this stack's own
                // compose terminal can ever be ended here
                Stack.validateName(stackName);
                const terminal = Terminal.getTerminal(getComposeTerminalName(socket.endpoint, stackName));

                if (!terminal) {
                    throw new ValidationError("Nothing is running for this stack.");
                }

                await terminal.end();

                callbackResult({
                    ok: true,
                    msg: "composeAborted",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Availability of one stack over a chosen window
        agentSocket.on("stackAvailability", async (stackName : unknown, windowHours : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                // Only the windows the UI offers: an arbitrary number would let a client
                // ask for a scan of the whole history
                if (typeof(windowHours) !== "number" || !AVAILABILITY_WINDOWS.includes(windowHours)) {
                    throw new ValidationError("Unsupported availability window");
                }

                // The name is validated by the same path every stack call uses
                Stack.validateName(stackName);

                callbackResult({
                    ok: true,
                    availability: await readAvailability(stackName, socket.endpoint, windowHours * 3_600_000),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Which compose, env and secret files a stack uses
        agentSocket.on("getStackFiles", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const inventory = await stack.loadFileConfig();

                callbackResult({
                    ok: true,
                    inventory,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("setStackFiles", async (stackName : unknown, config : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                const stored = await stack.setFileConfig(parseStackFileConfig(config));

                callbackResult({
                    ok: true,
                    config: stored,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);

                runInBackground("stack list", () => server.sendStackList());
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveEnvFile", async (stackName : unknown, fileName : unknown, content : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof(fileName) !== "string") {
                    throw new ValidationError("File name must be a string");
                }
                if (typeof(content) !== "string") {
                    throw new ValidationError("Content must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.writeEnvFile(fileName, content);

                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Secret metadata is safe to list, the content never travels with it
        agentSocket.on("listSecrets", async (stackName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);

                callbackResult({
                    ok: true,
                    secretFiles: await stack.listSecretFiles(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Revealing, writing and deleting a secret is a separate authorised action
        agentSocket.on("revealSecret", async (stackName : unknown, fileName : unknown, currentPassword : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof(fileName) !== "string") {
                    throw new ValidationError("File name must be a string");
                }

                await doubleCheckPassword(socket, currentPassword);

                const stack = await Stack.getStack(server, stackName);

                callbackResult({
                    ok: true,
                    content: await stack.readSecretFile(fileName),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveSecret", async (stackName : unknown, fileName : unknown, content : unknown, currentPassword : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof(fileName) !== "string") {
                    throw new ValidationError("File name must be a string");
                }
                if (typeof(content) !== "string") {
                    throw new ValidationError("Content must be a string");
                }

                await doubleCheckPassword(socket, currentPassword);

                const stack = await Stack.getStack(server, stackName);
                await stack.writeSecretFile(fileName, content);

                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                    secretFiles: await stack.listSecretFiles(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("deleteSecret", async (stackName : unknown, fileName : unknown, currentPassword : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof(fileName) !== "string") {
                    throw new ValidationError("File name must be a string");
                }

                await doubleCheckPassword(socket, currentPassword);

                const stack = await Stack.getStack(server, stackName);
                await stack.deleteSecretFile(fileName);

                callbackResult({
                    ok: true,
                    msg: "Deleted",
                    msgi18n: true,
                    secretFiles: await stack.listSecretFiles(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Referencing a secret from the compose file, only on an explicit user action
        agentSocket.on("bindSecret", async (stackName : unknown, secretName : unknown, fileName : unknown, services : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof(secretName) !== "string") {
                    throw new ValidationError("Secret name must be a string");
                }
                if (typeof(fileName) !== "string") {
                    throw new ValidationError("File name must be a string");
                }
                if (!Array.isArray(services) || services.some((item) => typeof(item) !== "string")) {
                    throw new ValidationError("Services must be a string array");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.bindSecret(secretName, fileName, services as string[]);

                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                    secretFiles: await stack.listSecretFiles(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("unbindSecret", async (stackName : unknown, secretName : unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof(stackName) !== "string") {
                    throw new ValidationError("Stack name must be a string");
                }
                if (typeof(secretName) !== "string") {
                    throw new ValidationError("Secret name must be a string");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.unbindSecret(secretName);

                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                    secretFiles: await stack.listSecretFiles(),
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Docker stats
        agentSocket.on("dockerStats", async (callback) => {
            try {
                checkLogin(socket);

                const dockerStats = Object.fromEntries(await server.getDockerStats());
                callbackResult({
                    ok: true,
                    dockerStats,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Start a service
        agentSocket.on("startService", async (stackName: unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof (stackName) !== "string" || typeof (serviceName) !== "string") {
                    throw new ValidationError("Stack name and service name must be strings");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.startService(socket, serviceName);
                stack.joinCombinedTerminal(socket); // Ensure the combined terminal is joined
                callbackResult({
                    ok: true,
                    msg: {
                        key: "serviceStarted",
                        values: { service: serviceName },
                    },
                    msgi18n: true,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // Stop a service
        agentSocket.on("stopService", async (stackName: unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof (stackName) !== "string" || typeof (serviceName) !== "string") {
                    throw new ValidationError("Stack name and service name must be strings");
                }

                const stack = await Stack.getStack(server, stackName);
                await stack.stopService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: {
                        key: "serviceStopped",
                        values: { service: serviceName },
                    },
                    msgi18n: true,
                }, callback);
                runInBackground("stack list", () => server.sendStackList());
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("restartService", async (stackName: unknown, serviceName: unknown, callback) => {
            try {
                checkLogin(socket);

                if (typeof stackName !== "string" || typeof serviceName !== "string") {
                    throw new Error("Invalid stackName or serviceName");
                }

                const stack = await Stack.getStack(server, stackName, true);
                await stack.restartService(socket, serviceName);
                callbackResult({
                    ok: true,
                    msg: {
                        key: "serviceRestarted",
                        values: { service: serviceName },
                    },
                    msgi18n: true,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        // getExternalNetworkList
        agentSocket.on("getDockerNetworkList", async (callback) => {
            try {
                checkLogin(socket);
                const dockerNetworkList = await server.getDockerNetworkList();
                callbackResult({
                    ok: true,
                    dockerNetworkList,
                }, callback);
            } catch (e) {
                callbackError(e, callback);
            }
        });
    }

    async saveStack(server : DockgeServer, name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, baseline? : StackFileBaseline) : Promise<{ stack : Stack, fileHashes : StackFileBaseline }> {
        // Check types
        if (typeof(name) !== "string") {
            throw new ValidationError("Name must be a string");
        }
        if (typeof(composeYAML) !== "string") {
            throw new ValidationError("Compose YAML must be a string");
        }
        if (typeof(composeENV) !== "string") {
            throw new ValidationError("Compose ENV must be a string");
        }
        if (typeof(isAdd) !== "boolean") {
            throw new ValidationError("isAdd must be a boolean");
        }
        // Only a new directory is held to the length: an existing stack keeps whatever
        // name it was created with, or the panel would refuse to save a stack it shows
        if (isAdd) {
            Stack.validateNewName(name);
        }

        const stack = new Stack(server, name, composeYAML, composeENV, false);
        const fileHashes = await stack.save(isAdd, baseline);
        return { stack,
            fileHashes };
    }

}

/** A stack directory never holds more files than this, so anything above is refused */
const MAX_FILE_LIST_LENGTH = 64;

/**
 * Read the secret bindings of a file selection.
 * Only shapes and types are checked here; which file a name may point at is decided
 * by the stack directory, not by the browser.
 * @param raw Raw value from the socket
 * @returns Typed bindings, empty when the selection carries none
 * @throws {ValidationError} If the shape is wrong
 */
function parseSecretBindings(raw : unknown) : StackFileConfig["secretBindings"] {
    if (raw === undefined) {
        return [];
    }

    if (!Array.isArray(raw)) {
        throw new ValidationError("secretBindings must be an array");
    }

    if (raw.length > MAX_FILE_LIST_LENGTH) {
        throw new ValidationError("Too many secret bindings");
    }

    const bindings : StackFileConfig["secretBindings"] = [];

    for (const item of raw) {
        const binding = item as Record<string, unknown>;

        if (typeof binding?.name !== "string" || typeof binding?.fileName !== "string") {
            throw new ValidationError("A secret binding needs a name and a file name");
        }

        const services = binding.services;
        if (services !== undefined && (!Array.isArray(services) || services.some((service) => typeof service !== "string"))) {
            throw new ValidationError("Secret binding services must be a string array");
        }

        if (Array.isArray(services) && services.length > MAX_FILE_LIST_LENGTH) {
            throw new ValidationError("Too many services for one secret");
        }

        bindings.push({
            name: binding.name,
            fileName: binding.fileName,
            services: (services as string[] | undefined) ?? [],
        });
    }

    return bindings;
}

/**
 * Read a file selection coming from the browser.
 * Only shapes and types are checked here, the file names themselves are validated
 * against the stack directory by StackConfig.validate().
 * @param config Raw value from the socket
 * @returns Typed selection
 * @throws {ValidationError} If the shape is wrong
 */
function parseStackFileConfig(config : unknown) : StackFileConfig {
    if (!config || typeof config !== "object") {
        throw new ValidationError("File config must be an object");
    }

    const raw = config as Record<string, unknown>;

    if (typeof raw.composeFileName !== "string") {
        throw new ValidationError("composeFileName must be a string");
    }

    if (!Array.isArray(raw.envFileNames) || raw.envFileNames.some((item) => typeof item !== "string")) {
        throw new ValidationError("envFileNames must be a string array");
    }

    // A stack directory never holds this many files, and every entry costs filesystem calls
    if (raw.envFileNames.length > MAX_FILE_LIST_LENGTH) {
        throw new ValidationError("Too many env files");
    }

    if (raw.activeEnvFileName !== undefined && typeof raw.activeEnvFileName !== "string") {
        throw new ValidationError("activeEnvFileName must be a string");
    }

    return {
        composeFileName: raw.composeFileName,
        envFileNames: raw.envFileNames as string[],
        activeEnvFileName: (raw.activeEnvFileName as string | undefined) ?? "",
        secretBindings: parseSecretBindings(raw.secretBindings),
    };
}

