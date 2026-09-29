/**
 * The encryption PIN — Bee Flow's zero-knowledge setup for accounts that sign
 * in through SSO.
 *
 * A password account derives its key-encryption key from the password itself
 * (see src/auth/api.ts opaqueLogin). An SSO account has no password this app
 * ever sees, so it gets a second, separate secret: the encryption PIN. Same
 * OPAQUE protocol, different user identifier (`<userId>:pin` server-side) and
 * different AAD contexts — `dek-wrap:sso-pin` and `recovery-wrap:sso-pin`.
 * Those two strings are load-bearing: get one wrong and the envelope simply
 * fails to open, with no error that says why.
 *
 * This is a port of agent-hub/src/lib/opaque.js (opaquePinRegister /
 * opaquePinLogin) and keeps its two-path structure:
 *
 *   1. OPAQUE first. The PIN never leaves the device; the server stores only
 *      the wrapped DEK.
 *   2. The legacy routes as a fallback, for accounts still on
 *      `kdfMode: 'legacy_argon2'` whose DEK is wrapped with Argon2 in
 *      users.wrappedDEK. Those endpoints DO receive the PIN, and they unwrap
 *      (and transparently re-wrap) server-side.
 *
 * The fallback matters for a specific trap the web app documents: for a legacy
 * account, /pin/login/start answers `needsSetup: true` merely because there is
 * no opaqueRecord — which is NOT the same as "first-time setup". Treating it
 * as first-time setup sends the user round a loop where the PIN is never
 * checked. So `needsSetup` from OPAQUE is a reason to try the legacy endpoint,
 * never a conclusion on its own.
 */

import { api, ApiError } from '../../api/client';
import {
    deriveKEK,
    encryptDEKForServer,
    generateDEK,
    generateRecoveryKey,
    scrub,
    toBase64,
    unwrapDEK,
    wrapDEK,
    type WrappedKey,
} from '../../crypto/keys';
import * as opaque from '../../crypto/opaque';

/** AAD contexts. Shared with the browser — see the module header. */
const DEK_CONTEXT = 'dek-wrap:sso-pin';
const RECOVERY_CONTEXT = 'recovery-wrap:sso-pin';

/** The server's own floor (auth/login/ssoEncryptionRoutes.js). */
export const MIN_PIN_LENGTH = 6;

/**
 * Raised when the account already has a wrapped DEK and the server refused to
 * overwrite it (HTTP 409, `dek_already_exists`). Replacing it would orphan
 * every encrypted row the account owns, so this is surfaced as its own type
 * and the screen asks a very pointed question before retrying.
 */
export class EncryptionAlreadySetUpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EncryptionAlreadySetUpError';
    }
}

export interface PinSetupResult {
    /** Formatted recovery key, shown once. Null on the legacy path only if the server omitted it. */
    recoveryKey: string | null;
    /**
     * The DEK, base64 — non-null only on the OPAQUE path. The legacy endpoints
     * keep the key server-side in the session and never hand it back, so the
     * device vault stays empty and the app runs against the server's copy.
     */
    dek: string | null;
    /** Which path actually completed, for the message the screen shows. */
    mode: 'opaque' | 'legacy';
}

/**
 * First-time setup: choose a PIN, mint a DEK, wrap it twice.
 *
 * `confirmReplace` is the explicit "yes, destroy the old key" acknowledgement
 * the server demands; never pass it by default.
 */
export async function registerEncryptionPin(
    pin: string,
    { confirmReplace = false }: { confirmReplace?: boolean } = {},
): Promise<PinSetupResult> {
    try {
        return await opaquePinRegister(pin, confirmReplace);
    } catch (err) {
        if (err instanceof EncryptionAlreadySetUpError) throw err;
        // Anything else means this account cannot do OPAQUE (no server setup,
        // an older server, a legacy kdfMode). Fall through rather than
        // stranding the user on a screen they cannot leave.
        return legacyPinSetup(pin);
    }
}

async function opaquePinRegister(pin: string, confirmReplace: boolean): Promise<PinSetupResult> {
    const { clientRegistrationState, registrationRequest } = await opaque.startRegistrationAsync({
        password: pin,
    });

    const start = await api.post<{ registrationResponse: string }>(
        '/auth/opaque/pin/register/start',
        { registrationRequest },
        { retry: false },
    );
    if (!start?.registrationResponse) throw new Error('PIN registration could not be started.');

    const finished = await opaque.finishRegistrationAsync({
        clientRegistrationState,
        registrationResponse: start.registrationResponse,
        password: pin,
    });

    const kek = deriveKEK(finished.exportKey);
    const dek = generateDEK();
    const recovery = generateRecoveryKey();
    try {
        const wrappedDEK = wrapDEK(dek, kek, DEK_CONTEXT);
        const recoveryWrappedDEK = wrapDEK(dek, recovery.raw, RECOVERY_CONTEXT);

        try {
            await api.post(
                '/auth/opaque/pin/register/finish',
                {
                    registrationRecord: finished.registrationRecord,
                    wrappedDEK,
                    recoveryWrappedDEK,
                    ...(confirmReplace ? { confirmReplace: true } : {}),
                },
                { retry: false },
            );
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                throw new EncryptionAlreadySetUpError(err.message);
            }
            throw err;
        }

        return { recoveryKey: recovery.formatted, dek: toBase64(dek), mode: 'opaque' };
    } finally {
        scrub(kek, dek, recovery.raw);
    }
}

/** POST /auth/sso-encryption-setup — the PIN goes to the server on this path. */
async function legacyPinSetup(pin: string): Promise<PinSetupResult> {
    const res = await api.post<{ success?: boolean; recoveryKey?: string; error?: string }>(
        '/auth/sso-encryption-setup',
        { pin },
        { retry: false },
    );
    if (!res?.success) throw new Error(res?.error || 'Encryption setup failed.');
    return { recoveryKey: res.recoveryKey ?? null, dek: null, mode: 'legacy' };
}

export interface PinUnlockResult {
    dek: string | null;
    /** True when this account has never set a PIN — the screen must offer setup. */
    needsSetup: boolean;
    mode: 'opaque' | 'legacy';
}

/** Returning user: unlock the DEK with the PIN they already chose. */
export async function unlockEncryptionPin(pin: string): Promise<PinUnlockResult> {
    try {
        const result = await opaquePinLogin(pin);
        // A genuine wrong PIN throws; only "this account has no OPAQUE record"
        // reaches here as needsSetup, and that is inconclusive — see header.
        if (!result.needsSetup) return result;
    } catch (err) {
        if (err instanceof WrongPinError) throw err;
        // fall through to legacy
    }
    return legacyPinUnlock(pin);
}

export class WrongPinError extends Error {
    constructor() {
        super('That PIN is not correct.');
        this.name = 'WrongPinError';
    }
}

async function opaquePinLogin(pin: string): Promise<PinUnlockResult> {
    const { clientLoginState, startLoginRequest } = await opaque.startLoginAsync({ password: pin });

    const start = await api.post<{
        needsSetup?: boolean;
        loginResponse?: string;
        loginId?: string;
        wrappedDEK?: WrappedKey | null;
    }>('/auth/opaque/pin/login/start', { startLoginRequest }, { retry: false });

    if (!start) throw new Error('The server did not answer the unlock request.');
    if (start.needsSetup) return { dek: null, needsSetup: true, mode: 'opaque' };
    if (!start.loginResponse || !start.loginId) throw new Error('Malformed unlock response.');

    const finished = await opaque.finishLoginAsync({
        clientLoginState,
        loginResponse: start.loginResponse,
        password: pin,
    });
    // null is the protocol's way of saying the PIN is wrong. It is the only
    // signal there is, and it must not be softened into "try again later".
    if (!finished) throw new WrongPinError();

    const kek = deriveKEK(finished.exportKey);
    let dek: Uint8Array | null = null;
    try {
        let encryptedDEK: WrappedKey | null = null;
        if (start.wrappedDEK) {
            dek = unwrapDEK(start.wrappedDEK, kek, DEK_CONTEXT);
            // "Option B": the backend needs the key in memory to run AI over
            // the user's own rows for the life of the session, so it goes back
            // encrypted under the OPAQUE session key. See crypto/keys.ts.
            encryptedDEK = encryptDEKForServer(dek, finished.sessionKey);
        }

        const result = await api.post<{ success?: boolean }>(
            '/auth/opaque/pin/login/finish',
            { loginId: start.loginId, finishLoginRequest: finished.finishLoginRequest, encryptedDEK },
            { retry: false },
        );
        if (!result?.success) throw new WrongPinError();

        return { dek: dek ? toBase64(dek) : null, needsSetup: false, mode: 'opaque' };
    } finally {
        scrub(kek, dek);
    }
}

/** POST /auth/sso-encryption-unlock — 401 is a wrong PIN, not a dead session. */
async function legacyPinUnlock(pin: string): Promise<PinUnlockResult> {
    try {
        const res = await api.post<{ success?: boolean; needsSetup?: boolean; error?: string }>(
            '/auth/sso-encryption-unlock',
            { pin },
            { retry: false },
        );
        if (res?.needsSetup) return { dek: null, needsSetup: true, mode: 'legacy' };
        if (!res?.success) throw new WrongPinError();
        return { dek: null, needsSetup: false, mode: 'legacy' };
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) throw new WrongPinError();
        throw err;
    }
}

/**
 * Forgot the PIN: unwrap with the recovery key and set a new one.
 *
 * This stays on the server route even for OPAQUE accounts, exactly as the web
 * app does. /pin/login/start returns only `wrappedDEK` and never
 * `recoveryWrappedDEK`, so the client has nothing to unwrap with — the server
 * holds the recovery envelope and does the swap. A NEW recovery key comes back
 * and the old one stops working, which is why the result goes straight into
 * RecoveryKeyCard rather than being confirmed away.
 */
export async function recoverWithRecoveryKey(
    recoveryKey: string,
    newPin: string,
): Promise<{ recoveryKey: string | null }> {
    try {
        const res = await api.post<{ success?: boolean; recoveryKey?: string; error?: string }>(
            '/auth/sso-recovery',
            { recoveryKey: recoveryKey.trim(), newPin },
            { retry: false },
        );
        if (!res?.success) throw new Error(res?.error || 'Recovery failed.');
        return { recoveryKey: res.recoveryKey ?? null };
    } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
            throw new Error('That recovery key was not accepted. Check for a missing character.');
        }
        throw err;
    }
}
