/** Release discovery is separate from installing a release. These codes are safe to display. */
export const UPDATE_CHECK_MESSAGES = {
    network: "updateCheckNetwork",
    timeout: "updateCheckTimeout",
    rateLimited: "updateCheckRateLimited",
    registry: "updateCheckRegistry",
    invalidResponse: "updateCheckInvalidResponse",
    noRelease: "updateCheckNoRelease",
    internal: "updateCheckFailed",
} as const;

export type UpdateCheckError = keyof typeof UPDATE_CHECK_MESSAGES;
