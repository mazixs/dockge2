/**
 * Where the files of a stack come from, and what that means for the interface.
 *
 * The type and the verdict live here because the navigator, the source panel and
 * the inspector have to name the same directory with the same words. Decided
 * twice, the two answers drift: one screen said "in sync" while the other still
 * offered to check.
 */

/** Where the files of a stack come from, as far as reading the directory can tell */
export interface StackSource {
    /** git when the directory is a work tree, local when it is a plain directory */
    kind : "git" | "local";
    /** Full checked-out commit, empty for a local directory. */
    commit? : string;
    /** Number of modified/untracked status entries; not a count of failed services. */
    changedFiles? : number | null;
    /** Remote address without credentials, empty when there is no remote */
    remote : string;
    /** Checked out branch, empty when the head is detached or unreadable */
    branch : string;
    /**
     * Commits the work tree is behind its upstream, null when it cannot be told.
     * Nothing is fetched here, so this is the distance to the last known upstream
     * state - the truth may be further away, and the UI must not pretend otherwise.
     */
    behind : number | null;
    /** Whether the work tree has uncommitted changes, null when it cannot be told */
    dirty : boolean | null;
    /**
     * When origin was last asked, in milliseconds, null when it never was from here.
     * `behind` is the distance to whatever was learned at that moment, so without
     * this a stack that was never fetched is indistinguishable from one that is
     * genuinely up to date.
     */
    checkedAt : number | null;
}

/**
 * What the interface says about a stack directory.
 *
 * `unchecked` is deliberately separate from `clean`: both have nothing waiting,
 * but only one of them has asked.
 */
export type StackSourceState = "local" | "unreadable" | "edited" | "behind" | "editedBehind" | "clean" | "unchecked";

/** Git states and the catalogue key that names each of them */
export const STACK_GIT_STATE_KEY : Record<Exclude<StackSourceState, "local">, string> = {
    unreadable: "familiarGitUnreadable",
    edited: "familiarGitEdited",
    behind: "familiarGitBehind",
    editedBehind: "familiarGitEditedBehind",
    clean: "familiarGitClean",
    unchecked: "familiarGitNotChecked",
};

/**
 * Decide what a stack directory is in, from what reading it could establish.
 *
 * An unreadable working copy does not erase a known distance to Git, and a known
 * distance of zero is only called clean when something actually checked.
 * @param source What the directory said about itself, or nothing at all
 * @returns The state the interface names
 */
export function stackSourceState(source : StackSource | null | undefined) : StackSourceState {
    if (!source || source.kind !== "git") {
        return "local";
    }

    const behind = typeof source.behind === "number" && source.behind > 0;

    if (source.dirty === null) {
        return behind ? "behind" : "unreadable";
    }

    if (source.dirty) {
        return behind ? "editedBehind" : "edited";
    }

    if (behind) {
        return "behind";
    }

    // Distance unknown, or known only because nothing ever fetched: either way the
    // honest answer is that Git has not been compared, not that it matches
    return typeof source.behind === "number" && source.checkedAt !== null ? "clean" : "unchecked";
}

/**
 * Whether the state is a reason to open the comparison rather than a note.
 * @param state State of the directory
 * @returns true when files on the server and in Git are known to differ
 */
export function stackSourceDiffers(state : StackSourceState) : boolean {
    return state === "edited" || state === "behind" || state === "editedBehind";
}
