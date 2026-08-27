import { parseDocument, isMap } from "yaml";

/**
 * What happened to one flag of a `docker run` command during conversion.
 *
 * `carried` means the flag produced the compose key it should have produced,
 * `review` means it produced something the person has to look at, and `dropped`
 * means compose has no equivalent here and the line was not created. A dropped
 * flag is the reason a converted service does not work, so it is never silent.
 */
export type FlagOutcome = "carried" | "review" | "dropped";

/** One line of the conversion report */
export interface FlagReportItem {
    /** Flag as it was written in the command, for example `--device` */
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

/** A flag and the compose key it is supposed to turn into */
interface FlagSpec {
    /** Compose keys that prove the flag was carried over */
    keys : string[];

    /** True when the flag has a value of its own */
    takesValue? : boolean;

    /** Set when the outcome is always the same, whatever the YAML says */
    always? : FlagOutcome;

    /** Translation key with the explanation */
    reason? : string;
}

/**
 * Flags of `docker run` that matter for a compose file.
 *
 * Only flags a person actually writes are listed: the goal is a truthful report,
 * not a complete manual. An unknown flag is reported as needing a look rather
 * than silently accepted, because silence is what hides a broken service.
 */
const FLAG_SPECS : Record<string, FlagSpec> = {
    "--name": { keys: [ "container_name" ],
        takesValue: true },
    "-p": { keys: [ "ports" ],
        takesValue: true },
    "--publish": { keys: [ "ports" ],
        takesValue: true },
    "-P": { keys: [ "ports" ],
        reason: "flagPublishAllDropped" },
    "-v": { keys: [ "volumes" ],
        takesValue: true },
    "--volume": { keys: [ "volumes" ],
        takesValue: true },
    "--mount": { keys: [ "volumes" ],
        takesValue: true },
    "--tmpfs": { keys: [ "tmpfs" ],
        takesValue: true },
    "-e": { keys: [ "environment" ],
        takesValue: true },
    "--env": { keys: [ "environment" ],
        takesValue: true },
    "--env-file": { keys: [ "env_file" ],
        takesValue: true,
        always: "review",
        reason: "flagEnvFileRenamed" },
    "--restart": { keys: [ "restart" ],
        takesValue: true },
    "--network": { keys: [ "networks", "network_mode" ],
        takesValue: true,
        always: "review",
        reason: "flagNetworkExternal" },
    "--net": { keys: [ "networks", "network_mode" ],
        takesValue: true,
        always: "review",
        reason: "flagNetworkExternal" },
    "--hostname": { keys: [ "hostname" ],
        takesValue: true },
    "-h": { keys: [ "hostname" ],
        takesValue: true },
    "--add-host": { keys: [ "extra_hosts" ],
        takesValue: true },
    "--dns": { keys: [ "dns" ],
        takesValue: true },
    "-u": { keys: [ "user" ],
        takesValue: true },
    "--user": { keys: [ "user" ],
        takesValue: true },
    "-w": { keys: [ "working_dir" ],
        takesValue: true },
    "--workdir": { keys: [ "working_dir" ],
        takesValue: true },
    "--entrypoint": { keys: [ "entrypoint" ],
        takesValue: true },
    "-l": { keys: [ "labels" ],
        takesValue: true },
    "--label": { keys: [ "labels" ],
        takesValue: true },
    "--label-file": { keys: [ "labels" ],
        takesValue: true,
        reason: "flagLabelFileDropped" },
    "--cap-add": { keys: [ "cap_add" ],
        takesValue: true },
    "--cap-drop": { keys: [ "cap_drop" ],
        takesValue: true },
    "--device": { keys: [ "devices" ],
        takesValue: true },
    "--privileged": { keys: [ "privileged" ] },
    "--init": { keys: [ "init" ] },
    "--security-opt": { keys: [ "security_opt" ],
        takesValue: true },
    "--shm-size": { keys: [ "shm_size" ],
        takesValue: true },
    "--sysctl": { keys: [ "sysctls" ],
        takesValue: true },
    "--ulimit": { keys: [ "ulimits" ],
        takesValue: true },
    "--stop-signal": { keys: [ "stop_signal" ],
        takesValue: true },
    "--stop-timeout": { keys: [ "stop_grace_period" ],
        takesValue: true },
    "--log-driver": { keys: [ "logging" ],
        takesValue: true },
    "--log-opt": { keys: [ "logging" ],
        takesValue: true },
    "-m": { keys: [ "mem_limit", "deploy" ],
        takesValue: true },
    "--memory": { keys: [ "mem_limit", "deploy" ],
        takesValue: true },
    "--cpus": { keys: [ "cpus", "deploy" ],
        takesValue: true },
    "--gpus": { keys: [ "deploy", "devices" ],
        takesValue: true,
        reason: "flagGpusDropped" },
    "--health-cmd": { keys: [ "healthcheck" ],
        takesValue: true },
    "--health-interval": { keys: [ "healthcheck" ],
        takesValue: true },
    "--runtime": { keys: [ "runtime" ],
        takesValue: true },
    "--pid": { keys: [ "pid" ],
        takesValue: true },
    "--ipc": { keys: [ "ipc" ],
        takesValue: true },
    "-t": { keys: [ "tty" ] },
    "--tty": { keys: [ "tty" ] },
    "-i": { keys: [ "stdin_open" ] },
    "--interactive": { keys: [ "stdin_open" ] },

    // Flags that describe how `docker run` itself behaves: a compose file has no
    // place for them, and their absence is not a loss
    "-d": { keys: [],
        always: "carried",
        reason: "flagNotNeeded" },
    "--detach": { keys: [],
        always: "carried",
        reason: "flagNotNeeded" },
    "--rm": { keys: [],
        reason: "flagRmDropped" },
    "--pull": { keys: [],
        takesValue: true,
        always: "carried",
        reason: "flagNotNeeded" },
    "-q": { keys: [],
        always: "carried",
        reason: "flagNotNeeded" },
};

/** Combined short flags such as `-it` are split into these */
const SHORT_BOOLEAN_FLAGS = new Set([ "d", "i", "t", "P", "q" ]);

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

/** A flag as it appeared in the command */
interface ParsedFlag {
    flag : string;
    value? : string;
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
    const tokens = tokeniseCommand(command);
    const flags : ParsedFlag[] = [];
    let started = false;

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] as string;

        if (!started) {
            // Skip `docker`, `run`, and anything before them
            if (token === "run") {
                started = true;
            }
            continue;
        }

        if (!token.startsWith("-")) {
            // The image name: the rest belongs to the container
            break;
        }

        if (token.startsWith("--")) {
            const [ name, inlineValue ] = splitOnce(token, "=");
            const spec = FLAG_SPECS[name as string];

            if (spec?.takesValue) {
                const value = inlineValue ?? tokens[index + 1];

                if (inlineValue === undefined) {
                    index += 1;
                }

                flags.push({ flag: name as string,
                    ...(value === undefined ? {} : { value }) });
            } else {
                flags.push({ flag: name as string });
            }

            continue;
        }

        // Short flags: `-p 80:80`, `-p80:80`, `-it`, `-dp 80:80`
        const letters = token.slice(1);
        let consumedValue = false;

        for (let position = 0; position < letters.length; position += 1) {
            const letter = letters[position] as string;
            const name = `-${letter}`;
            const spec = FLAG_SPECS[name];

            if (spec?.takesValue) {
                const rest = letters.slice(position + 1);
                const value = rest !== "" ? rest : tokens[index + 1];

                if (rest === "") {
                    consumedValue = true;
                }

                flags.push({ flag: name,
                    ...(value === undefined ? {} : { value }) });
                break;
            }

            if (SHORT_BOOLEAN_FLAGS.has(letter) || spec) {
                flags.push({ flag: name });
                continue;
            }

            // Unknown short flag: still reported, so it cannot vanish quietly
            flags.push({ flag: name });
        }

        if (consumedValue) {
            index += 1;
        }
    }

    return flags;
}

/**
 * Split a string on the first occurrence of a separator
 * @param value String to split
 * @param separator Separator to split on
 * @returns Head and tail, where the tail is undefined when the separator is absent
 */
function splitOnce(value : string, separator : string) : [string, string | undefined] {
    const at = value.indexOf(separator);

    if (at === -1) {
        return [ value, undefined ];
    }

    return [ value.slice(0, at), value.slice(at + separator.length) ];
}

/**
 * Keys that the produced compose file gives to its services
 * @param composeYaml Compose file as the converter produced it
 * @returns Set of service level keys
 */
function serviceKeys(composeYaml : string) : Set<string> {
    const keys = new Set<string>();

    try {
        const document = parseDocument(composeYaml);
        const services = document.get("services");

        if (!isMap(services)) {
            return keys;
        }

        for (const pair of services.items) {
            const service = pair.value;

            if (isMap(service)) {
                for (const serviceEntry of service.items) {
                    const key = String(serviceEntry.key);
                    keys.add(key);
                }
            }
        }
    } catch {
        // A file that does not parse tells us nothing about carried flags
        return keys;
    }

    return keys;
}

/**
 * Flags the converter itself refused, as it reports them.
 *
 * composerize puts an unsupported flag into a comment at the top of its output,
 * and that is a more reliable signal than any guess of ours.
 * @param composeYaml Compose file the converter produced
 * @returns Set of flags the converter named as unsupported
 */
function flagsRefusedByConverter(composeYaml : string) : Set<string> {
    const refused = new Set<string>();

    for (const line of composeYaml.split("\n")) {
        const match = /^#\s*(-{1,2}[a-zA-Z0-9-]+)/.exec(line.trim());

        if (match?.[1]) {
            refused.add(match[1]);
        }
    }

    return refused;
}

/**
 * Compare a `docker run` command with the compose file produced from it.
 *
 * The report says what survived the conversion, what needs a look and what was
 * dropped, because a converted service that silently lost `--device` looks fine
 * and does not work.
 * @param command Original command
 * @param composeYaml Compose file the converter produced
 * @returns Report grouped by outcome
 */
export function analyseConversion(command : string, composeYaml : string) : ConversionReport {
    const keys = serviceKeys(composeYaml);
    const refused = flagsRefusedByConverter(composeYaml);
    const report : ConversionReport = { carried: [],
        review: [],
        dropped: [] };

    for (const parsed of parseDockerRunFlags(command)) {
        const spec = FLAG_SPECS[parsed.flag];

        // Конвертер сам назвал флаг неподдержанным: спорить с ним нечем
        if (refused.has(parsed.flag)) {
            report.dropped.push({
                ...parsed,
                outcome: "dropped",
                reason: spec?.reason ?? (spec ? "flagNoComposeKey" : "flagUnknown"),
            });
            continue;
        }

        if (!spec) {
            report.review.push({
                ...parsed,
                outcome: "review",
                reason: "flagUnknown",
            });
            continue;
        }

        if (spec.always) {
            const item : FlagReportItem = {
                ...parsed,
                outcome: spec.always,
                ...(spec.reason ? { reason: spec.reason } : {}),
            };

            // A flag with a known target still counts as carried when the key is there
            if (spec.always === "review" && spec.keys.some((key) => keys.has(key))) {
                report.review.push(item);
            } else if (spec.always === "dropped") {
                report.dropped.push(item);
            } else if (spec.always === "review") {
                report.dropped.push({ ...item,
                    outcome: "dropped" });
            } else {
                report.carried.push(item);
            }

            continue;
        }

        if (spec.keys.some((key) => keys.has(key))) {
            report.carried.push({ ...parsed,
                outcome: "carried" });
        } else {
            report.dropped.push({
                ...parsed,
                outcome: "dropped",
                reason: spec.reason ?? "flagNoComposeKey",
            });
        }
    }

    return report;
}
