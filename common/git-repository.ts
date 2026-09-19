/**
 * Which repository addresses the panel accepts.
 *
 * The rule lives here because both sides apply it: the creation page decides
 * whether the button may be pressed, and the server decides whether the address
 * is used. Written twice, the two drifted - the page enabled the button for
 * addresses the server then refused, and the user saw a refusal instead of a
 * disabled field.
 *
 * Credentials are never part of an address. A token in a URL would be stored in
 * the stack directory, printed in a remote listing and shown in the interface,
 * so the server gets its access from the host - an SSH key or a credential store
 * outside the panel.
 */

/** Why an address cannot be used */
export type GitRepositoryProblem =
    /** Not an address at all: too long, control characters, or starts like an option */
    "shape" |
    /** An address, but not a transport the panel uses, or it carries credentials */
    "transport";

/** SSH shorthand, `user@host:path`, with a path that cannot become an option */
const SCP_FORM = /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/;

/**
 * Check one repository address.
 * @param repository Address as the user typed it, without surrounding whitespace
 * @param allowLocalPath Whether a local absolute path counts as a remote; only
 * isolated tests set it, because a local path would let a socket name any
 * directory of the server
 * @returns What is wrong with the address, or null when it can be used
 */
export function gitRepositoryProblem(repository : unknown, allowLocalPath = false) : GitRepositoryProblem | null {
    if (typeof repository !== "string" || repository.length > 2048 || /[\x00-\x20\x7f]/.test(repository) || repository.startsWith("-")) {
        return "shape";
    }

    // Абсолютный путь проверяется по строке, а не через path: правило общее для
    // сервера и браузера, и в браузере node-модулей нет. Сервер - Linux
    if (allowLocalPath && repository.startsWith("/")) {
        return null;
    }

    if (SCP_FORM.test(repository)) {
        return null;
    }

    try {
        const url = new URL(repository);

        if (![ "https:", "http:", "ssh:" ].includes(url.protocol) || url.password || (url.protocol !== "ssh:" && url.username) || url.search || url.hash || !url.hostname || !url.pathname || url.pathname === "/") {
            return "transport";
        }
    } catch {
        return "transport";
    }

    return null;
}

/**
 * Whether an address may be offered to the server.
 * @param repository Address as the user typed it
 * @returns true when the server would accept it
 */
export function isSafeGitRepository(repository : string) : boolean {
    return gitRepositoryProblem(repository) === null;
}
