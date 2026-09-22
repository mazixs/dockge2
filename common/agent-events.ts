import type { Availability } from "./availability";
import type { ImageUpdate } from "./image-source";
import type { StabilityOverview, StabilityWindow } from "./stability";
import type { ContainerInstanceStatus, StackStatusIssue } from "./compose-status";
import type { GitApplyInput, GitCloneInput, GitSaveResult, GitUpdatePreview } from "./types/stack-git";
import type { StackSource } from "./stack-source";
import type {
    SecretFileMeta,
    StackDTO,
    StackFileBaseline,
    StackFileConfig,
    StackFileInventory,
    StackSummaryDTO,
    ViewerStackSummary,
} from "./types/stack";

/**
 * What the browser may ask an agent, and what comes back.
 *
 * The transport carries whatever is put on it, so this map is the only place that says
 * which events exist and what travels with them. A renamed field of an answer, a handler
 * with an argument the caller never sends, or a request the server does not serve is a
 * compilation error here instead of a screen that quietly shows nothing.
 *
 * It is a static description, not a check: an argument that arrives over the network is
 * still validated by the handler itself, because nothing stops another build - or a
 * hostile caller - from sending something else entirely.
 */

/** A message the server sends for a catalogue to translate, or a finished sentence */
export type AgentMessage = string | { key : string; values? : Record<string, unknown> };

/** What every answer carries, whether it succeeded or not */
interface AgentMessageFields {
    msg? : AgentMessage;
    /** True when `msg` names a catalogue entry rather than a finished sentence */
    msgi18n? : boolean;
}

/** The answer of a request that did not succeed */
export interface AgentErrorResponse extends AgentMessageFields {
    ok : false;
    /** Set for a rejected argument, so the screen can tell it from a failure */
    type? : string | number;
    /** Stable command failure category, independent of the translated message. */
    code? : "busy" | "interrupted" | "spawn" | "pull" | "build" | "apply";
    /** True when no answer arrived at all, so the caller may not say it failed */
    unknown? : boolean;
}

/**
 * The answer of one request: the payload when it succeeded, the reason when it did not.
 * @template P Fields the successful answer carries beyond the message
 */
export type AgentResponse<P = unknown> = (AgentMessageFields & { ok : true } & P) | AgentErrorResponse;

/** Answer of a request that only reports whether it worked */
export type AgentDone = AgentResponse;

/** How a container behaves over a window, per service of one stack */
export type ServiceStatusList = Record<string, ContainerInstanceStatus[]>;

/** One event: what the caller sends and what it is answered with */
export interface AgentEventShape {
    args : unknown[];
    result : unknown;
}

/** A set of events, used to type both directions of the agent transport */
export type AgentEventContract = Record<string, AgentEventShape>;

/**
 * Requests a browser sends to an agent.
 *
 * The arguments are what the caller passes; the acknowledgement is added by the
 * transport and is not part of the tuple.
 */
export interface AgentRequestContract extends AgentEventContract {
    // Stacks
    deployStack : {
        args : [ name : string, composeYAML : string, composeENV : string, isAdd : boolean, baseline : StackFileBaseline | undefined ];
        result : AgentResponse<{ fileHashes : StackFileBaseline }>;
    };
    /** The answer carries the hashes of what was written, so the editor can save again */
    saveStack : {
        args : [ name : string, composeYAML : string, composeENV : string, isAdd : boolean, baseline : StackFileBaseline | undefined ];
        result : AgentResponse<{ fileHashes : StackFileBaseline }>;
    };
    deleteStack : { args : [ name : string ]; result : AgentDone };
    getStack : { args : [ stackName : string ]; result : AgentResponse<{ stack : StackDTO }> };
    requestStackList : { args : []; result : AgentDone };
    startStack : { args : [ stackName : string ]; result : AgentDone };
    stopStack : { args : [ stackName : string ]; result : AgentDone };
    restartStack : { args : [ stackName : string ]; result : AgentDone };
    updateStack : { args : [ stackName : string ]; result : AgentDone };
    downStack : { args : [ stackName : string ]; result : AgentDone };
    abortCompose : { args : [ stackName : string ]; result : AgentDone };
    serviceStatusList : {
        args : [ stackName : string ];
        result : AgentResponse<{ serviceStatusList : ServiceStatusList; stackStatus : number; issues : StackStatusIssue[] }>;
    };
    stackUpdatePreview : {
        args : [ stackName : string ];
        result : AgentResponse<{ source : StackSource | null; images : ImageUpdate[]; builds : boolean }>;
    };
    stackAvailability : {
        args : [ stackName : string, windowHours : number ];
        result : AgentResponse<{ availability : Availability }>;
    };
    stabilityOverview : {
        args : [ windowHours : StabilityWindow ];
        result : AgentResponse<{ overview : StabilityOverview }>;
    };

    // Files and secrets
    getStackFiles : { args : [ stackName : string ]; result : AgentResponse<{ inventory : StackFileInventory }> };
    setStackFiles : {
        args : [ stackName : string, config : StackFileConfig ];
        result : AgentResponse<{ config : StackFileConfig }>;
    };
    saveEnvFile : { args : [ stackName : string, fileName : string, content : string ]; result : AgentDone };
    listSecrets : { args : [ stackName : string ]; result : AgentResponse<{ secretFiles : SecretFileMeta[] }> };
    revealSecret : {
        args : [ stackName : string, fileName : string, currentPassword : string ];
        result : AgentResponse<{ content : string }>;
    };
    saveSecret : {
        args : [ stackName : string, fileName : string, content : string, currentPassword : string ];
        result : AgentResponse<{ secretFiles : SecretFileMeta[] }>;
    };
    deleteSecret : {
        args : [ stackName : string, fileName : string, currentPassword : string ];
        result : AgentResponse<{ secretFiles : SecretFileMeta[] }>;
    };
    bindSecret : {
        args : [ stackName : string, secretName : string, fileName : string, services : string[] ];
        result : AgentResponse<{ secretFiles : SecretFileMeta[] }>;
    };
    unbindSecret : {
        args : [ stackName : string, secretName : string ];
        result : AgentResponse<{ secretFiles : SecretFileMeta[] }>;
    };

    // Services and host
    startService : { args : [ stackName : string, serviceName : string ]; result : AgentDone };
    stopService : { args : [ stackName : string, serviceName : string ]; result : AgentDone };
    updateService : { args : [ stackName : string, serviceName : string ]; result : AgentDone };
    restartService : { args : [ stackName : string, serviceName : string ]; result : AgentDone };
    dockerStats : { args : []; result : AgentResponse<{ dockerStats : Record<string, object> }> };
    getDockerNetworkList : { args : []; result : AgentResponse<{ dockerNetworkList : string[] }> };

    // Git
    gitCloneStack : { args : [ payload : GitCloneInput ]; result : AgentResponse<GitSaveResult> };
    gitListBranches : { args : [ repository : string ]; result : AgentResponse<{ branches : string[] }> };
    gitPreviewUpdate : { args : [ stackName : string ]; result : AgentResponse<{ preview : GitUpdatePreview }> };
    gitDiscardPreview : { args : [ stackName : string, previewId : string ]; result : AgentResponse };
    gitApplyUpdate : { args : [ payload : GitApplyInput ]; result : AgentResponse<GitSaveResult> };

    // Terminals
    terminalInput : { args : [ terminalName : string, cmd : string ]; result : AgentDone };
    mainTerminal : { args : [ terminalName : string ]; result : AgentDone };
    /** Answers whether the console is switched on at all, so a refusal is not an error */
    checkMainTerminal : { args : []; result : { ok : boolean } | AgentErrorResponse };
    interactiveTerminal : {
        args : [ stackName : string, serviceName : string, shell : string ];
        result : AgentResponse<{ terminalName : string }>;
    };
    terminalJoin : { args : [ terminalName : string ]; result : AgentResponse<{ buffer : string }> };
    terminalLeave : { args : [ terminalName : string ]; result : AgentDone };
    joinCombinedTerminal : { args : [ stackName : string ]; result : AgentDone };
    leaveCombinedTerminal : { args : [ stackName : string ]; result : AgentDone };
    /** Sent while the window is being resized, and therefore never acknowledged */
    terminalResize : { args : [ terminalName : string, rows : number, cols : number ]; result : void };
}

/**
 * What an agent sends on its own, without being asked.
 *
 * These have no acknowledgement: the browser is being told something, not answering.
 */
export interface AgentBroadcastContract extends AgentEventContract {
    terminalWrite : { args : [ terminalName : string, data : string | Uint8Array ]; result : void };
    terminalExit : { args : [ terminalName : string, exitCode : number | null ]; result : void };
    /** A viewer is sent the reduced row, so a screen has to ask before reading a file field */
    stackList : {
        args : [ response : AgentResponse<{ stackList : Record<string, StackSummaryDTO | ViewerStackSummary>; endpoint? : string }> ];
        result : void;
    };
}

/** Name of a broadcast an agent may send on its own */
export type AgentBroadcastName = keyof AgentBroadcastContract & string;

/** What a broadcast carries */
export type AgentBroadcastArgs<E extends AgentBroadcastName> = AgentBroadcastContract[E]["args"];

/** Name of a request this build knows */
export type AgentRequestName = keyof AgentRequestContract & string;

/** Arguments a request is sent with */
export type AgentRequestArgs<E extends AgentRequestName> = AgentRequestContract[E]["args"];

/** Answer a request is given */
export type AgentRequestResult<E extends AgentRequestName> = AgentRequestContract[E]["result"];

/**
 * Every request this build knows.
 *
 * Written out rather than derived, because a type has no value at runtime: a test
 * compares this with the handlers the server actually registers. The record shape is
 * what keeps it honest - an event added to the contract and forgotten here does not
 * compile.
 */
const REQUEST_NAMES : Record<AgentRequestName, true> = {
    deployStack: true,
    saveStack: true,
    deleteStack: true,
    getStack: true,
    requestStackList: true,
    startStack: true,
    stopStack: true,
    restartStack: true,
    updateStack: true,
    downStack: true,
    abortCompose: true,
    serviceStatusList: true,
    stackUpdatePreview: true,
    stackAvailability: true,
    stabilityOverview: true,
    getStackFiles: true,
    setStackFiles: true,
    saveEnvFile: true,
    listSecrets: true,
    revealSecret: true,
    saveSecret: true,
    deleteSecret: true,
    bindSecret: true,
    unbindSecret: true,
    startService: true,
    stopService: true,
    restartService: true,
    updateService: true,
    dockerStats: true,
    getDockerNetworkList: true,
    gitCloneStack: true,
    gitListBranches: true,
    gitPreviewUpdate: true,
    gitDiscardPreview: true,
    gitApplyUpdate: true,
    terminalInput: true,
    mainTerminal: true,
    checkMainTerminal: true,
    interactiveTerminal: true,
    terminalJoin: true,
    terminalLeave: true,
    joinCombinedTerminal: true,
    leaveCombinedTerminal: true,
    terminalResize: true,
};

/** Names of every request, for a check that the server serves exactly these */
export const AGENT_REQUEST_NAMES = Object.keys(REQUEST_NAMES) as AgentRequestName[];
