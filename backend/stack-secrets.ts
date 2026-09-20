import { promises as fsAsync } from "fs";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import { log } from "./log";
import { resolveStackFilePath, StackConfig } from "./stack-config";
import { hashStackFileContent, writeStackFiles } from "./stack-write";
import { ValidationError } from "./util-server";
import { serialiseEditedDocument } from "../common/compose-editor";
import { readComposeServices } from "../common/compose-status";
import { classifyStackFile, isSafeNameSegment } from "../common/stack-files";
import type { StackFileConfig } from "../common/types/stack";

/**
 * The stack as the secret operations see it.
 *
 * Secrets own their own files and the compose lines that reference them, so they need
 * a stack to write into rather than the whole stack object. The compose text and the
 * configuration are read through calls, not copied in: a binding change rewrites both,
 * and the next read has to see what was written.
 */
export interface SecretHost {
    /** Name of the stack, the key its configuration is stored under */
    readonly name : string;
    /** Directory of the stack */
    readonly path : string;
    /** Directory the write journal lives in */
    readonly journalRoot : string;
    /** Compose file the bindings are written into */
    readonly composeFileName : string;
    /** Current compose text, read only when a binding actually changes */
    composeText() : string;
    /** Current file configuration, including the bindings */
    fileConfig() : StackFileConfig;
    /** Take over compose text a binding change has written */
    rememberCompose(content : string) : void;
    /** Take over a configuration a binding change has written */
    rememberConfig(config : StackFileConfig) : void;
}

/**
 * Refuse anything that is not a secret file of this stack
 * @param fileName Name coming from the caller
 * @throws {ValidationError} If the name is not a secret file
 */
function assertSecretFile(fileName : string) : void {
    if (classifyStackFile(fileName) !== "secret") {
        throw new ValidationError("Not a secret file: " + fileName);
    }
}

/**
 * Serialise a compose document after an explicit structural edit.
 * `flowCollectionPadding` is disabled so untouched inline arrays such as
 * `["sh", "-c", "..."]` keep the spacing Compose files normally use.
 * @param host The stack being edited
 * @param doc Parsed compose document
 * @returns YAML text
 */
function serialise(host : SecretHost, doc : Document) : string {
    return serialiseEditedDocument(host.composeText(), doc);
}

/**
 * Write an edited compose file and the bindings that go with it.
 * The compose file keeps its own bytes unless the edit changed something, and the
 * expected hash makes a concurrent write fail instead of overwriting it.
 * @param host The stack being edited
 * @param composeYAML New compose text, or nothing when the document did not change
 * @param bindings Bindings to store
 */
async function commit(host : SecretHost, composeYAML : string | null, bindings : StackFileConfig["secretBindings"]) : Promise<void> {
    if (composeYAML !== null) {
        await writeStackFiles(host.path, [{ name: host.composeFileName,
            content: composeYAML,
            expectedHash: hashStackFileContent(host.composeText()) }], { journalRoot: host.journalRoot });
        host.rememberCompose(composeYAML);
    }

    const config = {
        ...host.fileConfig(),
        secretBindings: bindings,
    };
    await StackConfig.set(host.name, config);
    host.rememberConfig(config);
}

/**
 * Read the content of a secret file.
 * The caller has to authorise this separately, it is not part of the stack response.
 * @param host The stack the file belongs to
 * @param fileName Secret file inside the stack directory
 * @returns File content
 */
export async function readSecretFile(host : SecretHost, fileName : string) : Promise<string> {
    assertSecretFile(fileName);

    const filePath = await resolveStackFilePath(host.path, fileName);

    try {
        return await fsAsync.readFile(filePath, "utf-8");
    } catch (e) {
        throw new ValidationError("Secret file not found: " + fileName);
    }
}

/**
 * Create or replace a secret file with restrictive permissions
 * @param host The stack the file belongs to
 * @param fileName Secret file inside the stack directory
 * @param content New content
 */
export async function writeSecretFile(host : SecretHost, fileName : string, content : string) : Promise<void> {
    assertSecretFile(fileName);

    const filePath = await resolveStackFilePath(host.path, fileName);

    // mode is applied on creation, chmod covers an existing file
    await writeStackFiles(host.path, [{ name: fileName,
        content,
        mode: 0o600 }], { journalRoot: host.journalRoot });

    if (process.platform === "win32") {
        log.warn("writeSecretFile", "File permissions cannot be restricted on Windows, the file inherits the directory ACL");
        return;
    }

    await fsAsync.chmod(filePath, 0o600);

    if (process.env.PUID && process.env.PGID) {
        const uid = Number(process.env.PUID);
        const gid = Number(process.env.PGID);
        if (Number.isInteger(uid) && Number.isInteger(gid)) {
            await fsAsync.chown(filePath, uid, gid);
        }
    }
}

/**
 * Delete a secret file and its binding
 * @param host The stack the file belongs to
 * @param fileName Secret file inside the stack directory
 */
export async function deleteSecretFile(host : SecretHost, fileName : string) : Promise<void> {
    assertSecretFile(fileName);

    const filePath = await resolveStackFilePath(host.path, fileName);
    await fsAsync.rm(filePath, { force: true });

    const binding = host.fileConfig().secretBindings.find((item) => item.fileName === fileName);
    if (binding) {
        await unbindSecret(host, binding.name);
    }
}

/**
 * Reference a secret file from the compose file, only on an explicit user action.
 * The compose document is edited in place, so comments and formatting survive.
 * @param host The stack the file belongs to
 * @param secretName Compose secret name
 * @param fileName Secret file inside the stack directory
 * @param services Services that get access to the secret
 */
export async function bindSecret(host : SecretHost, secretName : string, fileName : string, services : readonly string[]) : Promise<void> {
    if (!isSafeNameSegment(secretName)) {
        throw new ValidationError("Invalid secret name: " + secretName);
    }

    assertSecretFile(fileName);

    const filePath = await resolveStackFilePath(host.path, fileName);
    await fsAsync.access(filePath).catch(() => {
        throw new ValidationError("Secret file not found: " + fileName);
    });

    const composeYAML = host.composeText();
    const doc = parseDocument(composeYAML);
    const declaredServices = readComposeServices(composeYAML);

    for (const service of services) {
        if (!declaredServices.includes(service)) {
            throw new ValidationError("Unknown service: " + service);
        }
    }

    doc.setIn([ "secrets", secretName, "file" ], "./" + fileName);

    for (const service of services) {
        const current = doc.getIn([ "services", service, "secrets" ]);
        const list = isSeq(current) ? current.toJSON() as string[] : [];

        if (!list.includes(secretName)) {
            list.push(secretName);
        }

        doc.setIn([ "services", service, "secrets" ], list);
    }

    const bindings = host.fileConfig().secretBindings.filter((item) => item.name !== secretName);
    bindings.push({
        name: secretName,
        fileName,
        services: [ ...services ],
    });

    await commit(host, serialise(host, doc), bindings);
}

/**
 * Take a secret reference out of the compose file and out of the stored bindings
 * @param host The stack the secret belongs to
 * @param secretName Compose secret name
 */
export async function unbindSecret(host : SecretHost, secretName : string) : Promise<void> {
    const composeYAML = host.composeText();
    const doc = parseDocument(composeYAML);
    let changed = false;

    if (doc.hasIn([ "secrets", secretName ])) {
        doc.deleteIn([ "secrets", secretName ]);
        changed = true;
    }

    const secretsNode = doc.getIn([ "secrets" ]);
    if (isMap(secretsNode) && secretsNode.items.length === 0) {
        doc.deleteIn([ "secrets" ]);
    }

    for (const service of readComposeServices(composeYAML)) {
        const current = doc.getIn([ "services", service, "secrets" ]);
        if (!isSeq(current)) {
            continue;
        }

        const currentList = current.toJSON() as string[];
        const list = currentList.filter((item) => item !== secretName);

        if (list.length === currentList.length) {
            continue;
        }

        changed = true;

        if (list.length === 0) {
            doc.deleteIn([ "services", service, "secrets" ]);
        } else {
            doc.setIn([ "services", service, "secrets" ], list);
        }
    }

    await commit(host, changed ? serialise(host, doc) : null,
        host.fileConfig().secretBindings.filter((item) => item.name !== secretName));
}
