import { acceptedComposeFileNames } from "./util-common";

export type StackFileKind = "compose" | "env" | "secret";

/**
 * A file name segment that is safe to join with the stack directory.
 * It has to start with a letter or a digit, so `.`, `..` and hidden traversal tricks are out.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Check a plain name segment: a file name part, a compose secret name and anything else
 * that must not carry separators, options or traversal.
 * @param value Value to check
 * @returns True when the value is a safe segment
 */
export function isSafeNameSegment(value : string) : boolean {
    return SAFE_SEGMENT.test(value);
}

const MAX_FILE_NAME_LENGTH = 255;

/**
 * Check that a name is a plain file name inside the stack directory.
 * Absolute paths, separators, `..` and control characters are rejected.
 * @param fileName Name to check
 * @returns Whether the name can be joined with the stack directory
 */
export function isSafeStackFileName(fileName : string) : boolean {
    if (fileName.length === 0 || fileName.length > MAX_FILE_NAME_LENGTH) {
        return false;
    }

    // No directories, no drive letters, no traversal
    if (fileName.includes("/") || fileName.includes("\\") || fileName.includes(":")) {
        return false;
    }

    if (fileName === "." || fileName === ".." || fileName.includes("..")) {
        return false;
    }

    if (/[\u0000-\u001f\u007f]/.test(fileName)) {
        return false;
    }

    return classifyStackFile(fileName) !== null;
}

/**
 * Decide what kind of stack file a name is.
 * The allowed shapes are explicit on purpose, an arbitrary name is not accepted.
 *
 * Compose: `compose.yaml`, `docker-compose.yml`, `compose.prod.yaml`, …
 * Env: `.env`, `.env.product`, `.env-test`, `production.env`
 * Secret: `.secret`, `.secret.db`, `db.secret`
 * @param fileName Name to classify
 * @returns Kind of the file, or null when the name is not accepted
 */
export function classifyStackFile(fileName : string) : StackFileKind | null {
    if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
        return null;
    }

    if (isEnvFileName(fileName)) {
        return "env";
    }

    if (isSecretFileName(fileName)) {
        return "secret";
    }

    if (isComposeFileName(fileName)) {
        return "compose";
    }

    return null;
}

/**
 * Check whether a name is a usable compose file name
 * @param fileName Name to check
 * @returns Whether compose can be pointed at this file
 */
export function isComposeFileName(fileName : string) : boolean {
    if (acceptedComposeFileNames.includes(fileName)) {
        return true;
    }

    if (!SAFE_SEGMENT.test(fileName)) {
        return false;
    }

    return fileName.endsWith(".yaml") || fileName.endsWith(".yml");
}

/**
 * Check whether a name is a usable env file name
 * @param fileName Name to check
 * @returns Whether the file can be passed as `--env-file`
 */
export function isEnvFileName(fileName : string) : boolean {
    if (fileName === ".env") {
        return true;
    }

    if (fileName.startsWith(".env.") || fileName.startsWith(".env-")) {
        return SAFE_SEGMENT.test(fileName.slice(5));
    }

    if (fileName.endsWith(".env")) {
        return SAFE_SEGMENT.test(fileName.slice(0, -4));
    }

    return false;
}

/**
 * Check whether a name is a usable secret file name
 * @param fileName Name to check
 * @returns Whether the file can hold a compose secret
 */
export function isSecretFileName(fileName : string) : boolean {
    if (fileName === ".secret") {
        return true;
    }

    if (fileName.startsWith(".secret.") || fileName.startsWith(".secret-")) {
        return SAFE_SEGMENT.test(fileName.slice(8));
    }

    if (fileName.endsWith(".secret")) {
        return SAFE_SEGMENT.test(fileName.slice(0, -7));
    }

    return false;
}

/**
 * Pick the compose file a stack without metadata should use.
 * The choice is deterministic, so the server never silently switches between files.
 * @param composeFileNames Compose files found in the directory
 * @returns Selected file name, empty when the directory has none
 */
export function pickDefaultComposeFile(composeFileNames : readonly string[]) : string {
    for (const accepted of acceptedComposeFileNames) {
        if (composeFileNames.includes(accepted)) {
            return accepted;
        }
    }

    return [ ...composeFileNames ].sort()[0] ?? "";
}

/**
 * Whether a refused name still looks like a stack file.
 *
 * The allow-list is deliberately narrow, and a name it turns down simply disappears
 * from the inventory: the file lies in the directory, but no screen mentions it. That
 * reads as data loss. Names of this shape are the ones a person meant as stack files -
 * `настройки.env`, `compose.старый.yaml` - so the screen can say out loud why they are
 * not on the list. Everything else in the directory (`README.md`, `data/`) was never
 * a stack file and stays out.
 * @param fileName Name found in the stack directory
 * @returns True when the name was meant as a stack file but is not accepted
 */
export function looksLikeStackFile(fileName : string) : boolean {
    if (classifyStackFile(fileName) !== null) {
        return false;
    }

    const lower = fileName.toLowerCase();

    return lower.endsWith(".yaml") || lower.endsWith(".yml")
        || lower.startsWith(".env") || lower.endsWith(".env")
        || lower.startsWith(".secret") || lower.endsWith(".secret");
}
