/**
 * Pairing codes are kept as a hash. The code itself is shown once, to the
 * administrator who generated it; the row holds `s1:<scrypt of the code>`.
 *
 * The hash has a fixed salt, so a code can be looked up by its hash; scrypt
 * keeps working out the short code from a stored hash slow. Rows written
 * before hashing hold the code itself; a lookup accepts those too until they
 * run out (15 minutes).
 */

import crypto from 'node:crypto';

const PREFIX = 's1:';
const SALT = 'beeflow-nc-pairing-code-v1';

/** The code as compared: trimmed and upper case. */
export function normalisePairingCode(code: unknown): string {
    return String(code ?? '').trim().toUpperCase();
}

/** True for a stored value that is a hash (not a code written before hashing). */
export function isHashedPairingCode(stored: unknown): boolean {
    return typeof stored === 'string' && stored.startsWith(PREFIX);
}

/** The stored form of a code. */
export function hashPairingCode(code: unknown): Promise<string> {
    const normalised = normalisePairingCode(code);
    return new Promise((resolve, reject) => {
        crypto.scrypt(normalised, SALT, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
            if (err) reject(err);
            else resolve(PREFIX + key.toString('hex'));
        });
    });
}
