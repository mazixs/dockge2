/**
 * Messages and small decisions of the authentication UI.
 *
 * Kept apart from `auth-client.ts` because that module builds its client from
 * `location` as soon as it is imported, and these helpers are plain functions that the
 * tests can exercise without a browser.
 */

/** Error of an auth call, as the client returns it */
interface AuthClientError {
    code? : string | undefined;
    message? : string | undefined;
}

/**
 * Translation keys for the errors people actually run into.
 * The library answers in English, and this interface is translated, so the code is
 * mapped to a key of our own and the English text is only the fallback.
 */
const AUTH_ERROR_KEYS : Record<string, string> = {
    INVALID_USERNAME_OR_PASSWORD: "authInvalidCredentials",
    INVALID_USERNAME: "authInvalidUsername",
    USERNAME_IS_ALREADY_TAKEN: "authAccountExists",
    INVALID_BOOTSTRAP_TOKEN: "authInvalidBootstrapToken",
    EMAIL_PASSWORD_SIGN_UP_DISABLED: "authSetupComplete",
    SETUP_COMPLETE: "authSetupComplete",
    INVALID_EMAIL_OR_PASSWORD: "authInvalidCredentials",
    INVALID_EMAIL: "authInvalidEmail",
    PASSWORD_TOO_SHORT: "authPasswordTooShort",
    PASSWORD_TOO_LONG: "authPasswordTooLong",
    USER_ALREADY_EXISTS: "authAccountExists",
    INVALID_PASSWORD: "authInvalidPassword",
    INVALID_TWO_FACTOR_AUTHENTICATION: "authInvalidCode",
    INVALID_BACKUP_CODE: "authInvalidBackupCode",
    TWO_FACTOR_NOT_ENABLED: "authTwoFactorNotEnabled",
    TOO_MANY_REQUESTS: "authTooManyRequests",
};

/**
 * Message to show for a failed auth call
 * @param error Error the client returned
 * @returns Translation key, or the message of the server when there is no key for it
 */
export function authErrorMessage(error : AuthClientError | null | undefined) : string {
    if (!error) {
        return "authUnknownError";
    }

    const key = error.code ? AUTH_ERROR_KEYS[error.code] : undefined;

    return key ?? error.message ?? "authUnknownError";
}

/**
 * Whether a code the user typed is a code from the authenticator app.
 *
 * Backup codes are longer and carry a separator, and they go to a different endpoint,
 * so telling them apart is what makes a lost authenticator recoverable.
 * @param code Code as it was typed
 * @returns True for a six digit TOTP code
 */
export function isTotpCode(code : string) : boolean {
    return /^[0-9]{6}$/.test(code.trim());
}

/** What a password change sends to the server */
export interface PasswordChangeRequest {
    currentPassword : string;
    newPassword : string;
    revokeOtherSessions : boolean;
}

/**
 * Build the body of a password change.
 *
 * Other sessions are always revoked, because a password is usually changed exactly when
 * somebody else may be holding a cookie, and a session that survives the change would
 * defeat the point. Kept here so the decision is one line in one place, and so a test
 * notices if it ever stops being sent.
 * @param currentPassword Password of the account today
 * @param newPassword Password to set
 * @returns Body for `authClient.changePassword`
 */
export function passwordChangeRequest(currentPassword : string, newPassword : string) : PasswordChangeRequest {
    return {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
    };
}
