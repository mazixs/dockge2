/**
 * Keys a server of an earlier build still answers with.
 *
 * The catalogue moved these to camelCase in 0.0.14, and refusals that used to be English
 * sentences became keys, but a panel talks to agents that were not updated with it, and
 * the original Dockge sends the same texts. Without this table their "Saved" would reach
 * the reader as an unexpected server error. A sentence with a name in it cannot be listed
 * and still arrives that way.
 */
const FORMER_KEYS : Readonly<Record<string, string>> = {
    "Saved": "saved",
    "Deployed": "deployed",
    "Deleted": "deleted",
    "Updated": "updated",
    "Started": "started",
    "Stopped": "stopped",
    "Restarted": "restarted",
    "Downed": "downed",
    "Incorrect current password": "incorrectCurrentPassword",
    "You are not logged in.": "notLoggedIn",
    "Stack not found": "stackNotFound",
    "Stack name already exists": "stackNameExists",
    "Stack name can only contain [a-z][0-9] _ - only": "stackNameInvalid",
    "Stack path is outside the stacks directory": "stackPathOutside",
    "The stack directory is a symbolic link": "stackDirectorySymlink",
    "This stack is not managed by Dockge.": "stackNotManagedByDockgeMsg",
    "Nothing is running for this stack.": "stackNothingRunning",
    "Another operation is already running, please try again later.": "operationBusy",
    "Failed to down, please check the terminal output for more information.": "stackDownFailed",
    "Invalid .env format": "envFormatInvalid",
    "Duplicate file name in one save": "stackFileDuplicate",
    "You are not attached to this terminal.": "terminalNotAttached",
    "Unsupported shell, use sh or bash.": "shellUnsupported",
    "Console is not enabled.": "consoleOff",
    "The Dockge URL already exists": "agentUrlExists",
    "Agent not found": "agentNotFound",
};

/**
 * @param key Key a server answered with
 * @returns The key the catalogue holds that message under now
 */
export function currentMessageKey(key : string) : string {
    return Object.hasOwn(FORMER_KEYS, key) ? FORMER_KEYS[key] ?? key : key;
}

/** Every former key, for the test that keeps the table pointing at real entries */
export const FORMER_MESSAGE_KEYS = Object.freeze({ ...FORMER_KEYS });
