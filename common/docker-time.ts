/**
 * Reading Docker's own relative times.
 *
 * `docker ps` answers with English phrases ("Up About a minute", "Exited (0) 4 minutes
 * ago"). Showing them as they are puts English into a Russian panel, and inventing a
 * timestamp would be worse, so the phrase is parsed into milliseconds and formatted by
 * the interface itself. A phrase that cannot be parsed returns null - then the panel
 * says nothing instead of guessing.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Units Docker uses in its relative phrases */
const UNITS : Record<string, number> = {
    second: SECOND,
    seconds: SECOND,
    minute: MINUTE,
    minutes: MINUTE,
    hour: HOUR,
    hours: HOUR,
    day: DAY,
    days: DAY,
    week: 7 * DAY,
    weeks: 7 * DAY,
    month: 30 * DAY,
    months: 30 * DAY,
    year: 365 * DAY,
    years: 365 * DAY,
};

/**
 * Parse the duration out of a Docker status text.
 * @param statusText Status as Docker wrote it
 * @returns Duration in milliseconds, or null when the phrase carries none
 */
export function parseDockerDuration(statusText : string) : number | null {
    const text = statusText.trim().toLowerCase();

    if (!text) {
        return null;
    }

    // "Less than a second" is a real answer for a container that just started
    if (text.includes("less than a second")) {
        return SECOND;
    }

    // "About a minute", "About an hour"
    const about = /about a[n]? (second|minute|hour|day|week|month|year)/.exec(text);
    if (about?.[1]) {
        return UNITS[about[1]] ?? null;
    }

    const counted = /(\d+)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)/.exec(text);
    if (counted?.[1] && counted[2]) {
        const unit = UNITS[counted[2]];
        return unit ? Number.parseInt(counted[1], 10) * unit : null;
    }

    return null;
}

/**
 * Whether a status text describes a container that is currently up.
 * The distinction matters: "Up 2 days" is an uptime, "Exited (0) 2 days ago" is not.
 * @param statusText Status as Docker wrote it
 * @returns True when the text starts with Up
 */
export function isUpStatus(statusText : string) : boolean {
    return /^up\b/i.test(statusText.trim());
}
