import type { UpdateCheckError } from "../../common/update-check";

/** What the panel can honestly say about updates right now */
export type UpdateNotice =
    /** The owner never turned the check on, so nothing was ever asked */
    "off"
    /** The check is on, but no answer has arrived yet */
    | "pending"
    /** The registry answered, and nothing newer exists */
    | "current"
    /** A newer release exists */
    | "available"
    | "failed"
    | "stale";

/** The part of the server's answer this decision needs */
export interface VersionInfo {
    /** Newest release the server found, absent until it asked */
    latestVersion? : string;
    /** Whether that release is newer than the running one */
    updateAvailable? : boolean;
    lastUpdateCheck? : string;
    updateCheckFailed? : boolean;
    updateCheckError? : UpdateCheckError;
}

/**
 * What to show about updates.
 *
 * The switch and the answer are two different things, and the screen used to show
 * neither: "on" without an answer is not the same as "you are up to date", and the
 * newest release is not news when it is the one already running.
 * @param info What the server said about itself
 * @param checkEnabled The owner's setting, which may not have loaded yet
 * @returns The state the screen renders
 */
export function updateNotice(info : VersionInfo | undefined, checkEnabled : unknown) : UpdateNotice {
    if (checkEnabled !== true) {
        return "off";
    }

    if (info?.updateCheckFailed) {
        return "failed";
    }
    if (info?.lastUpdateCheck && Date.now() - Date.parse(info.lastUpdateCheck) > 49 * 60 * 60 * 1000) {
        return "stale";
    }
    const latest = typeof info?.latestVersion === "string" ? info.latestVersion : "";

    if (!latest) {
        return "pending";
    }

    return info?.updateAvailable === true ? "available" : "current";
}
