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

import { MAX_STACK_NAME_LENGTH } from "./util-common";

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

    // An absolute path is matched as a string rather than through `path`: the rule is
    // shared by the server and the browser, and the browser has no node modules. The
    // server is Linux
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

/**
 * Suggest a stack name from a repository address.
 *
 * Without a suggestion the field keeps whatever was typed for the repository before it,
 * so a second attempt at a different repository is offered the first one's name. The
 * name is the last path segment in the form a stack directory accepts; an address that
 * yields nothing usable gets no suggestion, and the user names the stack.
 * @param repository Address as the user typed it
 * @returns A name that passes the stack name rule, or an empty string
 */
export function stackNameFromRepository(repository : string) : string {
    const segment = repository.trim().replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).pop() ?? "";
    const name = segment.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "");
    // Trailing separators are trimmed after the cut as well, or a long address would
    // suggest a name ending in the dash the cut happened to land on
    return name.slice(0, MAX_STACK_NAME_LENGTH).replace(/[-_]+$/, "");
}
