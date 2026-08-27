import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import test from "node:test";
import { getAuth } from "../../backend/auth";
import { createTestAccount, TEST_PASSWORD, withDatabase } from "../helpers/database";

/**
 * Decode a base32 secret the way an authenticator app does
 * @param secret Secret in RFC 4648 base32, padding optional
 * @returns Raw bytes of the secret
 */
function decodeBase32(secret : string) : Buffer {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";

    for (const character of secret.replace(/=+$/, "").toUpperCase()) {
        const value = alphabet.indexOf(character);

        if (value < 0) {
            throw new Error(`The secret contains ${character}, which is not base32`);
        }

        bits += value.toString(2).padStart(5, "0");
    }

    const bytes : number[] = [];

    for (let index = 0; index + 8 <= bits.length; index += 8) {
        bytes.push(parseInt(bits.slice(index, index + 8), 2));
    }

    return Buffer.from(bytes);
}

/**
 * Generate the code an authenticator app would show, so the test proves the real algorithm
 * @param secret Secret in base32
 * @param stepSeconds Length of one time step
 * @param digits Number of digits in the code
 * @param atSeconds Point in time the code is generated for
 * @returns Six digit code
 */
function generateTotp(secret : string, stepSeconds = 30, digits = 6, atSeconds = Math.floor(Date.now() / 1000)) : string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(atSeconds / stepSeconds)));

    const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
    const offset = (digest[digest.length - 1] as number) & 0x0f;
    const binary = (((digest[offset] as number) & 0x7f) << 24)
        | (((digest[offset + 1] as number) & 0xff) << 16)
        | (((digest[offset + 2] as number) & 0xff) << 8)
        | ((digest[offset + 3] as number) & 0xff);

    return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Pull the shared secret out of the URI the dialog turns into a QR code
 * @param uri otpauth URI returned when two factor is enabled
 * @returns Secret in base32
 */
function secretFromUri(uri : string) : string {
    const secret = new URL(uri).searchParams.get("secret");
    assert.ok(secret, `The TOTP URI carried no secret: ${uri}`);
    return secret;
}

/**
 * Read the cookie header value from a response
 * @param response Response of an auth endpoint
 * @returns Cookie header for the next request
 */
function cookieOf(response : Response) : string {
    const setCookie = response.headers.get("set-cookie") ?? "";
    return setCookie
        .split(/,(?=[^;]+=)/)
        .map((part) => part.split(";")[0]?.trim() ?? "")
        .filter((part) => part !== "")
        .join("; ");
}

/**
 * Turn on the TOTP factor for a session and hand back what the dialog shows
 * @param cookie Session cookie of the account
 * @returns TOTP URI and backup codes
 */
async function startTwoFactor(cookie : string) : Promise<{ totpURI : string, backupCodes : string[] }> {
    const enabled = await getAuth().api.enableTwoFactor({
        body: { password: TEST_PASSWORD },
        headers: { cookie } as never,
    });

    // The endpoint can also answer for the mail based factor, which Dockge does not use
    assert.ok("totpURI" in enabled, "enabling two factor has to return a TOTP secret");
    return enabled;
}

test("enabling two factor needs the password and returns a working TOTP secret", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();

        // A stolen session alone must not be able to change the second factor, and the
        // refusal has to be the clean answer the UI shows as "wrong password"
        const refused = await getAuth().api.enableTwoFactor({
            body: { password: "not-the-password" },
            headers: { cookie } as never,
            asResponse: true,
        });
        assert.equal(refused.status, 400);
        assert.match(await refused.text(), /password/i);

        const enabled = await startTwoFactor(cookie);

        assert.match(enabled.totpURI, /^otpauth:\/\/totp\/Dockge/);
        assert.equal(enabled.backupCodes.length, 10, "ten codes are what makes a lost authenticator recoverable");
        assert.equal(new Set(enabled.backupCodes).size, 10, "duplicate codes would silently reduce that number");

        // Two factor only turns on once a generated code is confirmed
        const secret = secretFromUri(enabled.totpURI);
        const confirmed = await getAuth().api.verifyTOTP({
            body: { code: generateTotp(secret) },
            headers: { cookie } as never,
            asResponse: true,
        });
        assert.equal(confirmed.ok, true);

        // Confirming rotates the session: the cookie from before two factor is dead,
        // which is why the UI has to hand the fresh one to the socket
        const rotated = cookieOf(confirmed);
        assert.notEqual(rotated, cookie);
        assert.equal(await getAuth().api.getSession({ headers: { cookie } as never }), null);

        const session = await getAuth().api.getSession({ headers: { cookie: rotated } as never });
        assert.equal((session?.user as { twoFactorEnabled? : boolean } | undefined)?.twoFactorEnabled, true);
    });
});

test("with two factor on, the password alone does not open a session", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const enabled = await startTwoFactor(cookie);
        const secret = secretFromUri(enabled.totpURI);
        await getAuth().api.verifyTOTP({
            body: { code: generateTotp(secret) },
            headers: { cookie } as never,
        });

        const signIn = await getAuth().api.signInEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            asResponse: true,
        });
        assert.equal(signIn.ok, true);

        const body = await signIn.clone().json() as { twoFactorRedirect? : boolean };
        assert.equal(body.twoFactorRedirect, true, "sign-in must ask for the second factor");

        // The cookie of that step is not a session yet
        const pending = cookieOf(signIn);
        assert.equal(await getAuth().api.getSession({ headers: { cookie: pending } as never }), null);

        // A wrong code keeps it that way
        const wrongCode = await getAuth().api.verifyTOTP({
            body: { code: "000000" },
            headers: { cookie: pending } as never,
            asResponse: true,
        });
        assert.equal(wrongCode.status, 401);
        assert.equal(await getAuth().api.getSession({ headers: { cookie: pending } as never }), null);

        const verified = await getAuth().api.verifyTOTP({
            body: { code: generateTotp(secret) },
            headers: { cookie: pending } as never,
            asResponse: true,
        });
        assert.equal(verified.ok, true);

        const opened = await getAuth().api.getSession({ headers: { cookie: cookieOf(verified) } as never });
        assert.equal(opened?.user?.email, "owner@example.com");
    });
});

test("a backup code signs in once when the authenticator is gone", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const enabled = await startTwoFactor(cookie);
        await getAuth().api.verifyTOTP({
            body: { code: generateTotp(secretFromUri(enabled.totpURI)) },
            headers: { cookie } as never,
        });

        const backupCode = enabled.backupCodes[0] as string;

        const signIn = await getAuth().api.signInEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            asResponse: true,
        });
        const pending = cookieOf(signIn);

        const used = await getAuth().api.verifyBackupCode({
            body: { code: backupCode },
            headers: { cookie: pending } as never,
            asResponse: true,
        });
        assert.equal(used.ok, true);
        assert.equal((await getAuth().api.getSession({ headers: { cookie: cookieOf(used) } as never }))?.user?.email, "owner@example.com");

        // The same code cannot be used a second time
        const again = await getAuth().api.signInEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            asResponse: true,
        });
        const reused = await getAuth().api.verifyBackupCode({
            body: { code: backupCode },
            headers: { cookie: cookieOf(again) } as never,
            asResponse: true,
        });
        assert.equal(reused.ok, false);
        assert.ok(reused.status === 400 || reused.status === 401, `expected a clean refusal, got ${reused.status}`);
    });
});

test("disabling two factor needs the password and brings back the plain sign-in", async () => {
    await withDatabase(async () => {
        const cookie = await createTestAccount();
        const enabled = await startTwoFactor(cookie);
        const confirmed = await getAuth().api.verifyTOTP({
            body: { code: generateTotp(secretFromUri(enabled.totpURI)) },
            headers: { cookie } as never,
            asResponse: true,
        });
        const rotated = cookieOf(confirmed);

        const refusedDisable = await getAuth().api.disableTwoFactor({
            body: { password: "not-the-password" },
            headers: { cookie: rotated } as never,
            asResponse: true,
        });
        assert.equal(refusedDisable.status, 400);
        assert.match(await refusedDisable.text(), /password/i);

        const disabled = await getAuth().api.disableTwoFactor({
            body: { password: TEST_PASSWORD },
            headers: { cookie: rotated } as never,
            asResponse: true,
        });
        assert.equal(disabled.ok, true);

        const signIn = await getAuth().api.signInEmail({
            body: {
                email: "owner@example.com",
                password: TEST_PASSWORD,
            },
            asResponse: true,
        });
        const body = await signIn.clone().json() as { twoFactorRedirect? : boolean };
        assert.notEqual(body.twoFactorRedirect, true);
        assert.equal((await getAuth().api.getSession({ headers: { cookie: cookieOf(signIn) } as never }))?.user?.email, "owner@example.com");
    });
});
