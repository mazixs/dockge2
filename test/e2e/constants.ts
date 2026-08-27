/** Stack used by the terminal tests, it has to stay running while they execute */
export const E2E_STACK_NAME = "e2e-terminal";

/** Stack with a running service plus an unmarked container that exits, used for status tests */
export const E2E_ATTENTION_STACK = "e2e-attention";

/** Stack with several compose files, several env files and a secret file */
export const E2E_FILES_STACK = "e2e-files";

/**
 * Password of the seeded admin.
 * It only exists inside the temporary e2e data directory, which is deleted before every run,
 * and it is needed because revealing a secret is guarded by a password check.
 */
export const E2E_ADMIN_PASSWORD = "e2e-only-password";

/** Address of the seeded account */
export const E2E_ADMIN_EMAIL = "e2e-owner@example.com";

/** Origin the UI is served from during the e2e run */
export const FRONTEND_ORIGIN = "http://localhost:5000";

/** Where the signed in session of the run is kept */
export const AUTH_STATE_PATH = "test/e2e/.auth/state.json";
