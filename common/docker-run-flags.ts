/**
 * Longest `docker run` command the server converts, in characters.
 *
 * A real command with dozens of variables, mounts and labels stays under 4 KiB.
 * The limit bounds the work one request can ask of the server and the size of
 * the answer, and a pasted megabyte is refused before it is read at all.
 */
export const MAX_DOCKER_RUN_COMMAND_LENGTH = 8 * 1024;

/**
 * What happened to one flag of a `docker run` command during conversion.
 *
 * `carried` means the flag produced the compose key it should have produced,
 * `review` means it produced something the person has to look at, and `dropped`
 * means what the flag asked for is not in the file: compose has no equivalent,
 * the converter does not carry it, or docker itself would refuse it. A dropped
 * flag is the reason a converted service does not work, so it is never silent.
 */
export type FlagOutcome = "carried" | "review" | "dropped";

/** One line of the conversion report */
export interface FlagReportItem {
    /**
     * Flag as it was written in the command, for example `--device`, or
     * `image` and `command` for the image and the arguments after it
     */
    flag : string;

    /** Value the flag carried, when it had one */
    value? : string;

    /** What happened to it */
    outcome : FlagOutcome;

    /** Translation key explaining the outcome, when there is something to say */
    reason? : string;
}

/** The whole report of one conversion */
export interface ConversionReport {
    carried : FlagReportItem[];
    review : FlagReportItem[];
    dropped : FlagReportItem[];
}

/** A flag as it appeared in the command */
export interface ParsedFlag {
    flag : string;
    value? : string;
}

/** Flags of a `docker run` command, its image and the arguments after the image */
export interface ParsedCommand {
    flags : ParsedFlag[];

    /** Image to run, missing when the command names none */
    image? : string;

    /** Command and arguments of the container, when any follow the image */
    args : string[];
}

/** Short flags of `docker run` and the long flags they stand for */
const SHORT_FLAGS : Record<string, string> = {
    a: "--attach",
    c: "--cpu-shares",
    d: "--detach",
    e: "--env",
    h: "--hostname",
    i: "--interactive",
    l: "--label",
    m: "--memory",
    p: "--publish",
    P: "--publish-all",
    q: "--quiet",
    t: "--tty",
    u: "--user",
    v: "--volume",
    w: "--workdir",
};

/** Older spellings docker still accepts */
const LONG_ALIASES : Record<string, string> = {
    "--net": "--network",
    "--net-alias": "--network-alias",
    "--dns-opt": "--dns-option",
};

/** Long flags of `docker run` that never take a value, as `docker run --help` lists them */
const BOOLEAN_FLAGS = new Set([
    "--detach", "--disable-content-trust", "--help", "--init", "--interactive", "--no-healthcheck",
    "--oom-kill-disable", "--privileged", "--publish-all", "--quiet", "--read-only", "--rm",
    "--sig-proxy", "--tty", "--use-api-socket",
]);

/**
 * Long flags of `docker run` that take a value, as `docker run --help` lists them,
 * with the Windows-only and deprecated ones docker still accepts
 */
const VALUE_FLAGS = new Set([
    "--add-host", "--annotation", "--attach", "--blkio-weight", "--blkio-weight-device", "--cap-add",
    "--cap-drop", "--cgroup-parent", "--cgroupns", "--cidfile", "--cpu-count", "--cpu-percent",
    "--cpu-period", "--cpu-quota", "--cpu-rt-period", "--cpu-rt-runtime", "--cpu-shares", "--cpus",
    "--cpuset-cpus", "--cpuset-mems", "--detach-keys", "--device", "--device-cgroup-rule",
    "--device-read-bps", "--device-read-iops", "--device-write-bps", "--device-write-iops", "--dns",
    "--dns-option", "--dns-search", "--domainname", "--entrypoint", "--env", "--env-file", "--expose",
    "--gpus", "--group-add", "--health-cmd", "--health-interval", "--health-retries",
    "--health-start-interval", "--health-start-period", "--health-timeout", "--hostname",
    "--io-maxbandwidth", "--io-maxiops", "--ip", "--ip6", "--ipc", "--isolation", "--kernel-memory",
    "--label", "--label-file", "--link", "--link-local-ip", "--log-driver", "--log-opt",
    "--mac-address", "--memory", "--memory-reservation", "--memory-swap", "--memory-swappiness",
    "--mount", "--name", "--network", "--network-alias", "--oom-score-adj", "--pid", "--pids-limit",
    "--platform", "--publish", "--pull", "--restart", "--runtime", "--security-opt", "--shm-size",
    "--stop-signal", "--stop-timeout", "--storage-opt", "--sysctl", "--tmpfs", "--ulimit", "--umask",
    "--user", "--userns", "--uts", "--volume", "--volume-driver", "--volumes-from", "--workdir",
]);

/** Every long flag docker knows, in the spelling `canonicalFlag` returns */
export const DOCKER_RUN_FLAGS : ReadonlySet<string> = new Set([ ...BOOLEAN_FLAGS, ...VALUE_FLAGS ]);

/**
 * The long spelling of a flag, so that `-e`, `--env` and `--net` are looked up once
 * @param flag Flag as it was written
 * @returns Long flag, or the flag unchanged when docker does not know it
 */
export function canonicalFlag(flag : string) : string {
    if (flag.startsWith("--")) {
        return LONG_ALIASES[flag] ?? flag;
    }

    return SHORT_FLAGS[flag.slice(1)] ?? flag;
}

/**
 * Whether a flag docker knows takes a value
 * @param flag Flag in any spelling
 * @returns True for a flag with a value of its own
 */
export function takesValue(flag : string) : boolean {
    return VALUE_FLAGS.has(canonicalFlag(flag));
}

/**
 * Whether a long flag written without `=` takes the next token as its value.
 *
 * A flag docker does not know takes the next token unless that token is another
 * flag. Reading it as a switch instead took the value for the image and hid every
 * flag after it; when that guess takes the image, `parseDockerRun` reads the flag
 * again as a switch.
 * @param flag Flag without its value
 * @param next Token after the flag
 * @returns True when the next token is the value of the flag
 */
function longFlagTakesValue(flag : string, next : string | undefined) : boolean {
    const canonical = canonicalFlag(flag);

    if (DOCKER_RUN_FLAGS.has(canonical)) {
        return VALUE_FLAGS.has(canonical);
    }

    return next !== undefined && (!next.startsWith("-") || /^-\d/.test(next));
}

/**
 * Split a command line the way a shell does, minus the clever parts.
 *
 * Quotes are honoured and a backslash at the end of a line continues the
 * command, because that is how people paste a long `docker run`.
 * @param command Command as the person typed or pasted it
 * @returns Tokens of the command
 */
export function tokeniseCommand(command : string) : string[] {
    const tokens : string[] = [];
    let current = "";
    let quote : string | null = null;
    let hasContent = false;

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index] as string;

        if (quote) {
            if (character === quote) {
                quote = null;
            } else {
                current += character;
            }
            continue;
        }

        if (character === "\"" || character === "'") {
            quote = character;
            hasContent = true;
            continue;
        }

        // A backslash before a newline is a line continuation, not a token
        if (character === "\\" && (command[index + 1] === "\n" || command[index + 1] === "\r")) {
            index += 1;
            continue;
        }

        if (/\s/.test(character)) {
            if (current !== "" || hasContent) {
                tokens.push(current);
                current = "";
                hasContent = false;
            }
            continue;
        }

        current += character;
    }

    if (current !== "" || hasContent) {
        tokens.push(current);
    }

    return tokens;
}

/**
 * Read the flags of a `docker run` command.
 *
 * Everything after the image name is the command of the container and carries no
 * flags of its own, so parsing stops there.
 * @param command Command as the person typed or pasted it
 * @returns Flags in the order they were written
 */
export function parseDockerRunFlags(command : string) : ParsedFlag[] {
    return parseDockerRun(command).flags;
}

/**
 * Read a `docker run` command into its flags, its image and the arguments after it.
 *
 * Anything before `run` is skipped, so `sudo docker run` and `docker container run`
 * read the same. An unknown flag that took the image as its value is read again as
 * a switch, the latest such flag first.
 * @param command Command as the person typed or pasted it
 * @returns Flags in the order they were written, the image and the container arguments
 */
export function parseDockerRun(command : string) : ParsedCommand {
    const tokens = tokeniseCommand(command);
    const switches = new Set<number>();

    for (;;) {
        const { parsed, guessed } = readTokens(tokens, switches);

        if (parsed.image !== undefined || guessed === undefined) {
            return parsed;
        }

        switches.add(guessed);
    }
}

/**
 * One reading of the tokens of a command
 * @param tokens Tokens of the command
 * @param switches Positions of unknown flags to read as switches
 * @returns What was read, and the position of the last unknown flag that took the next token
 */
function readTokens(tokens : string[], switches : Set<number>) : { parsed : ParsedCommand, guessed? : number } {
    const flags : ParsedFlag[] = [];
    let started = false;
    let guessed : number | undefined;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as string;

        if (!started) {
            started = token === "run";
            continue;
        }

        if (!token.startsWith("-")) {
            // The image name: the rest belongs to the container
            return { parsed: { flags,
                image: token,
                args: tokens.slice(index + 1) } };
        }

        if (token.startsWith("--")) {
            const [ name, inlineValue ] = splitOnce(token, "=");
            const next = tokens[index + 1];

            if (inlineValue !== undefined) {
                flags.push({ flag: name,
                    value: inlineValue });
            } else if (!switches.has(index) && longFlagTakesValue(name, next)) {
                if (!DOCKER_RUN_FLAGS.has(canonicalFlag(name))) {
                    guessed = index;
                }
                index += 1;
                flags.push({ flag: name,
                    ...(next === undefined ? {} : { value: next }) });
            } else {
                flags.push({ flag: name });
            }

            continue;
        }

        // Short flags: `-p 80:80`, `-p80:80`, `-p=80:80`, `-it`, `-dp 80:80`, `-P=false`
        const letters = token.slice(1);
        let consumedValue = false;

        for (let position = 0; position < letters.length; position += 1) {
            const name = `-${letters[position] as string}`;

            if (letters[position + 1] === "=" && letters.length > position + 2) {
                flags.push({ flag: name,
                    value: letters.slice(position + 2) });
                break;
            }

            if (takesValue(name)) {
                const rest = letters.slice(position + 1);
                const value = rest !== "" ? rest : tokens[index + 1];

                if (rest === "") {
                    consumedValue = true;
                }

                flags.push({ flag: name,
                    ...(value === undefined ? {} : { value }) });
                break;
            }

            // A switch, known or not: an unknown one is still reported, so it cannot vanish quietly
            flags.push({ flag: name });
        }

        if (consumedValue) {
            index += 1;
        }
    }

    return { parsed: { flags,
        args: [] },
    ...(guessed === undefined ? {} : { guessed }) };
}

/**
 * Split a string on the first occurrence of a separator
 * @param value String to split
 * @param separator Separator to split on
 * @returns Head and tail, where the tail is undefined when the separator is absent
 */
export function splitOnce(value : string, separator : string) : [string, string | undefined] {
    const at = value.indexOf(separator);

    if (at === -1) {
        return [ value, undefined ];
    }

    return [ value.slice(0, at), value.slice(at + separator.length) ];
}
