import { AgentSocketHandler } from "../agent-socket-handler";
import { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, DockgeSocket, doubleCheckPassword, ValidationError } from "../util-server";
import { Stack } from "../stack";
import { ContainerInstanceStatus } from "../../common/compose-status";
import type { StackFileConfig } from "../../common/types/stack";
import { AgentSocket } from "../../common/agent-socket";

export class DockerSocketHandler extends AgentSocketHandler {
    create(socket : DockgeSocket, server : DockgeServer, agentSocket : AgentSocket) {
        // Do not call super.create()

        agentSocket.on("deployStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                const stack = await this.saveStack(server, name, composeYAML, composeENV, isAdd);
                await stack.deploy(socket);
                server.sendStackList();
                callbackResult({
                    ok: true,
                    msg: "Deployed",
                    msgi18n: true,
                }, callback);
                stack.joinCombinedTerminal(socket);
            } catch (e) {
                callbackError(e, callback);
            }
        });

        agentSocket.on("saveStack", async (name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown, callback) => {
            try {
                checkLogin(socket);
                await this.saveStack(server, name, composeYAML, composeENV, isAdd);
                callbackResult({
                    ok: true,
                    msg: "Saved",
                    msgi18n: true,
                }, callback);
                server.sendStackList();
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
                    server.sendStackList();
                    throw e;
                }

                server.sendStackList();
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
                server.sendStackList();
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
                server.sendStackList();

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
                server.sendStackList();

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
                server.sendStackList();
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
                server.sendStackList();
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
                server.sendStackList();
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

                const stack = await Stack.getStack(server, stackName, true);
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

                server.sendStackList();
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
                server.sendStackList();
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
                    msg: "Service " + serviceName + " started"
                }, callback);
                server.sendStackList();
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
                    msg: "Service " + serviceName + " stopped"
                }, callback);
                server.sendStackList();
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
                    msg: "Service " + serviceName + " restarted"
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

    async saveStack(server : DockgeServer, name : unknown, composeYAML : unknown, composeENV : unknown, isAdd : unknown) : Promise<Stack> {
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

        const stack = new Stack(server, name, composeYAML, composeENV, false);
        await stack.save(isAdd);
        return stack;
    }

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

    if (raw.activeEnvFileName !== undefined && typeof raw.activeEnvFileName !== "string") {
        throw new ValidationError("activeEnvFileName must be a string");
    }

    const bindings = [];

    if (raw.secretBindings !== undefined) {
        if (!Array.isArray(raw.secretBindings)) {
            throw new ValidationError("secretBindings must be an array");
        }

        for (const item of raw.secretBindings) {
            const binding = item as Record<string, unknown>;

            if (typeof binding?.name !== "string" || typeof binding?.fileName !== "string") {
                throw new ValidationError("A secret binding needs a name and a file name");
            }

            const services = binding.services;
            if (services !== undefined && (!Array.isArray(services) || services.some((service) => typeof service !== "string"))) {
                throw new ValidationError("Secret binding services must be a string array");
            }

            bindings.push({
                name: binding.name,
                fileName: binding.fileName,
                services: (services as string[] | undefined) ?? [],
            });
        }
    }

    return {
        composeFileName: raw.composeFileName,
        envFileNames: raw.envFileNames as string[],
        activeEnvFileName: (raw.activeEnvFileName as string | undefined) ?? "",
        secretBindings: bindings,
    };
}

