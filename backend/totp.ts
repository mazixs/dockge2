import { createHmac, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOKEN_LENGTH = 6;
const TIME_STEP_SECONDS = 30;
const MAX_CLOCK_SKEW_STEPS = 1;

function decodeBase32(value: string): Buffer | undefined {
    const normalized = value.replace(/=+$/g, "").replace(/\s/g, "").toUpperCase();
    if (!normalized) {
        return undefined;
    }

    const bytes: number[] = [];
    let bitBuffer = 0;
    let bitCount = 0;

    for (const character of normalized) {
        const index = BASE32_ALPHABET.indexOf(character);
        if (index === -1) {
            return undefined;
        }

        bitBuffer = (bitBuffer << 5) | index;
        bitCount += 5;

        if (bitCount >= 8) {
            bitCount -= 8;
            bytes.push((bitBuffer >> bitCount) & 0xff);
        }
    }

    return Buffer.from(bytes);
}

function createToken(secret: Buffer, counter: number): string {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    const digest = createHmac("sha1", secret).update(counterBuffer).digest();
    const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
    const binary = ((digest[offset] ?? 0) & 0x7f) * 0x1000000
        + (digest[offset + 1] ?? 0) * 0x10000
        + (digest[offset + 2] ?? 0) * 0x100
        + (digest[offset + 3] ?? 0);

    return String(binary % 1_000_000).padStart(TOKEN_LENGTH, "0");
}

/**
 * Verify a six-digit RFC 6238 time-based one-time password.
 * @param token User-provided one-time password.
 * @param secret Base32-encoded shared secret.
 * @param timestamp Unix timestamp in milliseconds; defaults to the current time.
 */
export function verifyTotpToken(token: unknown, secret: string | null | undefined, timestamp = Date.now()): boolean {
    if (typeof token !== "string" || !/^\d{6}$/.test(token) || !secret) {
        return false;
    }

    const decodedSecret = decodeBase32(secret);
    if (!decodedSecret) {
        return false;
    }

    const counter = Math.floor(timestamp / 1000 / TIME_STEP_SECONDS);
    const tokenBuffer = Buffer.from(token);

    for (let step = -MAX_CLOCK_SKEW_STEPS; step <= MAX_CLOCK_SKEW_STEPS; step++) {
        const candidateCounter = counter + step;
        if (candidateCounter < 0) {
            continue;
        }

        const candidate = Buffer.from(createToken(decodedSecret, candidateCounter));
        if (timingSafeEqual(candidate, tokenBuffer)) {
            return true;
        }
    }

    return false;
}
