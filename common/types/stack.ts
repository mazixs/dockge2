import type { ServiceSummary, StackStatusIssue } from "../compose-status";
import type { StackSource } from "../stack-source";
import type { Availability } from "../availability";

/**
 * A Compose secret bound to a file of the stack directory.
 * Only the mapping is stored, never the content.
 */
export interface SecretBinding {
    /** Compose secret name, for example "db_password" */
    name : string;
    /** File inside the stack directory, for example ".secret.db" */
    fileName : string;
    /** Services that reference this secret in the compose file */
    services : string[];
}

/**
 * Which files of a stack directory Dockge uses.
 * The texts themselves stay in the files, this is only the selection and the order.
 */
export interface StackFileConfig {
    /** Compose file passed to every `docker compose` call through `-f` */
    composeFileName : string;
    /** Ordered CLI env files used for compose interpolation */
    envFileNames : string[];
    /** Env file that the UI shows and edits, empty when the stack has none */
    activeEnvFileName : string;
    secretBindings : SecretBinding[];
}

/**
 * Metadata of a secret file, without its content
 */
export interface SecretFileMeta {
    fileName : string;
    /** Compose secret name when the file is bound, empty otherwise */
    secretName : string;
    size : number;
    /** ISO timestamp of the last modification */
    modifiedAt : string;
    /** Services that reference the secret in the compose file */
    services : string[];
}

/**
 * What Dockge found in the stack directory plus the configuration in use
 */
export interface StackFileInventory {
    config : StackFileConfig;
    composeFileNames : string[];
    envFileNames : string[];
    secretFiles : SecretFileMeta[];
    /**
     * True when the directory holds more than one compose file and nobody picked one yet.
     * The server keeps using a deterministic choice, but the UI has to ask.
     */
    needsComposeSelection : boolean;
    /**
     * Files that lie in the directory, were meant as stack files and were refused by the
     * name allow-list. They are reported so the screen can explain the absence instead of
     * leaving a file the person can see on disk missing from every list.
     */
    unsupportedFileNames : string[];
}

/**
 * What an editor read before it started changing a stack.
 *
 * The hashes travel back with the save so the server can tell an edit of the current
 * file from an edit of a version another editor has already replaced. A null hash means
 * the file did not exist; an absent field means the caller has no baseline and
 * deliberately accepts whatever is there.
 */
export interface StackFileBaseline {
    /** Hash of the compose file the editor loaded */
    compose? : string | null;
    /** Hash of the env file the editor loaded */
    env? : string | null;
    /**
     * Name of the compose file the editor read.
     *
     * The hash says the bytes are still the ones that were read; the name says they are
     * still the bytes of the same file. Which file a stack works with lives in the
     * settings and can change while an editor is open, and two files may hold the same
     * text, so without the name a save could land in a file the editor never showed.
     */
    composeFileName? : string;
    /** Name of the env file the editor read, for the same reason */
    envFileName? : string;
}

/** Why a stack file could not be read, reported instead of pretending it is empty */
export interface StackFileReadIssue {
    fileName : string;
    /** Error code from the filesystem, for example EACCES */
    code : string;
}

/**
 * A stack as every list row shows it.
 *
 * This is what the server actually sends, not a convenience shape: naming the fields
 * here means a renamed or forgotten one is a compilation error instead of a screen that
 * silently shows nothing. The files of the stack are deliberately absent - a list must
 * not carry the content of compose files it is not going to show.
 */
export interface StackSummaryDTO {
    name : string;
    /** Aggregated status, see the constants in `common/util-common.ts` */
    status : number;
    issues : StackStatusIssue[];
    tags : string[];
    /** True when the directory lies under the stacks directory of this panel */
    isManagedByDockge : boolean;
    composeFileName : string;
    /** Agent the stack belongs to, empty for the local one */
    endpoint : string;
    services : ServiceSummary[];
    /** Where the directory comes from, null when it could not be read */
    source : StackSource | null;
    /** Directory of the stack, empty when it is not managed here */
    dir : string;
    /** What is known about the last day, null when nothing was recorded */
    availability : Availability | null;
    /** Service the panel itself runs as, "" for any other stack: it can be stopped, not removed or recreated */
    panelService : string;
}

/**
 * What a viewer is sent instead of the full summary.
 *
 * A viewer has no access to files, so nothing about them travels: no compose file name,
 * no directory and nothing about the source the directory came from. The row still says
 * what is running and how it behaves, which is what a viewer is there for.
 */
export type ViewerStackSummary = Pick<
    StackSummaryDTO,
    "name" | "status" | "endpoint" | "isManagedByDockge" | "availability" | "services" | "issues"
>;

/**
 * A stack with its files, as the editor loads it.
 *
 * Everything the browser needs to show and edit one stack travels in a single answer,
 * so a screen never has to guess which of several requests it is looking at.
 */
export interface StackDTO extends StackSummaryDTO {
    composeYAML : string;
    composeENV : string;
    /** What the editor loaded, so a save can say which version it changed */
    fileHashes : StackFileHashes;
    /** Files the panel could not read: an editor must not save over them */
    readIssues : StackFileReadIssue[];
    /** Hostname the links of the stack are built from */
    primaryHostname : string;
    /** Only names, sizes and bindings of secrets, never their content */
    files : StackFileSelection;
}

/**
 * What an editor loaded: the bytes of each file, and which files those were.
 *
 * Null hashes mean the file did not exist or could not be read. The names are here
 * because a save is sent back as a {@link StackFileBaseline}, and the stack can be
 * pointed at other files while an editor is open.
 */
export interface StackFileHashes {
    compose : string | null;
    env : string | null;
    /** Compose file the editor read */
    composeFileName : string;
    /** Env file the editor read */
    envFileName : string;
}

/** Which files the stack directory holds and which of them are in use */
export interface StackFileSelection {
    composeFileNames : string[];
    envFileNames : string[];
    /** Env file the editor shows, empty when the stack has none */
    activeEnvFileName : string;
    /** Env files passed to compose, in order */
    selectedEnvFileNames : string[];
    secretFiles : SecretFileMeta[];
    needsComposeSelection : boolean;
    unsupportedFileNames : string[];
}
