/** Explicit file decisions for an immutable Git comparison. */
export type GitFileChoice = "server" | "git" | "edited";

export interface GitCloneInput {
    name: string;
    repository: string;
    branch: string;
    composeFile: string;
    envFiles?: string[];
    deploy: boolean;
}

export interface GitApplyInput {
    stackName: string;
    previewId: string;
    choices: Record<string, GitFileChoice>;
    /** Exact UTF-8 results for editable files only. Never accepts hidden file contents. */
    editedContents?: Record<string, string>;
    deploy: boolean;
}

export interface GitPreviewFile {
    path: string;
    status: "added" | "modified" | "deleted";
    serverText: string | null;
    gitText: string | null;
    redacted: boolean;
    binary: boolean;
}

export interface GitUpdatePreview {
    id: string;
    branch: string;
    currentCommit: string;
    targetCommit: string;
    files: GitPreviewFile[];
}

/**
 * A reason the receiver translates itself: a catalogue key and the values it takes.
 *
 * The server does not know the reader's language, so it names the entry instead of
 * writing the sentence. An older agent still sends a finished string, and the reader
 * has to accept both.
 */
export interface GitMessage {
    key: string;
    values?: Record<string, string>;
}

export interface GitSaveResult {
    stackName: string;
    saved: true;
    deployed: boolean;
    /** Why the stack is not running. Absent when it started. */
    deploymentError?: GitMessage | string;
}
