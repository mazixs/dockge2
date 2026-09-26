import { stringify } from "yaml";
import {
    canonicalFlag,
    parseDockerRun,
    splitOnce,
    takesValue,
    type ConversionReport,
    type FlagOutcome,
    type FlagReportItem,
} from "./docker-run-flags";

/** A compose file made from a `docker run` command, and what happened to every flag */
export interface DockerRunConversion {
    /** Compose file with one service, named after the image */
    compose : string;

    report : ConversionReport;
}

/** What happened to one flag, before it becomes a line of the report */
interface Verdict {
    outcome : FlagOutcome;
    reason? : string;
}

/** A top level volume or network the service refers to, which compose has to find */
interface ExternalEntry {
    external : true;
    name : string;
}

/** The service and the top level entries it needs, as the flags build them */
interface Draft {
    /** Service keys in the order the command asked for them */
    service : Map<string, unknown>;

    /** Named volumes the service refers to */
    volumes : Map<string, ExternalEntry>;
}

/** A network flag, kept aside until every network of the command is known */
interface NetworkFlag {
    index : number;
    flag : string;
    value? : string;
}

/** Converts the value of one flag into the draft, and says what came of it */
type Handler = (value : string, draft : Draft) => Verdict;

const CARRIED : Verdict = { outcome: "carried" };
const NOT_NEEDED : Verdict = { outcome: "carried",
    reason: "flagNotNeeded" };
const NO_EQUIVALENT : Verdict = { outcome: "dropped",
    reason: "flagNoComposeKey" };
const NOT_CONVERTED : Verdict = { outcome: "dropped",
    reason: "flagNotConverted" };
const NOT_ACCEPTED : Verdict = { outcome: "dropped",
    reason: "flagNotAccepted" };
const OPTIONS_LOST : Verdict = { outcome: "dropped",
    reason: "flagOptionsLost" };
const UNKNOWN : Verdict = { outcome: "dropped",
    reason: "flagUnknown" };
const VOLUME_EXTERNAL : Verdict = { outcome: "review",
    reason: "flagVolumeExternal" };
const NETWORK_EXTERNAL : Verdict = { outcome: "review",
    reason: "flagNetworkExternal" };
const DOLLAR : Verdict = { outcome: "review",
    reason: "flagDollarInterpolated" };

/** A volume source that is a name rather than a path */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const INTEGER = /^-?\d+$/;
const DECIMAL = /^(\d+\.?\d*|\.\d+)$/;

/** Flags whose meaning depends on the other network flags of the command */
const NETWORK_FLAGS = new Set([ "--network", "--network-alias", "--ip", "--ip6" ]);

/** A value that is a network mode rather than the name of a network */
const NETWORK_MODE = /^(host|bridge|none)$|^container:/;

/**
 * Read a switch the way docker reads `--flag=value`
 * @param value Value written after `=`, or `true` when there was none
 * @returns The switch, or undefined for a value docker would refuse
 */
function parseSwitch(value : string) : boolean | undefined {
    const normal = value.toLowerCase();

    if ([ "1", "t", "true" ].includes(normal)) {
        return true;
    }

    return [ "0", "f", "false" ].includes(normal) ? false : undefined;
}

/**
 * Split a comma separated value the way docker does for `--mount` and `--gpus`:
 * a field in double quotes keeps its commas
 * @param value Value of the flag
 * @returns Fields without their quotes
 */
function splitFields(value : string) : string[] {
    const fields : string[] = [];
    let current = "";
    let quoted = false;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index] as string;

        if (character === "\"") {
            if (quoted && value[index + 1] === "\"") {
                current += "\"";
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === "," && !quoted) {
            fields.push(current);
            current = "";
        } else {
            current += character;
        }
    }

    fields.push(current);
    return fields.map((field) => field.trim()).filter((field) => field !== "");
}

/**
 * The object at a path of service keys, created on the way when missing
 * @param service Service keys
 * @param path Service key followed by nested keys
 * @returns The object at the end of the path
 */
function objectAt(service : Map<string, unknown>, path : string[]) : Record<string, unknown> {
    const [ key, ...rest ] = path as [ string, ...string[] ];
    let current = service.get(key) as Record<string, unknown> | undefined;

    if (current === undefined) {
        current = {};
        service.set(key, current);
    }

    for (const part of rest) {
        current[part] ??= {};
        current = current[part] as Record<string, unknown>;
    }

    return current;
}

/**
 * Put a value at a dotted path of the service
 * @param service Service keys
 * @param path Dotted path, for example `healthcheck.interval`
 * @param value Value to put there
 */
function setAt(service : Map<string, unknown>, path : string, value : unknown) : void {
    const keys = path.split(".");
    const last = keys.pop() as string;

    if (keys.length === 0) {
        service.set(last, value);
    } else {
        objectAt(service, keys)[last] = value;
    }
}

/**
 * Add a value to a list key of the service
 * @param service Service keys
 * @param key Service key holding the list
 * @param value Value to add
 */
function append(service : Map<string, unknown>, key : string, value : unknown) : void {
    const list = service.get(key) as unknown[] | undefined;

    if (list) {
        list.push(value);
    } else {
        service.set(key, [ value ]);
    }
}

/**
 * A flag that is repeated into a list, such as `-p` into `ports`
 * @param key Service key
 * @returns Handler of the flag
 */
function list(key : string) : Handler {
    return (value, draft) => {
        append(draft.service, key, value);
        return CARRIED;
    };
}

/**
 * A flag with one value, where the last one written wins, as with docker
 * @param path Dotted path of the compose key
 * @param parse Turns the value into what compose expects, undefined when docker would refuse it
 * @returns Handler of the flag
 */
function set(path : string, parse : (value : string) => unknown = (value) => value) : Handler {
    return (value, draft) => {
        const parsed = parse(value);

        if (parsed === undefined) {
            return NOT_ACCEPTED;
        }

        setAt(draft.service, path, parsed);
        return CARRIED;
    };
}

/**
 * A whole number, the way docker reads one
 * @param value Value of the flag
 * @returns The number, or undefined for anything else
 */
function integer(value : string) : number | undefined {
    return INTEGER.test(value) ? Number(value) : undefined;
}

/**
 * A switch such as `--init`. Turned off with `=false`, it asks for what compose does anyway
 * @param path Dotted path of the compose key
 * @returns Handler of the flag
 */
function toggle(path : string) : Handler {
    return (value, draft) => {
        const on = parseSwitch(value);

        if (on === undefined) {
            return NOT_ACCEPTED;
        }

        if (!on) {
            return NOT_NEEDED;
        }

        setAt(draft.service, path, true);
        return CARRIED;
    };
}

/**
 * A switch compose cannot carry, such as `--rm`. Turned off, it asks for nothing
 * @param verdict What comes of the switch when it is on
 * @returns Handler of the flag
 */
function uncarried(verdict : Verdict) : Handler {
    return (value) => {
        const on = parseSwitch(value);

        return on === undefined ? NOT_ACCEPTED : on ? verdict : NOT_NEEDED;
    };
}

/**
 * A repeated `key=value` flag that compose keeps as a map, such as `--log-opt`
 * @param path Dotted path of the map
 * @returns Handler of the flag
 */
function keyValue(path : string) : Handler {
    return (value, draft) => {
        const [ key, entry ] = splitOnce(value, "=");

        if (key === "" || entry === undefined) {
            return NOT_ACCEPTED;
        }

        objectAt(draft.service, path.split("."))[key] = entry;
        return CARRIED;
    };
}

/**
 * A file compose reads when it loads the stack: the path is carried, the file is not
 * @param key Service key
 * @param reason Translation key saying where the file has to be
 * @returns Handler of the flag
 */
function file(key : string, reason : string) : Handler {
    return (value, draft) => {
        append(draft.service, key, value);
        return { outcome: "review",
            reason };
    };
}

/**
 * Declare a named volume the service uses, under the same name.
 *
 * External keeps the data of a container being migrated: without it compose
 * would create a new volume prefixed with the project name.
 * @param draft Draft of the file
 * @param name Name of the volume
 */
function declareVolume(draft : Draft, name : string) : void {
    draft.volumes.set(name, { external: true,
        name });
}

/**
 * `-v`: the short syntax is the same in compose, a named volume needs a declaration
 * @param value Value of the flag
 * @param draft Draft of the file
 * @returns What came of the flag
 */
function volume(value : string, draft : Draft) : Verdict {
    const [ source, target ] = splitOnce(value, ":");

    append(draft.service, "volumes", value);

    // A path is a bind mount and a lone target an anonymous volume: only a name is named
    if (target !== undefined && VOLUME_NAME.test(source)) {
        declareVolume(draft, source);
        return VOLUME_EXTERNAL;
    }

    return CARRIED;
}

/** Options of `--mount` with a key of their own in the long syntax, and docker's other spellings */
const MOUNT_KEYS : Record<string, string> = {
    type: "type",
    source: "source",
    src: "source",
    target: "target",
    destination: "target",
    dst: "target",
    consistency: "consistency",
};

/**
 * Put one option of `--mount` into the long syntax of compose
 * @param entry Keys of the volume entry
 * @param nested Sections of the entry, such as `bind`, written after its keys
 * @param key Option in lower case
 * @param option Value of the option, missing for a bare switch
 * @returns `refused` for what docker would refuse, `lost` for what compose has no place for
 */
function mountOption(entry : Record<string, unknown>, nested : Record<string, unknown>, key : string, option : string | undefined) : "carried" | "lost" | "refused" {
    if (key === "readonly" || key === "ro" || key === "volume-nocopy") {
        const on = parseSwitch(option ?? "true");

        if (on === undefined) {
            return "refused";
        }
        if (key === "volume-nocopy") {
            nested.volume = { nocopy: on };
        } else if (on) {
            entry.read_only = true;
        }
        return "carried";
    }

    const target = MOUNT_KEYS[key];

    if (option === undefined) {
        return "refused";
    } else if (target) {
        entry[target] = option;
    } else if (key === "bind-propagation") {
        nested.bind = { propagation: option };
    } else if (key === "tmpfs-size") {
        nested.tmpfs = { size: integer(option) ?? option };
    } else {
        return "lost";
    }

    return "carried";
}

/**
 * `--mount`: docker's options become the long syntax of compose, and an option
 * compose has no place for is reported instead of being written as a key it rejects
 * @param value Value of the flag
 * @param draft Draft of the file
 * @returns What came of the flag
 */
function mount(value : string, draft : Draft) : Verdict {
    const entry : Record<string, unknown> = { type: "volume" };
    const nested : Record<string, unknown> = {};
    let lost = false;

    for (const field of splitFields(value)) {
        const [ key, option ] = splitOnce(field, "=");
        const result = mountOption(entry, nested, key.trim().toLowerCase(), option);

        if (result === "refused") {
            return NOT_ACCEPTED;
        }
        lost ||= result === "lost";
    }

    // docker refuses a mount without a target, and so would compose
    if (entry.target === undefined) {
        return NOT_ACCEPTED;
    }

    append(draft.service, "volumes", { ...entry,
        ...nested });

    const named = entry.type === "volume" && typeof entry.source === "string" && VOLUME_NAME.test(entry.source);

    if (named) {
        declareVolume(draft, entry.source as string);
    }

    return lost ? OPTIONS_LOST : named ? VOLUME_EXTERNAL : CARRIED;
}

/**
 * `--gpus`: `all`, a count or a list of devices become a device reservation.
 * docker always asks for the `gpu` capability, and so does the reservation.
 * @param value Value of the flag
 * @param draft Draft of the file
 * @returns What came of the flag
 */
function gpus(value : string, draft : Draft) : Verdict {
    const notRead : Verdict = { outcome: "dropped",
        reason: "flagGpusDropped" };
    const count = (text : string) : string | number | undefined => text === "all" ? "all" : integer(text);
    let driver = "nvidia";
    let amount : string | number | undefined;
    let deviceIds : string[] | undefined;
    let capabilities = [ "gpu" ];

    for (const field of splitFields(value)) {
        const [ key, option ] = splitOnce(field, "=");

        if (option === undefined || key === "count") {
            amount = count(option ?? key);
            if (amount === undefined) {
                return notRead;
            }
        } else if (key === "device") {
            deviceIds = option.split(",").map((id) => id.trim()).filter((id) => id !== "");
        } else if (key === "driver") {
            driver = option;
        } else if (key === "capabilities") {
            capabilities = [ ...new Set([ ...option.split(",").map((name) => name.trim()), "gpu" ]) ];
        } else {
            return notRead;
        }
    }

    const selection = deviceIds ? { device_ids: deviceIds } : amount === undefined ? {} : { count: amount };
    const reservations = objectAt(draft.service, [ "deploy", "resources", "reservations" ]);
    const devices = (reservations.devices ??= []) as unknown[];

    devices.push({ driver,
        ...selection,
        capabilities });
    return CARRIED;
}

/**
 * `--ulimit name=soft[:hard]`: compose wants a map, with a number when both are the same
 * @param value Value of the flag
 * @param draft Draft of the file
 * @returns What came of the flag
 */
function ulimit(value : string, draft : Draft) : Verdict {
    const [ name, limits ] = splitOnce(value, "=");
    const [ soft, hard ] = splitOnce(limits ?? "", ":");

    if (name === "" || integer(soft) === undefined || (hard !== undefined && integer(hard) === undefined)) {
        return NOT_ACCEPTED;
    }

    objectAt(draft.service, [ "ulimits" ])[name] = hard === undefined ? Number(soft) : { soft: Number(soft),
        hard: Number(hard) };
    return CARRIED;
}

/**
 * How each flag docker knows becomes part of the compose file, by its long name.
 *
 * Every flag of `docker run --help` is listed, so that a flag is either carried or
 * named in the report: silence is what hides a broken service.
 */
const HANDLERS : Record<string, Handler> = {
    "--add-host": list("extra_hosts"),
    "--annotation": () => NOT_CONVERTED,
    "--attach": () => NOT_NEEDED,
    "--blkio-weight": () => NOT_CONVERTED,
    "--blkio-weight-device": () => NOT_CONVERTED,
    "--cap-add": list("cap_add"),
    "--cap-drop": list("cap_drop"),
    "--cgroup-parent": set("cgroup_parent"),
    "--cgroupns": set("cgroup"),
    "--cidfile": () => NO_EQUIVALENT,
    "--cpu-count": set("cpu_count", integer),
    "--cpu-percent": set("cpu_percent", integer),
    "--cpu-period": set("cpu_period", integer),
    "--cpu-quota": set("cpu_quota", integer),
    "--cpu-rt-period": set("cpu_rt_period", integer),
    "--cpu-rt-runtime": set("cpu_rt_runtime", integer),
    "--cpu-shares": set("cpu_shares", integer),
    "--cpus": set("cpus", (value) => DECIMAL.test(value) ? Number(value) : undefined),
    "--cpuset-cpus": set("cpuset"),
    "--cpuset-mems": () => NOT_CONVERTED,
    "--detach": () => NOT_NEEDED,
    "--detach-keys": () => NOT_NEEDED,
    "--device": list("devices"),
    "--device-cgroup-rule": list("device_cgroup_rules"),
    "--device-read-bps": () => NOT_CONVERTED,
    "--device-read-iops": () => NOT_CONVERTED,
    "--device-write-bps": () => NOT_CONVERTED,
    "--device-write-iops": () => NOT_CONVERTED,
    "--disable-content-trust": () => NOT_NEEDED,
    "--dns": list("dns"),
    "--dns-option": list("dns_opt"),
    "--dns-search": list("dns_search"),
    "--domainname": set("domainname"),
    // docker runs the entrypoint as one executable, and an empty one clears the image's
    "--entrypoint": set("entrypoint", (value) => value === "" ? [] : [ value ]),
    "--env": list("environment"),
    "--env-file": file("env_file", "flagEnvFileMustExist"),
    "--expose": list("expose"),
    "--gpus": gpus,
    "--group-add": list("group_add"),
    // A string test runs through the shell, as --health-cmd does
    "--health-cmd": set("healthcheck.test"),
    "--health-interval": set("healthcheck.interval"),
    "--health-retries": set("healthcheck.retries", integer),
    "--health-start-interval": set("healthcheck.start_interval"),
    "--health-start-period": set("healthcheck.start_period"),
    "--health-timeout": set("healthcheck.timeout"),
    "--help": () => NOT_NEEDED,
    "--hostname": set("hostname"),
    "--init": toggle("init"),
    "--interactive": toggle("stdin_open"),
    "--io-maxbandwidth": () => NOT_CONVERTED,
    "--io-maxiops": () => NOT_CONVERTED,
    "--ipc": set("ipc"),
    "--isolation": set("isolation"),
    "--kernel-memory": () => NO_EQUIVALENT,
    "--label": list("labels"),
    "--label-file": file("label_file", "flagLabelFileMustExist"),
    "--link": () => NOT_CONVERTED,
    "--link-local-ip": () => NOT_CONVERTED,
    "--log-driver": set("logging.driver"),
    "--log-opt": keyValue("logging.options"),
    "--mac-address": set("mac_address"),
    "--memory": set("mem_limit"),
    // compose refuses mem_reservation next to the reservations a GPU request writes
    "--memory-reservation": set("deploy.resources.reservations.memory"),
    // Unlimited is the number: Compose 2.38 refuses the string "-1" as a size, and every version takes -1
    "--memory-swap": set("memswap_limit", (value) => value === "-1" ? -1 : value),
    "--memory-swappiness": set("mem_swappiness", integer),
    "--mount": mount,
    "--name": set("container_name"),
    "--no-healthcheck": toggle("healthcheck.disable"),
    "--oom-kill-disable": toggle("oom_kill_disable"),
    "--oom-score-adj": set("oom_score_adj", integer),
    "--pid": set("pid"),
    "--pids-limit": set("pids_limit", integer),
    "--platform": set("platform"),
    "--privileged": toggle("privileged"),
    "--publish": list("ports"),
    "--publish-all": uncarried({ outcome: "dropped",
        reason: "flagPublishAllDropped" }),
    "--pull": set("pull_policy"),
    "--quiet": () => NOT_NEEDED,
    "--read-only": toggle("read_only"),
    "--restart": set("restart"),
    "--rm": uncarried({ outcome: "review",
        reason: "flagRmNotApplicable" }),
    "--runtime": set("runtime"),
    "--security-opt": list("security_opt"),
    "--shm-size": set("shm_size"),
    "--sig-proxy": () => NOT_NEEDED,
    "--stop-signal": set("stop_signal"),
    // docker counts seconds, compose wants a duration with its unit
    "--stop-timeout": set("stop_grace_period", (value) => /^\d+$/.test(value) ? `${value}s` : undefined),
    "--storage-opt": keyValue("storage_opt"),
    "--sysctl": list("sysctls"),
    "--tmpfs": list("tmpfs"),
    "--tty": toggle("tty"),
    "--ulimit": ulimit,
    "--umask": () => NO_EQUIVALENT,
    "--use-api-socket": () => NOT_CONVERTED,
    "--user": set("user"),
    "--userns": set("userns_mode"),
    "--uts": set("uts"),
    "--volume": volume,
    "--volume-driver": () => NOT_CONVERTED,
    // A bare name in volumes_from is a service of the stack, a container needs its prefix
    "--volumes-from": (value, draft) => {
        append(draft.service, "volumes_from", `container:${value}`);
        return CARRIED;
    },
    "--workdir": set("working_dir"),
};

/** Networks of the service, once every network flag is known */
interface NetworkResult {
    /** `network_mode`, when the command asked for one */
    mode? : string;

    /** Networks the service joins, with their options */
    attached : Map<string, Record<string, unknown>>;

    /** Networks that have to exist before the first start */
    external : string[];
}

/**
 * Aliases a network entry already has
 * @param options Options of the network entry
 * @returns Aliases, empty when there are none
 */
function aliasesOf(options : Record<string, unknown>) : string[] {
    return (options.aliases as string[] | undefined) ?? [];
}

/**
 * Read the value of `--network`, in the short form or as `name=...,alias=...`
 * @param value Value of the flag
 * @returns Name and options of the network, or undefined without a name
 */
function readNetwork(value : string) : { name : string, options : Record<string, unknown>, lost : boolean } | undefined {
    if (!value.includes("=")) {
        return value === "" ? undefined : { name: value,
            options: {},
            lost: false };
    }

    const options : Record<string, unknown> = {};
    let name : string | undefined;
    let lost = false;

    for (const field of splitFields(value)) {
        const [ key, option ] = splitOnce(field, "=");

        if (key === "name") {
            name = option;
        } else if (key === "alias" && option) {
            options.aliases = [ ...aliasesOf(options), option ];
        } else if ((key === "ip" || key === "ip6") && option) {
            options[key === "ip" ? "ipv4_address" : "ipv6_address"] = option;
        } else {
            lost = true;
        }
    }

    return name ? { name,
        options,
        lost } : undefined;
}

/**
 * Join the network one `--network` names, declared external under its own name
 * @param result Networks of the service so far
 * @param value Value of the flag
 * @returns What came of the flag
 */
function joinNetwork(result : NetworkResult, value : string | undefined) : Verdict {
    const network = value === undefined ? undefined : readNetwork(value);

    if (!network) {
        return NOT_ACCEPTED;
    }

    const options = result.attached.get(network.name) ?? {};
    const aliases = [ ...aliasesOf(options), ...aliasesOf(network.options) ];

    result.attached.set(network.name, { ...options,
        ...network.options,
        ...(aliases.length > 0 ? { aliases } : {}) });
    if (!result.external.includes(network.name)) {
        result.external.push(network.name);
    }

    return network.lost ? OPTIONS_LOST : NETWORK_EXTERNAL;
}

/**
 * Apply `--network-alias`, `--ip` or `--ip6` to the first named network.
 *
 * Without one an alias goes to the default network of the stack, where it works,
 * and an address is reported, because that network has no subnet of its own.
 * @param result Networks of the service, every `--network` already joined
 * @param entry The flag
 * @returns What came of the flag
 */
function applyNetworkOption(result : NetworkResult, entry : NetworkFlag) : Verdict {
    const first = result.external[0];

    if (entry.value === undefined) {
        return NOT_ACCEPTED;
    }

    if (entry.flag === "--network-alias") {
        const target = first ?? "default";
        const options = result.attached.get(target) ?? {};

        options.aliases = [ ...aliasesOf(options), entry.value ];
        result.attached.set(target, options);
        return CARRIED;
    }

    if (first === undefined) {
        return { outcome: "dropped",
            reason: "flagIpNeedsNetwork" };
    }

    (result.attached.get(first) as Record<string, unknown>)[entry.flag === "--ip" ? "ipv4_address" : "ipv6_address"] = entry.value;
    return CARRIED;
}

/**
 * Work out the networks of the service from every network flag at once.
 *
 * A mode excludes any network, as it does for docker. `--network-alias`, `--ip`
 * and `--ip6` belong to the first named network, as docker applies them.
 * @param flags Network flags in the order they were written
 * @param verdicts Verdicts by flag position, filled in here
 * @returns Networks of the service
 */
function connectNetworks(flags : NetworkFlag[], verdicts : Map<number, Verdict>) : NetworkResult {
    const result : NetworkResult = { attached: new Map(),
        external: [] };
    const mode = flags.find((entry) => entry.flag === "--network" && entry.value !== undefined && NETWORK_MODE.test(entry.value));

    if (mode) {
        for (const entry of flags) {
            verdicts.set(entry.index, entry === mode ? CARRIED : NOT_ACCEPTED);
        }
        return { ...result,
            mode: mode.value as string };
    }

    for (const entry of flags.filter((candidate) => candidate.flag === "--network")) {
        verdicts.set(entry.index, joinNetwork(result, entry.value));
    }

    for (const entry of flags.filter((candidate) => candidate.flag !== "--network")) {
        verdicts.set(entry.index, applyNetworkOption(result, entry));
    }

    return result;
}

/**
 * Service keys for the networks: a list when no network has options, a map otherwise
 * @param result Networks of the service
 * @returns Compose key and value, or nothing when the service joins no network
 */
function networkEntry(result : NetworkResult) : [ string, unknown ] | undefined {
    if (result.mode !== undefined) {
        return [ "network_mode", result.mode ];
    }

    if (result.attached.size === 0) {
        return undefined;
    }

    const plain = [ ...result.attached.values() ].every((options) => Object.keys(options).length === 0);

    return [ "networks", plain ? [ ...result.attached.keys() ] : Object.fromEntries(result.attached) ];
}

/**
 * Name of the service, taken from the image: `ghcr.io/org/app:1.2` becomes `app`
 * @param image Image as the command names it
 * @returns A name compose accepts for a service
 */
export function serviceNameFromImage(image : string) : string {
    const reference = image.split("@")[0] as string;
    const repository = reference.slice(reference.lastIndexOf("/") + 1).split(":")[0] as string;
    const name = repository.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");

    return name || "app";
}

/**
 * Whether compose will read a variable in a value that `docker run` got as is
 * @param value Value as it was written
 * @returns True when a `$` is not escaped as `$$`
 */
function interpolates(value : string) : boolean {
    return value.replace(/\$\$/g, "").includes("$");
}

/**
 * Turn a `docker run` command into a compose file with one service.
 *
 * Every flag either lands in the file or is named in the report, and nothing is
 * added that the command did not ask for: no `version`, no network, no
 * `container_name` without `--name`. A `$` stays as it was written, since the
 * person may mean a variable, and the report asks them to look.
 * @param command Command as the person typed or pasted it
 * @returns The compose file and the report, or undefined when the command names no image
 */
export function convertDockerRunCommand(command : string) : DockerRunConversion | undefined {
    const { flags, image, args } = parseDockerRun(command);

    if (image === undefined) {
        return undefined;
    }

    const draft : Draft = { service: new Map<string, unknown>([[ "image", image ]]),
        volumes: new Map() };
    const verdicts = new Map<number, Verdict>();
    const networkFlags : NetworkFlag[] = [];

    flags.forEach((parsed, index) => {
        const flag = canonicalFlag(parsed.flag);
        const handler = HANDLERS[flag];

        if (NETWORK_FLAGS.has(flag)) {
            // The place of the network keys is where the first network flag was written
            if (!draft.service.has("networks")) {
                draft.service.set("networks", undefined);
            }
            networkFlags.push({ index,
                flag,
                ...(parsed.value === undefined ? {} : { value: parsed.value }) });
            return;
        }

        const value = parsed.value ?? (takesValue(flag) ? undefined : "true");

        verdicts.set(index, !handler ? UNKNOWN : value === undefined ? NOT_ACCEPTED : handler(value, draft));
    });

    const networks = connectNetworks(networkFlags, verdicts);
    const service : Record<string, unknown> = {};

    for (const [ key, value ] of draft.service) {
        if (key !== "networks") {
            service[key] = value;
            continue;
        }

        const entry = networkEntry(networks);

        if (entry) {
            service[entry[0]] = entry[1];
        }
    }

    if (args.length > 0) {
        // A list is what the shell handed to docker, so compose does not split it again
        service.command = args;
    }

    const compose : Record<string, unknown> = { services: { [serviceNameFromImage(image)]: service } };

    if (networks.external.length > 0) {
        compose.networks = Object.fromEntries(networks.external.map((name) => [ name, { external: true,
            name }]));
    }

    if (draft.volumes.size > 0) {
        compose.volumes = Object.fromEntries(draft.volumes);
    }

    const report : ConversionReport = { carried: [],
        review: [],
        dropped: [] };

    flags.forEach((parsed, index) => {
        let verdict = verdicts.get(index) ?? UNKNOWN;

        if (verdict === CARRIED && parsed.value !== undefined && interpolates(parsed.value)) {
            verdict = DOLLAR;
        }

        report[verdict.outcome].push(reportItem(parsed.flag, parsed.value, verdict));
    });

    // The shell gave docker the image and the arguments as they are, compose reads `$` in them
    if (interpolates(image)) {
        report.review.push(reportItem("image", image, DOLLAR));
    }

    if (args.some(interpolates)) {
        report.review.push(reportItem("command", args.join(" "), DOLLAR));
    }

    return {
        // YAML 1.1 quoting keeps `no`, `on` and `22:22` strings for every reader of the file
        compose: stringify(compose, { version: "1.1",
            lineWidth: 0,
            aliasDuplicateObjects: false }),
        report,
    };
}

/**
 * One line of the report
 * @param flag Flag as it was written
 * @param value Value of the flag, when it had one
 * @param verdict What came of it
 * @returns Line of the report
 */
function reportItem(flag : string, value : string | undefined, verdict : Verdict) : FlagReportItem {
    return { flag,
        ...(value === undefined ? {} : { value }),
        outcome: verdict.outcome,
        ...(verdict.reason ? { reason: verdict.reason } : {}) };
}
