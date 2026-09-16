import { promises as fs } from "node:fs";
import path from "node:path";
import { AgentSocketHandler } from "../agent-socket-handler";
import type { DockgeServer } from "../dockge-server";
import { callbackError, callbackResult, checkLogin, type DockgeSocket } from "../util-server";
import { Stack } from "../stack";
import { StackConfig, emptyStackFileConfig } from "../stack-config";
import { StackGitError, StackGitWorkflow } from "../stack-git";
import { readStackSource } from "../stack-source";
import { spawn } from "../child-process";
import type { AgentSocket } from "../../common/agent-socket";
import type { GitApplyInput, GitCloneInput, GitSaveResult } from "../../common/stack-git";
import type { StackFileConfig } from "../../common/types/stack";

const workflows = new WeakMap<DockgeServer, StackGitWorkflow>();

/** Validate in isolation; Docker output can contain credentials, so never return it. */
async function validate(directory: string, config: StackFileConfig, stacksDir: string): Promise<void> {
    try {
        await StackConfig.validate(directory, config);
        const args = [ "compose", "--project-name", "dockge-git-validation", "-f", config.composeFileName ];
        const globalEnv = path.join(stacksDir, "global.env");
        try {
            const stat = await fs.lstat(globalEnv);
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new StackGitError("Общий env-файл должен быть обычным файлом.");
            }
            args.push("--env-file", globalEnv);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
        for (const env of config.envFileNames) {
            args.push("--env-file", env);
        }
        args.push("config", "--quiet");
        await spawn("docker", args, { cwd: directory,
            encoding: "utf-8",
            maxBuffer: 256 * 1024,
            timeoutMs: 60_000 });
    } catch {
        throw new StackGitError("Выбранный результат не прошел проверку Compose. Проверьте Compose и выбранные env-файлы.");
    }
}

export function getStackGitWorkflow(server: DockgeServer): StackGitWorkflow {
    let value = workflows.get(server);
    if (!value) {
        value = new StackGitWorkflow({ validate: (directory, config) => validate(directory, config, server.stacksDir) });
        workflows.set(server, value);
    }
    return value;
}

function safeError(error: unknown): Error {
    return error instanceof StackGitError ? error : new StackGitError("Операция не выполнена. Проверьте состояние файлов и повторите попытку.");
}

/** Report saving and deploying separately: a deployment failure does not undo saved files. */
async function result(server: DockgeServer, socket: DockgeSocket, name: string, deploy: boolean): Promise<GitSaveResult> {
    let deployed = false;
    let deploymentError: string | undefined;
    if (deploy) {
        try {
            const stack = await Stack.getStack(server, name);
            await stack.deploy(socket);
            deployed = true;
        } catch {
            deploymentError = "Файлы сохранены, но развертывание не завершено. Проверьте состояние стека.";
        }
    }
    server.sendStackList();
    return { stackName: name,
        saved: true,
        deployed,
        ...(deploymentError ? { deploymentError } : {}),
        source: await readStackSource(Stack.getSafePath(server, name)) };
}

/** Git events use the same agent routing and role gates as other stack mutations. */
export class GitSocketHandler extends AgentSocketHandler {
    create(socket: DockgeSocket, server: DockgeServer, agentSocket: AgentSocket): void {
        agentSocket.on("gitCloneStack", async (payload: unknown, callback) => {
            try {
                const input = payload as GitCloneInput;
                checkLogin(socket);
                if (!input || typeof input.name !== "string" || typeof input.deploy !== "boolean" || typeof input.composeFile !== "string" || (input.envFiles !== undefined && (!Array.isArray(input.envFiles) || !input.envFiles.every((name) => typeof name === "string")))) {
                    throw new StackGitError("Некорректные параметры создания стека.");
                }
                const dir = Stack.getSafePath(server, input.name);
                const config = emptyStackFileConfig();
                config.composeFileName = input.composeFile;
                config.envFileNames = input.envFiles ?? [];
                config.activeEnvFileName = config.envFileNames[0] ?? "";
                await getStackGitWorkflow(server).clone(dir, input, config);
                try {
                    await StackConfig.set(input.name, config);
                } catch {
                    const saved = await result(server, socket, input.name, false);
                    callbackResult({ ok: true,
                        ...saved,
                        deploymentError: "Репозиторий сохранен, но выбор файлов не записан. Выберите Compose и env-файлы в настройках стека перед запуском." }, callback);
                    return;
                }
                callbackResult({ ok: true,
                    ...await result(server, socket, input.name, input.deploy) }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
        // Список веток - отдельное действие по кнопке, а не побочный эффект набора
        // адреса: это сетевой запрос к чужому серверу, и делать его на каждое
        // нажатие клавиши нельзя
        agentSocket.on("gitListBranches", async (repository: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof repository !== "string" || !repository.trim()) {
                    throw new StackGitError("Укажите адрес репозитория.");
                }
                const branches = await getStackGitWorkflow(server).listBranches(repository.trim());
                callbackResult({ ok: true,
                    branches }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
        agentSocket.on("gitPreviewUpdate", async (stackName: unknown, callback) => {
            try {
                checkLogin(socket);
                if (typeof stackName !== "string") {
                    throw new StackGitError("Укажите имя стека.");
                }
                const dir = Stack.getSafePath(server, stackName);
                const { config } = await StackConfig.inventory(dir, stackName);
                const preview = await getStackGitWorkflow(server).preview(dir, config);
                callbackResult({ ok: true,
                    preview }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
        agentSocket.on("gitApplyUpdate", async (payload: unknown, callback) => {
            try {
                const input = payload as GitApplyInput;
                checkLogin(socket);
                if (!input || typeof input.stackName !== "string" || typeof input.previewId !== "string" || typeof input.deploy !== "boolean") {
                    throw new StackGitError("Некорректные параметры обновления стека.");
                }
                const dir = Stack.getSafePath(server, input.stackName);
                const { config } = await StackConfig.inventory(dir, input.stackName);
                await getStackGitWorkflow(server).apply(dir, input, config);
                callbackResult({ ok: true,
                    ...await result(server, socket, input.stackName, input.deploy) }, callback);
            } catch (error) {
                callbackError(safeError(error), callback);
            }
        });
    }
}
