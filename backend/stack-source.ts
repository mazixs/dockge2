import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git-command";
import { log } from "./log";
import type { StackSource } from "../common/stack-source";

export type { StackSource };

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
 *
 * A failure is not an error here: an answer that cannot be read stays empty, because
 * the alternative is inventing a value for the UI. The call itself is the hardened
 * one every other git call of the panel goes through - reading a directory is not a
 * reason to trust its configuration any more than updating it is.
 * @param dir Work tree
 * @param args Git arguments, fixed by the caller and never taken from a client
 * @param unavailable Answer to return when git could not be asked
 * @returns Output without surrounding whitespace, `unavailable` when git failed
 */
async function git(dir : string, args : string[], unavailable = "") : Promise<string> {
    try {
        const config : string[] = [];

        // Содержимое репозитория может подменять себя при чтении через filter-драйверы.
        // Для status они выключаются поименно: включенный драйвер выполнил бы чужую
        // команду ради строки в списке стеков
        if (args[0] === "status") {
            try {
                const filters = await runGit([ "config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$" ], { cwd: dir,
                    maxBuffer: 64 * 1024,
                    timeoutMs: GIT_TIMEOUT_MS });

                for (const key of filters.toString("utf-8").split("\0").filter(Boolean)) {
                    config.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
                }
            } catch (error) {
                // git config exits 1 when no filter keys exist; other failures must not run status unsafely.
                if ((error as { code? : number }).code !== 1) {
                    throw error;
                }
            }
        }

        const output = await runGit(args, { cwd: dir,
            config,
            maxBuffer: 64 * 1024,
            timeoutMs: GIT_TIMEOUT_MS });

        return output.toString("utf-8").trim();
    } catch (e) {
        if (e instanceof Error) {
            log.debug("stackSource", `git ${args[0]} could not read stack source`);
        }
        return unavailable;
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

    if (!cleaned || /[\x00-\x1f\x7f]/.test(cleaned)) {
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
            // Only ordinary local repository paths survive URL parsing failure.
            if (!/^[A-Za-z0-9_./ -]+$/.test(cleaned)) {
                return "";
            }
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
        commit: "",
        changedFiles: null,
        remote: "",
        branch: "",
        behind: null,
        dirty: null,
        checkedAt: null,
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
    const commit = await git(dir, [ "rev-parse", "HEAD" ]);
    const remote = cleanRemote(await git(dir, [ "remote", "get-url", "origin" ]));
    const status = await git(dir, [ "status", "--porcelain" ], "\0");
    const behindOutput = await git(dir, [ "rev-list", "--count", "HEAD..@{u}" ]);
    const behind = /^\d+$/.test(behindOutput) ? Number.parseInt(behindOutput, 10) : null;

    return {
        kind: "git",
        commit: /^[a-f0-9]{40,64}$/.test(commit) ? commit : "",
        changedFiles: status === "\0" ? null : status ? status.split("\n").length : 0,
        remote,
        branch: branch === "HEAD" ? "" : branch,
        behind,
        dirty: status === "\0" ? null : status !== "",
        checkedAt: fetchedAt(dir),
    };
}

/**
 * Directory holding the repository state of a work tree.
 *
 * `.git` is a directory in an ordinary clone and a file pointing elsewhere in a
 * linked work tree. FETCH_HEAD belongs to the work tree that fetched, so the
 * pointer has to be followed rather than assumed.
 * @param dir Work tree
 * @returns Absolute path of the git directory
 */
function gitDir(dir : string) : string {
    const dot = path.join(dir, ".git");

    if (fs.statSync(dot).isDirectory()) {
        return dot;
    }

    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, "utf-8"));

    if (!pointer) {
        throw new Error("no gitdir pointer");
    }

    return path.resolve(dir, pointer[1]!.trim());
}

/**
 * When origin was last asked, from the modification time of FETCH_HEAD.
 *
 * Only a fetch writes that file, so the answer never claims a check that did not
 * happen. A clone does not write it either: a stack that was created and never
 * compared reports null, and the interface asks for one check instead of calling
 * an unverified distance "in sync".
 * @param dir Work tree
 * @returns Milliseconds of the last fetch, null when nothing ever fetched here
 */
function fetchedAt(dir : string) : number | null {
    try {
        return Math.round(fs.statSync(path.join(gitDir(dir), "FETCH_HEAD")).mtimeMs);
    } catch {
        return null;
    }
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
