import { spawn } from "./child-process";

/**
 * One way of calling git, for everything the panel does with a repository.
 *
 * Git obeys a long list of inherited variables and configuration files, and any
 * one of them can point it at another executable, another config or another
 * index. Two places call git - reading the state of a stack directory and the
 * update workflow - and a hardening that exists in only one of them protects
 * nothing. So the environment is built here, once, and the callers are left with
 * the parts that genuinely differ: how much output they expect and how long they
 * are willing to wait.
 */

/** Transports git may use. `file:` is for isolated tests, never for a socket. */
const NETWORK_PROTOCOLS = "http:https:ssh";
const LOCAL_PROTOCOLS = `${NETWORK_PROTOCOLS}:file`;

/**
 * Settings that always apply, whatever the command.
 *
 * Hooks and filters are a repository's own executable content, credential
 * helpers would answer prompts the server must never answer, and submodules and
 * the `ext::` transport reach outside the directory the user chose.
 */
const HARDENED_CONFIG : readonly string[] = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-c", "submodule.recurse=false",
    "-c", "protocol.ext.allow=never",
];

export interface GitCommandOptions {
    /** Directory git runs in */
    cwd : string;
    /** Whether a local path may be used as a remote; only isolated tests set it */
    allowLocalTransport? : boolean | undefined;
    /** Private index file, so rebuilding a tree never touches the real one */
    indexFile? : string | undefined;
    /** Extra `-c` settings of this call, appended after the fixed ones */
    config? : readonly string[] | undefined;
    /** Largest output accepted before the call is treated as a failure */
    maxBuffer : number;
    timeoutMs : number;
}

/**
 * Environment of one git call: inherited GIT_* variables are dropped, not merged.
 *
 * Whatever configured the server process has no business configuring git here,
 * and a variable that survives can redirect the command entirely.
 * @param options Settings of the call
 * @returns Environment to spawn with
 */
function gitEnvironment(options : GitCommandOptions) : NodeJS.ProcessEnv {
    const env : NodeJS.ProcessEnv = { ...process.env };

    for (const key of Object.keys(env)) {
        if (key.startsWith("GIT_")) {
            delete env[key];
        }
    }

    Object.assign(env, {
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        // Takes precedence over core.sshCommand, so the same thing is not said twice
        GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
        GIT_ALLOW_PROTOCOL: options.allowLocalTransport ? LOCAL_PROTOCOLS : NETWORK_PROTOCOLS,
        // Reading a stack must not leave lock files in the user's repository
        GIT_OPTIONAL_LOCKS: "0",
    });

    if (options.indexFile) {
        env.GIT_INDEX_FILE = options.indexFile;
    }

    return env;
}

/**
 * Run one git command and return its raw output.
 *
 * Arguments are fixed by the caller and never assembled from a client: this is a
 * process call, not a shell, and nothing here escapes anything.
 * @param args Git arguments, after the fixed settings
 * @param options Settings of the call
 * @returns Standard output as bytes
 * @throws Whatever the process wrapper throws; callers decide what to say about it
 */
export async function runGit(args : readonly string[], options : GitCommandOptions) : Promise<Buffer> {
    const result = await spawn("git", [ ...HARDENED_CONFIG, ...options.config ?? [], ...args ], {
        cwd: options.cwd,
        env: gitEnvironment(options),
        encoding: "buffer",
        maxBuffer: options.maxBuffer,
        timeoutMs: options.timeoutMs,
    });

    return Buffer.from(result.stdout ?? "");
}
