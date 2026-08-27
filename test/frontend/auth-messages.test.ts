import { strict as assert } from "node:assert";
import test from "node:test";
import { authErrorMessage, isTotpCode } from "../../frontend/src/auth-messages";

test("a code from the authenticator app is told apart from a backup code", () => {
    // Six digits go to the TOTP endpoint
    assert.equal(isTotpCode("123456"), true);
    assert.equal(isTotpCode(" 123456 "), true);

    // Backup codes are longer and carry a separator, and they need the other endpoint,
    // which is the only way back in once the authenticator is gone
    assert.equal(isTotpCode("abcde-fghij"), false);
    assert.equal(isTotpCode("12345"), false);
    assert.equal(isTotpCode("1234567"), false);
    assert.equal(isTotpCode(""), false);
});

test("errors of the auth library are shown as translated messages", () => {
    // The library answers in English, so the code decides which of our keys is shown
    assert.equal(authErrorMessage({ code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password" }), "authInvalidCredentials");
    assert.equal(authErrorMessage({ code: "PASSWORD_TOO_SHORT" }), "authPasswordTooShort");
    assert.equal(authErrorMessage({ code: "TOO_MANY_REQUESTS" }), "authTooManyRequests");

    // An error nobody mapped still says something, and a missing error never crashes
    assert.equal(authErrorMessage({ code: "SOMETHING_NEW",
        message: "Something new happened" }), "Something new happened");
    assert.equal(authErrorMessage({}), "authUnknownError");
    assert.equal(authErrorMessage(null), "authUnknownError");
});
