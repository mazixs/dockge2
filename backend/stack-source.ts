import fs from "node:fs";
import path from "node:path";
import { spawn } from "./child-process";
import { log } from "./log";

/** Where the files of a stack come from, as far as reading the directory can tell */
export interface StackSource {
    /** git when the directory is a work tree, local when it is a plain directory */
    kind : "git" | "local";
    /** Remote address without credentials, empty when there is no remote */
    remote : string;
    /** Checked out branch, empty when the head is detached or unreadable */
    branch : string;
    /**
     * Commits the work tree is behind its upstream, null when it cannot be told.
     * Nothing is fetched here, so this is the distance to the last known upstream
     * state - the truth may be further away, and the UI must not pretend otherwise.
     */
    behind : number | null;
    /** Whether the work tree has uncommitted changes, null when it cannot be told */
    dirty : boolean | null;
}

/** How long one answer is reused, so the ten second cron does not run git per stack per tick */
const CACHE_MS = 60_000;

/** Timeout of one git call: a hung git must not hold the stack list */
const GIT_TIMEOUT_MS = 5_000;

interface CacheEntry {
    source : StackSource;
    readAt : number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Run one git command inside a directory and return its trimmed output.
 * A failure is not an error here: an answer that cannot be read stays empty, because
 * the alternative is inventing a value for the UI.
 * @param dir Work tree
 * @param args Git arguments, fixed by the caller and never taken from a client
 * @returns Output without surrounding whitespace, empty when git failed
 */
async function git(dir : string, args : string[]) : Promise<string> {
    try {
        const res = await spawn("git", args, {
            cwd: dir,
            encoding: "utf-8",
            maxBuffer: 64 * 1024,
            timeoutMs: GIT_TIMEOUT_MS,
        });

        return (res.stdout?.toString() ?? "").trim();
    } catch (e) {
        if (e instanceof Error) {
            log.debug("stackSource", `git ${args[0]} failed in ${dir}: ${e.message}`);
        }
        return "";
    }
}

/**
 * Remove credentials from a remote address.
 *
 * A remote can carry a token (`https://user:token@host/repo.git`), and the address
 * is shown in the UI, so the secret part is dropped before it can travel anywhere.
 * @param remote Raw output of `git remote get-url`
 * @returns Address without credentials and without the .git suffix
 */
export function cleanRemote(remote : string) : string {
    let cleaned = remote.trim();

    if (!cleaned) {
        return "";
    }

    // scp-like form: git@github.com:user/repo.git
    const scp = /^[^/]+@([^:]+):(.+)$/.exec(cleaned);
    if (scp && !cleaned.includes("://")) {
        cleaned = `${scp[1]}/${scp[2]}`;
    } else {
        try {
            const url = new URL(cleaned);
            url.username = "";
            url.password = "";
            cleaned = url.host + url.pathname;
        } catch {
            // Not a URL, leave it as it is
        }
    }

    return cleaned.replace(/\.git$/, "").replace(/\/+$/, "");
}

/**
 * Read where a stack directory comes from.
 *
 * Only reading happens: no fetch, no pull, no network. That is deliberate - the list
 * is refreshed every ten seconds, and a network call per stack would make the panel
 * depend on the availability of every remote.
 * @param dir Directory of the stack
 * @param now Current time, injectable for tests
 * @returns What the directory says about itself
 */
export async function readStackSource(dir : string, now = Date.now()) : Promise<StackSource> {
    const cached = cache.get(dir);

    if (cached && now - cached.readAt < CACHE_MS) {
        return cached.source;
    }

    const source = await readFromDisk(dir);
    cache.set(dir, { source,
        readAt: now });
    return source;
}

/**
 * Read the source of a directory, ignoring the cache
 * @param dir Directory of the stack
 * @returns What the directory says about itself
 */
async function readFromDisk(dir : string) : Promise<StackSource> {
    const local : StackSource = {
        kind: "local",
        remote: "",
        branch: "",
        behind: null,
        dirty: null,
    };

    // A work tree has .git as a directory, a linked work tree has it as a file
    if (!fs.existsSync(path.join(dir, ".git"))) {
        return local;
    }

    // Being inside a repository is confirmed by git itself: a stray .git file proves nothing
    const inside = await git(dir, [ "rev-parse", "--is-inside-work-tree" ]);
    if (inside !== "true") {
        return local;
    }

    const branch = await git(dir, [ "rev-parse", "--abbrev-ref", "HEAD" ]);
    const remote = cleanRemote(await git(dir, [ "remote", "get-url", "origin" ]));
    const status = await git(dir, [ "status", "--porcelain" ]);
    const behindOutput = await git(dir, [ "rev-list", "--count", "HEAD..@{u}" ]);
    const behind = /^\d+$/.test(behindOutput) ? Number.parseInt(behindOutput, 10) : null;

    return {
        kind: "git",
        remote,
        branch: branch === "HEAD" ? "" : branch,
        behind,
        dirty: status !== "",
    };
}

/**
 * Forget cached answers, used by tests and after an update changed the work tree
 * @param dir Directory to forget, all directories when omitted
 * @returns void
 */
export function clearStackSourceCache(dir? : string) : void {
    if (dir) {
        cache.delete(dir);
        return;
    }
    cache.clear();
}
