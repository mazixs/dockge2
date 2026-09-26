import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "./child-process";
import { log } from "./log";
import { runInBackground } from "./background";
import { COMPOSE_PROJECT_LABEL } from "../common/compose-status";
import {
    canCancelPanelUpdate,
    derivePanelUpdateOperation,
    PANEL_UPDATE_LABELS,
    PANEL_UPDATE_PREVIEW_TTL_MS,
    PANEL_UPDATE_REQUEST_PATTERN,
    PANEL_VERSION_PATTERN,
    panelUpdateHelperName,
    parsePanelUpdateLine,
    type PanelUpdateErrorCode,
    type PanelUpdateHelper,
    type PanelUpdateJournalLine,
    type PanelUpdateKind,
    type PanelUpdateLine,
    type PanelUpdateManualReason,
    type PanelUpdateOperation,
    type PanelUpdateResultLine,
    type PanelUpdateStatus,
} from "../common/panel-update";

/**
 * Updating the panel from the web interface: the observer on the server side.
 * See docs/panel-update-statechart.md, sections 3 and 4.
 *
 * The panel is the thing being replaced, so nothing here is the truth: every status is
 * derived again from the helper containers of this installation, and what is kept in
 * memory only saves asking Docker the same question twice.
 */

const COMPOSE_WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const HOSTNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DATA_TARGET = "/app/data";
const SOCKET_TARGET = "/var/run/docker.sock";
const BIND_SOURCE_MISSING = /bind (mount )?source path does not exist/i;
const NAME_CONFLICT = /Conflict\.|is already in use/i;
const NO_SUCH_CONTAINER = /no such (container|object)/i;
const ACTIVE_STATES : ReadonlySet<string> = new Set([ "running", "restarting", "paused" ]);

const DOCKER_TIMEOUT_MS = 30_000;
const STATUS_HELPER_TIMEOUT_MS = 60_000;
const LOG_MAX_BUFFER = 4 * 1024 * 1024;

/** How long a failed inspection or journal read is remembered before Docker is asked again */
const RETRY_MS = 30_000;

/** A log stream that ends sooner than this is not reopened before this much time passed */
const FOLLOW_RETRY_MS = 5_000;

/** A container created this recently and not started yet is still being started by `docker run` */
const STARTING_GRACE_MS = 60_000;

/** What one Docker command answered. A failure is an answer, never an exception. */
export interface DockerResult {
    /** Exit code; -1 when the command could not run or was killed */
    code : number;
    stdout : string;
    stderr : string;
}

export interface DockerRunOptions {
    timeoutMs? : number;
    maxBuffer? : number;
}

/** Runs `docker` with an argument array. Never through a shell. */
export type DockerRunner = (args : readonly string[], options? : DockerRunOptions) => Promise<DockerResult>;

/** A `docker logs --follow` in progress */
export interface DockerFollow {
    /** Settles when the stream ends: the container exited, or the follow was stopped */
    done : Promise<void>;
    stop() : void;
}

/** Follows the stdout of a Docker command line by line */
export type DockerFollower = (args : readonly string[], onLine : (line : string) => void) => DockerFollow;

/** Everything the panel has to know about its own installation to start a helper */
export interface PanelInstallation {
    /** Host path of the Compose project, from the label the updater checks too */
    installDir : string;
    project : string;
    /** Image of the panel's own container: the helper runs the same docker CLI */
    imageId : string;
    /** Host source of the `/app/data` bind */
    dataDir : string;
    /** Host source of the Docker socket bind */
    dockerSocket : string;
}

/** What the panel found out about itself */
export interface PanelDiscovery {
    managed : "yes" | "no" | "unknown";
    reason? : PanelUpdateManualReason;
    /** Known once the Compose label was read, also when the installation is not usable */
    installDir? : string;
    installation? : PanelInstallation;
}

/** Where discovery looks, injected so the tests need neither Docker nor a container */
export interface DiscoveryEnvironment {
    docker : DockerRunner;
    hostname : string;
    /** Contents of a file under /proc, undefined when it cannot be read */
    readProcFile : (file : string) => Promise<string | undefined>;
    /** Signs outside of /proc that this process runs in a container */
    containerHint : boolean;
}

/** One helper launch: which kind, for which request, between which versions */
export interface HelperLaunch {
    kind : PanelUpdateKind;
    requestId : string;
    from : string;
    to : string;
    startedAt : string;
}

export interface PanelUpdateOptions {
    /** Version of the running panel */
    version : string;
    docker? : DockerRunner;
    follow? : DockerFollower;
    discover? : () => Promise<PanelDiscovery>;
    /** Told about every status that differs from the one told before */
    publish? : (status : PanelUpdateStatus) => void;
    now? : () => number;
}

/** A refused action; the message is the catalogue key the page shows */
export class PanelUpdateError extends Error {
    readonly code : PanelUpdateErrorCode;

    /**
     * @param code Code the page decides its screen by
     * @param message Catalogue key, `panelUpdateError.<code>` unless a more precise one exists
     */
    constructor(code : PanelUpdateErrorCode, message = `panelUpdateError.${code}`) {
        super(message);
        this.code = code;
    }
}

/** What `docker inspect` says about a container, as far as this module reads it */
interface InspectedContainer {
    Id? : unknown;
    Name? : unknown;
    Image? : unknown;
    Created? : unknown;
    Config? : { Hostname? : unknown; Labels? : Record<string, unknown> | null };
    State? : { Status? : unknown; Running? : unknown; ExitCode? : unknown; StartedAt? : unknown; FinishedAt? : unknown; Error? : unknown };
    Mounts? : unknown;
}

interface HelperRecord {
    id : string;
    helper : PanelUpdateHelper;
}

interface Reading {
    status : PanelUpdateStatus;
    records : HelperRecord[];
    /** False when Docker did not answer; such a status is never pushed */
    readable : boolean;
}

interface JournalEntry {
    journal : PanelUpdateJournalLine | undefined;
    at : number;
    /** The updater answered; otherwise Docker never ran it and it is asked again later */
    final : boolean;
}

/**
 * Run docker and capture its output, without a shell
 * @param args Docker arguments
 * @param options Timeout and output limit
 * @returns Exit code and output, also when the command failed
 */
export async function runDocker(args : readonly string[], options : DockerRunOptions = {}) : Promise<DockerResult> {
    try {
        const res = await spawn("docker", args, {
            encoding: "utf-8",
            maxBuffer: options.maxBuffer ?? 1024 * 1024,
            timeoutMs: options.timeoutMs ?? DOCKER_TIMEOUT_MS,
        });
        return {
            code: res.code ?? -1,
            stdout: String(res.stdout ?? ""),
            stderr: String(res.stderr ?? ""),
        };
    } catch (error) {
        const failure = error as Error & { code? : unknown; stdout? : unknown; stderr? : unknown };
        // A timed out docker may still exit with a code of its own after the signal
        const stopped = /timed out|maxBuffer/.test(failure.message);
        return {
            code: typeof failure.code === "number" && !stopped ? failure.code : -1,
            stdout: String(failure.stdout ?? ""),
            stderr: String(failure.stderr ?? "") || failure.message,
        };
    }
}

/**
 * Follow the stdout of a docker command line by line. Its stderr is human text and dropped.
 * @param args Docker arguments, `logs --follow <id>`
 * @param onLine Called with every line
 * @returns The stream in progress
 */
export function followDocker(args : readonly string[], onLine : (line : string) => void) : DockerFollow {
    const child = spawnProcess("docker", args, { stdio: [ "ignore", "pipe", "ignore" ] });
    const lines = createInterface({ input: child.stdout,
        crlfDelay: Infinity });
    lines.on("line", onLine);
    const done = new Promise<void>((resolve) => {
        child.once("error", () => resolve());
        child.once("close", () => resolve());
    });
    return {
        done,
        stop: () => {
            child.kill("SIGTERM");
        },
    };
}

/**
 * A host path that can be named in a label, a command and a mount: absolute, normalised,
 * not the root and without control characters
 * @param value Value read from Docker
 * @returns Whether it is such a path
 */
function isUsablePath(value : unknown) : value is string {
    return typeof value === "string" && value.startsWith("/") && value !== "/" && !value.endsWith("/") && path.posix.normalize(value) === value && !CONTROL_CHARACTERS.test(value);
}

/**
 * `--mount` is a comma separated list, so a comma or a quote in a path would change the mount
 * @param value Usable path
 * @returns Whether it can go into a `--mount` value as it is
 */
function isMountable(value : string) : boolean {
    return !/[,"]/.test(value);
}

/**
 * Read the JSON array `docker inspect` prints
 * @param stdout Output of the command
 * @returns The containers, or undefined when the output is not such an array
 */
function parseInspect(stdout : string) : InspectedContainer[] | undefined {
    try {
        const value : unknown = JSON.parse(stdout);
        if (!Array.isArray(value)) {
            return undefined;
        }
        return value.filter((item) : item is InspectedContainer => typeof item === "object" && item !== null);
    } catch {
        return undefined;
    }
}

/**
 * Whether a container ever ran: Docker keeps the zero time as `StartedAt` until it does
 * @param state `State` of the inspected container
 * @returns Whether it runs or ran
 */
function everStarted(state : InspectedContainer["State"]) : boolean {
    const startedAt = state?.StartedAt;
    return state?.Running === true || (typeof startedAt === "string" && !startedAt.startsWith("0001-"));
}

/**
 * The id of the container this process runs in, as the kernel shows it
 * @param mountinfo Contents of /proc/self/mountinfo
 * @param cgroup Contents of /proc/self/cgroup
 * @returns Full container id, or undefined outside of a Docker container
 */
export function containerIdFromProc(mountinfo : string | undefined, cgroup : string | undefined) : string | undefined {
    // Docker binds /etc/hostname, /etc/hosts and /etc/resolv.conf from the container's own directory
    const fromMounts = mountinfo?.match(/\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)\s/);
    if (fromMounts?.[1]) {
        return fromMounts[1];
    }
    // cgroup v1 only: under v2 the file says "0::/"
    return cgroup?.match(/docker[-/]([0-9a-f]{64})(?:\.scope)?\s*$/m)?.[1];
}

/**
 * Whether an inspected container is really this process. A name is resolved by the daemon
 * and can belong to anything, so the answer is checked against what the kernel says.
 * @param container Inspected container
 * @param hostname Hostname of this process
 * @param ownId Container id from /proc, when known
 * @returns Whether it is the panel's own container
 */
function isOwnContainer(container : InspectedContainer, hostname : string, ownId : string | undefined) : boolean {
    const id = typeof container.Id === "string" ? container.Id : "";
    if (!CONTAINER_ID_PATTERN.test(id)) {
        return false;
    }
    if (ownId) {
        return id === ownId;
    }
    if (/^[0-9a-f]{12}$/.test(hostname)) {
        return id.startsWith(hostname);
    }
    return container.Config?.Hostname === hostname;
}

/**
 * Inspect the panel's own container: by hostname first, then by the id from /proc
 * @param env Where to look
 * @param ownId Container id from /proc, when known
 * @returns The container, "unreadable" when Docker did not answer, undefined when none matched
 */
async function inspectOwnContainer(env : DiscoveryEnvironment, ownId : string | undefined) : Promise<InspectedContainer | "unreadable" | undefined> {
    const candidates = [ ...new Set([ env.hostname, ownId ]) ].filter((name) : name is string => typeof name === "string" && HOSTNAME_PATTERN.test(name));
    let unreadable = false;
    for (const candidate of candidates) {
        const res = await env.docker([ "inspect", "--type", "container", candidate ], { timeoutMs: 15_000 });
        if (res.code !== 0) {
            unreadable ||= !NO_SUCH_CONTAINER.test(res.stderr);
            continue;
        }
        const container = parseInspect(res.stdout)?.[0];
        if (!container) {
            unreadable = true;
        } else if (isOwnContainer(container, env.hostname, ownId)) {
            return container;
        }
    }
    return unreadable ? "unreadable" : undefined;
}

/**
 * Host source of the bind mounted at a destination
 * @param container Inspected container
 * @param destination Path inside the container
 * @returns The host path, or undefined when it is not a bind or not a usable path
 */
function bindSource(container : InspectedContainer, destination : string) : string | undefined {
    if (!Array.isArray(container.Mounts)) {
        return undefined;
    }
    const mount = (container.Mounts as { Type? : unknown; Source? : unknown; Destination? : unknown }[]).find((item) => item?.Destination === destination);
    if (mount?.Type !== "bind" || !isUsablePath(mount.Source) || !isMountable(mount.Source)) {
        return undefined;
    }
    return mount.Source;
}

/**
 * What the panel's own container says about the installation
 * @param container The panel's own container
 * @returns Discovery result
 */
function describeInstallation(container : InspectedContainer) : PanelDiscovery {
    const labels = container.Config?.Labels ?? {};
    const installDir = labels[COMPOSE_WORKING_DIR_LABEL];
    const project = labels[COMPOSE_PROJECT_LABEL];
    if (!isUsablePath(installDir) || typeof project !== "string" || !PROJECT_PATTERN.test(project)) {
        return { managed: "no",
            reason: "no-installation" };
    }
    const dataDir = bindSource(container, DATA_TARGET);
    const dockerSocket = bindSource(container, SOCKET_TARGET);
    if (!isMountable(installDir) || !dataDir || !dockerSocket) {
        return { managed: "no",
            reason: "unsupported",
            installDir };
    }
    const imageId = container.Image;
    if (typeof imageId !== "string" || !IMAGE_ID_PATTERN.test(imageId)) {
        return { managed: "unknown",
            reason: "unreadable",
            installDir };
    }
    return {
        managed: "yes",
        installDir,
        installation: { installDir,
            project,
            imageId,
            dataDir,
            dockerSocket },
    };
}

/**
 * Find the panel's own container and read its installation from it.
 *
 * Outside of a container nothing is asked of Docker: tests and development runs simply
 * read "not managed".
 * @param env Where to look
 * @returns What the panel found out about itself
 */
export async function discoverPanelInstallation(env : DiscoveryEnvironment) : Promise<PanelDiscovery> {
    const ownId = containerIdFromProc(await env.readProcFile("/proc/self/mountinfo"), await env.readProcFile("/proc/self/cgroup"));
    if (!ownId && !env.containerHint) {
        return { managed: "no",
            reason: "not-container" };
    }
    const container = await inspectOwnContainer(env, ownId);
    if (container === "unreadable") {
        return { managed: "unknown",
            reason: "unreadable" };
    }
    if (!container) {
        return { managed: "no",
            reason: "not-container" };
    }
    return describeInstallation(container);
}

/**
 * The environment discovery looks at in a running panel
 * @param docker Docker runner
 * @returns Discovery environment of this process
 */
export function processDiscoveryEnvironment(docker : DockerRunner) : DiscoveryEnvironment {
    return {
        docker,
        hostname: os.hostname(),
        readProcFile: (file) => readFile(file, "utf8").catch(() => undefined),
        containerHint: process.env.DOCKGE_IS_CONTAINER === "1" || existsSync("/.dockerenv"),
    };
}

/**
 * A bind mount at the same path, written for `--mount`, which refuses a missing source
 * instead of creating it on the host as `-v` would
 * @param source Host path
 * @param target Path in the helper
 * @param readonly Whether the helper may only read it
 * @returns Value of `--mount`
 */
function bind(source : string, target : string, readonly : boolean) : string {
    return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
}

/**
 * Arguments of `docker run` for one helper. Everything is fixed except the version, which
 * the caller has checked against `PANEL_VERSION_PATTERN`, and the request id, which only
 * becomes a label.
 * @param installation The panel's installation
 * @param launch What to run
 * @returns Arguments for the docker CLI
 */
export function panelUpdateRunArgs(installation : PanelInstallation, launch : HelperLaunch) : string[] {
    const dir = installation.installDir;
    const updaterDir = path.posix.join(dir, ".dockge2");
    const status = launch.kind === "status";
    const labels : [ string, string ][] = [
        [ PANEL_UPDATE_LABELS.request, launch.requestId ],
        [ PANEL_UPDATE_LABELS.kind, launch.kind ],
        [ PANEL_UPDATE_LABELS.installation, dir ],
        [ PANEL_UPDATE_LABELS.from, launch.from ],
        [ PANEL_UPDATE_LABELS.to, launch.to ],
        [ PANEL_UPDATE_LABELS.started, launch.startedAt ],
    ];
    const updaterArgs = {
        preview: [ "--progress", "json", "--version", launch.to, "--dry-run" ],
        apply: [ "--progress", "json", "--version", launch.to, "--yes", "--restore-on-failed-start" ],
        status: [ "--progress", "json", "--status" ],
    }[launch.kind];
    return [
        "run",
        // The status helper is read once and attached; the others outlive the panel
        status ? "--rm" : "-d",
        "--name", panelUpdateHelperName(installation.project, launch.kind),
        "--restart", "no",
        "--pull", "never",
        "--user", "0:0",
        "--log-driver", "json-file",
        "--log-opt", "max-size=1m",
        ...labels.flatMap(([ key, value ]) => [ "--label", `${key}=${value}` ]),
        "--mount", bind(dir, dir, true),
        "--mount", bind(updaterDir, updaterDir, status),
        "--mount", bind(installation.dataDir, installation.dataDir, true),
        "--mount", bind("/tmp", "/tmp", false),
        "--mount", bind(installation.dockerSocket, SOCKET_TARGET, false),
        "--entrypoint", path.posix.join(updaterDir, "update"),
        installation.imageId,
        ...updaterArgs,
    ];
}

/**
 * A request id the page generated
 * @param value Argument of an event
 * @returns The request id
 * @throws {PanelUpdateError} `invalid` when it is not one
 */
export function requirePanelUpdateRequest(value : unknown) : string {
    if (typeof value !== "string" || !PANEL_UPDATE_REQUEST_PATTERN.test(value)) {
        throw new PanelUpdateError("invalid");
    }
    return value;
}

/**
 * A version the browser named
 * @param value Argument of an event
 * @returns The version
 * @throws {PanelUpdateError} `invalid` when it is not one
 */
export function requirePanelVersion(value : unknown) : string {
    if (typeof value !== "string" || value.length > 64 || !PANEL_VERSION_PATTERN.test(value)) {
        throw new PanelUpdateError("invalid");
    }
    return value;
}

/**
 * The status as a user who is not an owner may see it: without the installation path and
 * without the updater's error texts
 * @param status Full status
 * @param owner Whether the receiver is an owner
 * @returns The status to send
 */
export function redactPanelUpdateStatus(status : PanelUpdateStatus, owner : boolean) : PanelUpdateStatus {
    if (owner) {
        return status;
    }
    const panel = { ...status.panel };
    delete panel.installDir;
    const redacted : PanelUpdateStatus = { schema: 1,
        panel };
    if (status.operation) {
        const operation = { ...status.operation };
        if (operation.result) {
            const result = { ...operation.result };
            delete result.error;
            operation.result = result;
        }
        redacted.operation = operation;
    }
    return redacted;
}

/**
 * Parse the stdout of a helper; human text, foreign and overlong lines are dropped
 * @param stdout Output of `docker logs` or of an attached run
 * @returns Parsed lines in order
 */
function parseLines(stdout : string) : PanelUpdateLine[] {
    return stdout.split("\n").map((line) => parsePanelUpdateLine(line.replace(/\r$/, ""))).filter((line) : line is PanelUpdateLine => line !== undefined);
}

function firstLine(text : string) : string {
    return text.trim().split("\n")[0] ?? "";
}

function isKind(value : unknown) : value is PanelUpdateKind {
    return value === "preview" || value === "apply" || value === "status";
}

/**
 * Running, exit code, end and start error of a helper, from its Docker state
 * @param state `State` of the inspected container
 * @param created `Created` of the inspected container
 * @param now Current time
 * @returns The state fields of the helper
 */
function helperState(state : InspectedContainer["State"], created : unknown, now : number) : Pick<PanelUpdateHelper, "running" | "exitCode" | "finishedAt" | "startError"> {
    const status = typeof state?.Status === "string" ? state.Status : "";
    const error = typeof state?.Error === "string" ? state.Error : "";
    const createdAt = typeof created === "string" ? Date.parse(created) : NaN;
    // `docker run -d` creates first and starts after; in between the helper is starting
    const starting = status === "created" && !error && now - createdAt < STARTING_GRACE_MS;
    if (state?.Running === true || ACTIVE_STATES.has(status) || starting) {
        return { running: true };
    }
    const result : Pick<PanelUpdateHelper, "running" | "exitCode" | "finishedAt" | "startError"> = { running: false };
    if (typeof state?.ExitCode === "number") {
        result.exitCode = state.ExitCode;
    }
    if (typeof state?.FinishedAt === "string" && !state.FinishedAt.startsWith("0001-")) {
        result.finishedAt = state.FinishedAt;
    }
    if (error) {
        result.startError = error;
    } else if (status === "created") {
        result.startError = "the helper was created and never started";
    }
    return result;
}

/**
 * A helper of this installation, or undefined for anything else carrying the labels
 * @param raw Inspected container
 * @param installation The panel's installation
 * @param now Current time
 * @returns The helper and its container id
 */
function toRecord(raw : InspectedContainer, installation : PanelInstallation, now : number) : HelperRecord | undefined {
    const labels = raw.Config?.Labels ?? {};
    const kind = labels[PANEL_UPDATE_LABELS.kind];
    const requestId = labels[PANEL_UPDATE_LABELS.request];
    const from = labels[PANEL_UPDATE_LABELS.from];
    const to = labels[PANEL_UPDATE_LABELS.to];
    const startedAt = labels[PANEL_UPDATE_LABELS.started];
    if (typeof raw.Id !== "string" || !CONTAINER_ID_PATTERN.test(raw.Id) || !isKind(kind)
        || raw.Name !== `/${panelUpdateHelperName(installation.project, kind)}`
        || labels[PANEL_UPDATE_LABELS.installation] !== installation.installDir
        || typeof requestId !== "string" || !PANEL_UPDATE_REQUEST_PATTERN.test(requestId)
        || typeof from !== "string" || typeof to !== "string" || typeof startedAt !== "string") {
        return undefined;
    }
    return {
        id: raw.Id,
        helper: { kind,
            requestId,
            from,
            to,
            startedAt,
            ...helperState(raw.State, raw.Created, now) },
    };
}

function findKind(records : readonly HelperRecord[], kind : PanelUpdateKind) : HelperRecord | undefined {
    return records.find((record) => record.helper.kind === kind);
}

function panelOf(version : string, discovery : PanelDiscovery) : PanelUpdateStatus["panel"] {
    const panel : PanelUpdateStatus["panel"] = { version,
        managed: discovery.managed };
    if (discovery.reason) {
        panel.reason = discovery.reason;
    }
    if (discovery.installDir) {
        panel.installDir = discovery.installDir;
    }
    return panel;
}

function describeError(error : unknown) : string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Starts the helpers that run the installed updater, follows them and derives the status.
 * One instance per process; see the module comment for why it holds no state of its own.
 */
export class PanelUpdate {
    readonly version : string;
    protected readonly docker : DockerRunner;
    protected readonly followLogs : DockerFollower;
    protected readonly discoverInstallation : () => Promise<PanelDiscovery>;
    protected readonly publish : (status : PanelUpdateStatus) => void;
    protected readonly now : () => number;

    private discovery : Promise<PanelDiscovery> | undefined;
    private discoveryExpires = Infinity;
    /** `<dir>/.dockge2/update` could not be started; stays until the process restarts */
    private updaterMissing = false;
    private readonly followers = new Map<string, DockerFollow>();
    /** Container id -> not before, for log streams that ended at once */
    private readonly followBackoff = new Map<string, number>();
    /** Output of finished helpers, which does not change any more */
    private readonly finishedLines = new Map<string, PanelUpdateLine[]>();
    /** Request id -> what the status helper read from the journal */
    private readonly journals = new Map<string, JournalEntry>();
    private readonly journalReads = new Map<string, Promise<PanelUpdateJournalLine | undefined>>();
    private retryTimer : NodeJS.Timeout | undefined;
    private refreshing : Promise<void> | undefined;
    private refreshAgain = false;
    private pendingStatus : Promise<PanelUpdateStatus> | undefined;
    private lastPublished : string | undefined;
    private actions : Promise<unknown> = Promise.resolve();
    private stopped = false;

    /**
     * @param options Version of the panel, and the Docker access the tests replace
     */
    constructor(options : PanelUpdateOptions) {
        this.version = options.version;
        this.docker = options.docker ?? runDocker;
        this.followLogs = options.follow ?? followDocker;
        this.discoverInstallation = options.discover ?? (() => discoverPanelInstallation(processDiscoveryEnvironment(this.docker)));
        this.publish = options.publish ?? (() => undefined);
        this.now = options.now ?? Date.now;
    }

    /**
     * Inspect the helpers once and follow a running one. A panel that starts during an
     * update is usually the new version, while the helper still verifies it.
     * @returns {Promise<void>}
     */
    async start() : Promise<void> {
        this.stopped = false;
        await this.refresh();
    }

    /**
     * Stop following. The helpers themselves are never stopped: they outlive the panel.
     * @returns {void}
     */
    stop() : void {
        this.stopped = true;
        for (const follow of this.followers.values()) {
            follow.stop();
        }
        this.followers.clear();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = undefined;
        }
    }

    /**
     * The status as Docker shows it now. Callers asking at the same time share one reading.
     * @returns The full status; the caller redacts it for the receiver
     */
    status() : Promise<PanelUpdateStatus> {
        this.pendingStatus ??= this.observe().finally(() => {
            this.pendingStatus = undefined;
        });
        return this.pendingStatus;
    }

    /**
     * Start a dry run of a version. A finished dry run is replaced; anything else running is not.
     * @param requestId Request id from the page
     * @param version Version to check
     * @returns The status right after the helper started
     * @throws {PanelUpdateError} invalid, unmanaged, busy, updater-missing, start-failed
     */
    async preview(requestId : unknown, version : unknown) : Promise<PanelUpdateStatus> {
        const request = requirePanelUpdateRequest(requestId);
        const target = requirePanelVersion(version);
        return this.serialized(async () => {
            const { installation, records } = await this.requireManaged();
            const preview = findKind(records, "preview");
            if (findKind(records, "apply") || preview?.helper.running) {
                throw new PanelUpdateError("busy");
            }
            if (preview) {
                await this.remove(preview, "busy");
            }
            await this.launch(installation, "preview", request, target);
            return this.observe();
        });
    }

    /**
     * Start the update itself. The owner's password is checked by the caller before this.
     * @param requestId Request id from the page for this update
     * @param previewRequestId Request id of the dry run it confirms
     * @param version Version to install; has to be the target of that dry run
     * @returns The status right after the helper started
     * @throws {PanelUpdateError} invalid, unmanaged, busy, stale-preview, updater-missing, start-failed
     */
    async apply(requestId : unknown, previewRequestId : unknown, version : unknown) : Promise<PanelUpdateStatus> {
        const request = requirePanelUpdateRequest(requestId);
        const previewRequest = requirePanelUpdateRequest(previewRequestId);
        const target = requirePanelVersion(version);
        if (request === previewRequest) {
            throw new PanelUpdateError("invalid");
        }
        return this.serialized(async () => {
            const { installation, records } = await this.requireManaged();
            // A finished apply is a result somebody has to see, so it is dismissed first
            if (findKind(records, "apply")) {
                throw new PanelUpdateError("busy");
            }
            const preview = findKind(records, "preview");
            await this.requireFreshPreview(preview, previewRequest, target);
            await this.launch(installation, "apply", request, target);
            // The update consumed its dry run
            if (preview) {
                await this.remove(preview, "busy").catch((error) => log.warn("panel-update", `Could not remove the consumed dry run: ${describeError(error)}`));
            }
            return this.observe();
        });
    }

    /**
     * Ask a running helper to stop, while that still changes nothing: a dry run always,
     * an update only before the image was downloaded
     * @param requestId Request id of the operation
     * @returns The status right after the signal
     * @throws {PanelUpdateError} invalid, not-found, too-late, unreadable
     */
    async cancel(requestId : unknown) : Promise<PanelUpdateStatus> {
        const request = requirePanelUpdateRequest(requestId);
        const record = await this.requireRecord(request);
        if (!record.helper.running) {
            throw new PanelUpdateError("too-late");
        }
        if (record.helper.kind === "apply") {
            // Read at this moment, not from what was pushed: the phase may have moved on
            const operation = derivePanelUpdateOperation(record.helper, await this.readLines(record), this.version);
            if (!canCancelPanelUpdate(operation.phase)) {
                throw new PanelUpdateError("too-late");
            }
        }
        // SIGTERM only. `docker stop` would follow with SIGKILL after ten seconds and could
        // kill the updater in the middle of its recovery
        const res = await this.docker([ "kill", "--signal", "TERM", record.id ], { timeoutMs: DOCKER_TIMEOUT_MS });
        if (res.code !== 0) {
            throw new PanelUpdateError(/not running|no such container/i.test(res.stderr) ? "too-late" : "unreadable");
        }
        log.info("panel-update", `Asked the ${record.helper.kind} helper of request ${request} to stop`);
        return this.observe();
    }

    /**
     * Remove a finished helper, so its result is not shown any more and the next one may start
     * @param requestId Request id of the operation
     * @returns The status after the removal
     * @throws {PanelUpdateError} invalid, not-found, running, unreadable
     */
    async dismiss(requestId : unknown) : Promise<PanelUpdateStatus> {
        const request = requirePanelUpdateRequest(requestId);
        return this.serialized(async () => {
            const record = await this.requireRecord(request);
            if (record.helper.running) {
                throw new PanelUpdateError("running");
            }
            await this.remove(record, "running");
            this.journals.delete(request);
            return this.observe();
        });
    }

    /**
     * Read the status again, follow what runs and push the status if it changed.
     * Calls that arrive while one runs are folded into one more round.
     * @returns {Promise<void>}
     */
    refresh() : Promise<void> {
        if (this.refreshing) {
            this.refreshAgain = true;
            return this.refreshing;
        }
        this.refreshing = (async () => {
            try {
                do {
                    this.refreshAgain = false;
                    await this.observe().catch((error) => log.error("panel-update", describeError(error)));
                } while (this.refreshAgain && !this.stopped);
            } finally {
                this.refreshing = undefined;
            }
        })();
        return this.refreshing;
    }

    /**
     * Discovery, once per process. An unreadable answer is asked again after a while.
     * @returns What the panel knows about its installation
     */
    protected async discover() : Promise<PanelDiscovery> {
        if (!this.discovery || this.now() >= this.discoveryExpires) {
            this.discoveryExpires = Infinity;
            this.discovery = this.discoverInstallation().catch((error) : PanelDiscovery => {
                log.warn("panel-update", `Cannot inspect the panel's own container: ${describeError(error)}`);
                return { managed: "unknown",
                    reason: "unreadable" };
            });
        }
        const discovery = await this.discovery;
        if (discovery.reason === "unreadable" && this.discoveryExpires === Infinity) {
            this.discoveryExpires = this.now() + RETRY_MS;
        }
        if (this.updaterMissing && discovery.installation) {
            return { ...discovery,
                managed: "no",
                reason: "updater-missing" };
        }
        return discovery;
    }

    /**
     * Read, follow what runs and push a changed status
     * @returns The status that was read
     */
    private async observe() : Promise<PanelUpdateStatus> {
        const reading = await this.read();
        if (reading.readable && !this.stopped) {
            this.follow(reading.records);
            this.announce(reading.status);
        }
        return reading.status;
    }

    private async read() : Promise<Reading> {
        const discovery = await this.discover();
        const panel = panelOf(this.version, discovery);
        const installation = discovery.installation;
        if (!installation) {
            return { status: { schema: 1,
                panel },
            records: [],
            readable: true };
        }
        try {
            const records = await this.readHelpers(installation);
            this.forget(records);
            const status : PanelUpdateStatus = { schema: 1,
                panel };
            const operation = await this.operationOf(installation, records);
            if (operation) {
                status.operation = operation;
            }
            return { status,
                records,
                readable: true };
        } catch (error) {
            // Not "no operation": the page must not conclude that nothing runs
            log.warn("panel-update", `Cannot read the update helpers: ${describeError(error)}`);
            return { status: { schema: 1,
                panel: { ...panel,
                    managed: "unknown",
                    reason: "unreadable" } },
            records: [],
            readable: false };
        }
    }

    private async readHelpers(installation : PanelInstallation) : Promise<HelperRecord[]> {
        const listed = await this.docker([ "ps", "--all", "--no-trunc", "--filter", `label=${PANEL_UPDATE_LABELS.installation}=${installation.installDir}`, "--format", "{{.ID}}" ], { timeoutMs: DOCKER_TIMEOUT_MS });
        if (listed.code !== 0) {
            throw new Error(`docker ps: ${firstLine(listed.stderr)}`);
        }
        const ids = listed.stdout.split("\n").map((line) => line.trim()).filter((line) => CONTAINER_ID_PATTERN.test(line));
        if (ids.length === 0) {
            return [];
        }
        const inspected = await this.docker([ "inspect", "--type", "container", ...ids ], { timeoutMs: DOCKER_TIMEOUT_MS });
        const containers = parseInspect(inspected.stdout);
        // A helper removed between the two calls is simply gone; anything else is no answer
        if (!containers || (inspected.code !== 0 && !NO_SUCH_CONTAINER.test(inspected.stderr))) {
            throw new Error(`docker inspect: ${firstLine(inspected.stderr)}`);
        }
        const now = this.now();
        return containers.map((raw) => toRecord(raw, installation, now)).filter((record) : record is HelperRecord => record !== undefined);
    }

    /** Drop what is cached about helpers that no longer exist */
    private forget(records : readonly HelperRecord[]) : void {
        const ids = new Set(records.map((record) => record.id));
        const requests = new Set(records.map((record) => record.helper.requestId));
        for (const id of [ ...this.finishedLines.keys(), ...this.followBackoff.keys() ]) {
            if (!ids.has(id)) {
                this.finishedLines.delete(id);
                this.followBackoff.delete(id);
            }
        }
        for (const request of this.journals.keys()) {
            if (!requests.has(request)) {
                this.journals.delete(request);
            }
        }
    }

    private async operationOf(installation : PanelInstallation, records : readonly HelperRecord[]) : Promise<PanelUpdateOperation | undefined> {
        const record = findKind(records, "apply") ?? findKind(records, "preview");
        if (!record) {
            return undefined;
        }
        const lines = await this.readLines(record);
        const operation = derivePanelUpdateOperation(record.helper, lines, this.version);
        if (operation.kind !== "apply" || operation.result?.code !== "no-result") {
            return operation;
        }
        // No result line: the helper was killed or its log lost. The journal on the host
        // still knows where the operation stopped
        const journal = await this.journalOf(installation, record.helper);
        return journal ? derivePanelUpdateOperation(record.helper, lines, this.version, journal) : operation;
    }

    private async readLines(record : HelperRecord) : Promise<PanelUpdateLine[]> {
        const cached = record.helper.running ? undefined : this.finishedLines.get(record.id);
        if (cached) {
            return cached;
        }
        // stdout only: the updater prints its JSON lines there and human text on stderr
        const res = await this.docker([ "logs", record.id ], { timeoutMs: DOCKER_TIMEOUT_MS,
            maxBuffer: LOG_MAX_BUFFER });
        if (res.code !== 0) {
            throw new Error(`docker logs: ${firstLine(res.stderr)}`);
        }
        const lines = parseLines(res.stdout);
        if (!record.helper.running) {
            this.finishedLines.set(record.id, lines);
        }
        return lines;
    }

    private journalOf(installation : PanelInstallation, helper : PanelUpdateHelper) : Promise<PanelUpdateJournalLine | undefined> {
        const cached = this.journals.get(helper.requestId);
        if (cached && (cached.final || this.now() - cached.at < RETRY_MS)) {
            return Promise.resolve(cached.journal);
        }
        let pending = this.journalReads.get(helper.requestId);
        if (!pending) {
            pending = this.readJournal(installation, helper).finally(() => this.journalReads.delete(helper.requestId));
            this.journalReads.set(helper.requestId, pending);
        }
        return pending;
    }

    /**
     * Run the status helper once, attached, and take the journal line it prints
     * @param installation The panel's installation
     * @param helper The apply helper that left no result
     * @returns The journal line, or undefined when there is none
     */
    private async readJournal(installation : PanelInstallation, helper : PanelUpdateHelper) : Promise<PanelUpdateJournalLine | undefined> {
        const res = await this.docker(panelUpdateRunArgs(installation, {
            kind: "status",
            requestId: helper.requestId,
            from: helper.from,
            to: helper.to,
            startedAt: new Date(this.now()).toISOString(),
        }), { timeoutMs: STATUS_HELPER_TIMEOUT_MS,
            maxBuffer: LOG_MAX_BUFFER });
        const journal = parseLines(res.stdout).filter((line) : line is PanelUpdateJournalLine => line.dockge2 === "journal").at(-1);
        // 125 and -1: Docker never ran the updater (a name conflict, a timeout), so it is asked again later
        const final = journal !== undefined || (res.code >= 0 && res.code !== 125);
        if (!final) {
            log.warn("panel-update", `The status helper did not run: ${firstLine(res.stderr)}`);
        }
        this.journals.set(helper.requestId, { journal,
            at: this.now(),
            final });
        return journal;
    }

    private async requireManaged() : Promise<{ installation : PanelInstallation; records : HelperRecord[] }> {
        const discovery = await this.discover();
        if (discovery.managed !== "yes" || !discovery.installation) {
            throw new PanelUpdateError(discovery.managed === "unknown" ? "unreadable" : "unmanaged");
        }
        return {
            installation: discovery.installation,
            records: await this.readRecords(discovery.installation),
        };
    }

    /**
     * The preview or apply helper of a request
     * @param request Request id
     * @returns The helper
     * @throws {PanelUpdateError} not-found, or unreadable when Docker did not answer
     */
    private async requireRecord(request : string) : Promise<HelperRecord> {
        const installation = (await this.discover()).installation;
        const records = installation ? await this.readRecords(installation) : [];
        const record = records.find((item) => item.helper.kind !== "status" && item.helper.requestId === request);
        if (!record) {
            throw new PanelUpdateError("not-found");
        }
        return record;
    }

    private async readRecords(installation : PanelInstallation) : Promise<HelperRecord[]> {
        try {
            return await this.readHelpers(installation);
        } catch (error) {
            log.warn("panel-update", `Cannot read the update helpers: ${describeError(error)}`);
            throw new PanelUpdateError("unreadable");
        }
    }

    /**
     * A dry run that authorises an update: that request, finished as `previewed` less than
     * the time to live ago, of this version, started by this very panel version
     * @throws {PanelUpdateError} stale-preview
     */
    private async requireFreshPreview(record : HelperRecord | undefined, previewRequest : string, target : string) : Promise<void> {
        const helper = record?.helper;
        if (!record || !helper || helper.requestId !== previewRequest || helper.running || helper.to !== target || helper.from !== this.version) {
            throw new PanelUpdateError("stale-preview");
        }
        const age = this.now() - Date.parse(helper.finishedAt ?? "");
        if (!Number.isFinite(age) || age < 0 || age >= PANEL_UPDATE_PREVIEW_TTL_MS) {
            throw new PanelUpdateError("stale-preview");
        }
        const lines = await this.readLines(record).catch(() => {
            throw new PanelUpdateError("unreadable");
        });
        const operation = derivePanelUpdateOperation(helper, lines, this.version);
        const result = lines.filter((line) : line is PanelUpdateResultLine => line.dockge2 === "result").at(-1);
        if (operation.result?.outcome !== "previewed" || result?.to !== target) {
            throw new PanelUpdateError("stale-preview");
        }
    }

    /**
     * `docker run -d` a helper. Answers only once Docker returned the container.
     * @throws {PanelUpdateError} busy, updater-missing, start-failed
     */
    private async launch(installation : PanelInstallation, kind : "preview" | "apply", requestId : string, to : string) : Promise<void> {
        const args = panelUpdateRunArgs(installation, { kind,
            requestId,
            from: this.version,
            to,
            startedAt: new Date(this.now()).toISOString() });
        const res = await this.docker(args, { timeoutMs: DOCKER_TIMEOUT_MS * 2 });
        if (res.code === 0) {
            log.info("panel-update", `Started the ${kind} helper of request ${requestId} for version ${to}`);
            return;
        }
        // The fixed name is how a second helper of a kind is refused atomically. A container
        // of another installation with the same project name never shows in the status, so
        // "busy" would send the owner looking for an update that is not there
        if (NAME_CONFLICT.test(res.stderr)) {
            throw new PanelUpdateError(await this.foreignName(installation, kind) ? "name-taken" : "busy");
        }
        // `docker run` can fail after the container was created: it started after all (a
        // client that timed out), or it never will and is removed so the name is free again
        if (await this.leftover(panelUpdateHelperName(installation.project, kind), requestId) === "started") {
            return;
        }
        const updaterDir = path.posix.join(installation.installDir, ".dockge2");
        if (res.code === 126 || res.code === 127 || (BIND_SOURCE_MISSING.test(res.stderr) && res.stderr.includes(updaterDir))) {
            this.updaterMissing = true;
            log.warn("panel-update", `No updater to run in ${updaterDir}`);
            throw new PanelUpdateError("updater-missing");
        }
        log.warn("panel-update", `Could not start the ${kind} helper: ${firstLine(res.stderr)}`);
        throw new PanelUpdateError("start-failed");
    }

    /**
     * What is left of a helper whose `docker run` failed. Only a container of this request
     * that never started is removed.
     * @param name Fixed name of the helper
     * @param requestId Request id it was started for
     * @returns Whether it started, was removed, or does not exist
     */
    private async leftover(name : string, requestId : string) : Promise<"started" | "removed" | "absent"> {
        const res = await this.docker([ "inspect", "--type", "container", name ], { timeoutMs: DOCKER_TIMEOUT_MS });
        const raw = res.code === 0 ? parseInspect(res.stdout)?.[0] : undefined;
        if (!raw || typeof raw.Id !== "string" || !CONTAINER_ID_PATTERN.test(raw.Id) || raw.Config?.Labels?.[PANEL_UPDATE_LABELS.request] !== requestId) {
            return "absent";
        }
        if (everStarted(raw.State)) {
            return "started";
        }
        const removed = await this.docker([ "rm", raw.Id ], { timeoutMs: DOCKER_TIMEOUT_MS });
        if (removed.code === 0) {
            return "removed";
        }
        // Docker started it between the two calls
        const again = await this.docker([ "inspect", "--type", "container", raw.Id ], { timeoutMs: DOCKER_TIMEOUT_MS });
        return everStarted(again.code === 0 ? parseInspect(again.stdout)?.[0]?.State : undefined) ? "started" : "absent";
    }

    /**
     * Whether the container holding a helper's fixed name is something other than a helper
     * of this installation. An unreadable answer counts as ours, which keeps "busy".
     * @param installation The panel's installation
     * @param kind Kind of the helper
     * @returns Whether the name is taken by a foreign container
     */
    private async foreignName(installation : PanelInstallation, kind : "preview" | "apply") : Promise<boolean> {
        const res = await this.docker([ "inspect", "--type", "container", panelUpdateHelperName(installation.project, kind) ], { timeoutMs: DOCKER_TIMEOUT_MS });
        const raw = res.code === 0 ? parseInspect(res.stdout)?.[0] : undefined;
        return raw !== undefined && toRecord(raw, installation, this.now()) === undefined;
    }

    /**
     * Remove a finished helper. Never forced: a helper that runs again is refused by Docker.
     * @param record The helper
     * @param failure Code when Docker refuses
     */
    private async remove(record : HelperRecord, failure : PanelUpdateErrorCode) : Promise<void> {
        const res = await this.docker([ "rm", record.id ], { timeoutMs: DOCKER_TIMEOUT_MS });
        if (res.code !== 0 && !NO_SUCH_CONTAINER.test(res.stderr)) {
            throw new PanelUpdateError(failure);
        }
        this.finishedLines.delete(record.id);
    }

    private follow(records : readonly HelperRecord[]) : void {
        const now = this.now();
        for (const record of records) {
            if (record.helper.kind === "status" || !record.helper.running || this.followers.has(record.id)) {
                continue;
            }
            const notBefore = this.followBackoff.get(record.id) ?? 0;
            if (notBefore > now) {
                this.refreshLater(notBefore - now);
                continue;
            }
            this.followRecord(record.id);
        }
    }

    private followRecord(id : string) : void {
        const startedAt = this.now();
        const follow = this.followLogs([ "logs", "--follow", id ], (line) => {
            if (parsePanelUpdateLine(line)) {
                this.refreshLater(0);
            }
        });
        this.followers.set(id, follow);
        void follow.done.then(() => {
            if (this.followers.get(id) === follow) {
                this.followers.delete(id);
            }
            // The stream ends when the helper exits. One that ends at once while the helper
            // still runs is not reopened in a tight loop
            if (this.now() - startedAt < FOLLOW_RETRY_MS) {
                this.followBackoff.set(id, startedAt + FOLLOW_RETRY_MS);
            }
            this.refreshLater(0);
        });
    }

    private refreshLater(delayMs : number) : void {
        if (this.stopped) {
            return;
        }
        if (delayMs <= 0) {
            runInBackground("panel update", () => this.refresh());
            return;
        }
        if (this.retryTimer) {
            return;
        }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            runInBackground("panel update", () => this.refresh());
        }, delayMs);
        this.retryTimer.unref();
    }

    private announce(status : PanelUpdateStatus) : void {
        const text = JSON.stringify(status);
        if (text === this.lastPublished) {
            return;
        }
        this.lastPublished = text;
        try {
            this.publish(status);
        } catch (error) {
            log.error("panel-update", `Could not push the status: ${describeError(error)}`);
        }
    }

    /** Starting and removing helpers one at a time, so two tabs cannot interleave them */
    private serialized<T>(task : () => Promise<T>) : Promise<T> {
        const run = this.actions.then(task, task);
        this.actions = run.catch(() => undefined);
        return run;
    }
}
