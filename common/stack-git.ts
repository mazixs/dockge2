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

export interface GitSaveResult {
    stackName: string;
    saved: true;
    deployed: boolean;
    deploymentError?: string;
}
