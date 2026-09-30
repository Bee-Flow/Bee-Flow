/**
 * The sign-in endpoints, in the order the server expects them.
 *
 * This mirrors agent-hub/src/pages/LoginPage.jsx's handleLogin and
 * src/lib/opaque.js, because the sequence is not obvious from the endpoints
 * alone:
 *
 *   1. POST /auth/admin-login with the password.
 *      - `useOpaque: true` (HTTP 400) means the account migrated to OPAQUE.
 *        The password was NOT checked; run the OPAQUE flow instead. The server
 *        deliberately answers this before verifying anything, so it is a
 *        protocol hint, not a rejection.
 *      - `mfaRequired` means the password WAS verified and a second factor is
 *        owed → POST /auth/mfa/verify-login.
 *      - `emailVerificationRequired`, `pendingApproval` are terminal states
 *        with their own screens.
 *   2. OPAQUE is a three-leg exchange with client-side key unwrapping in the
 *      middle; see opaqueLogin below.
 *
 * MFA does NOT apply to the OPAQUE path — server/auth/opaqueRoutes.js's
 * /login/finish establishes the session directly. Modelling that faithfully
 * matters: prompting for a code the server will not check would be a dead end.
 */

import { api } from '@/core/api/client';
import {
    deriveKEK,
    encryptDEKForServer,
    scrub,
    toBase64,
    unwrapDEK,
    type WrappedKey,
} from '@/core/crypto/keys';
import * as opaque from '@/core/crypto/opaque';

import {
    readCurrentUser,
    readLoginResponse,
    readOpaqueLoginFinish,
    readOpaqueLoginStart,
    readPermissions,
} from './readers';
import type { CurrentUserResponse, LoginResponse, OpaqueLoginFinishResponse, PermissionsResponse } from './types';


export async function fetchCurrentUser(signal?: AbortSignal): Promise<CurrentUserResponse> {
    // Retries on purpose, unlike the login calls below. This is the first
    // request of a cold start, made the instant the app is opened — which on a
    // phone is routinely the instant before the radio has associated. It used
    // to run with `retry: false`, so one unlucky packet at launch put a signed-
    // in user at the login screen. The backoff costs a few hundred milliseconds
    // in the bad case and nothing in the good one, and there is no throttle
    // here to trip: /auth/user is a read.
    return readCurrentUser(await api.get<unknown>('/auth/user', { signal }));
}

export async function fetchPermissions(signal?: AbortSignal): Promise<PermissionsResponse | null> {
    return readPermissions(await api.get<unknown>('/auth/my-permissions', { signal }));
}

/**
 * Step 1. Note `retry: false`: a login attempt is rate-limited and
 * throttled per identifier (server/auth/loginThrottle.js), so silently
 * retrying a 500 would spend the user's attempts and could lock them out.
 */
export async function passwordLogin(username: string, password: string): Promise<LoginResponse> {
    try {
        return readLoginResponse(
            await api.post<unknown>('/auth/admin-login', { username, password }, { retry: false }),
        );
    } catch (err) {
        // The OPAQUE hint arrives as HTTP 400 with a body, which the client
        // turns into an ApiError. It is a routing instruction, not a failure.
        const body = readLoginResponse((err as { body?: unknown } | undefined)?.body);
        if (body.useOpaque) return body;
        throw err;
    }
}

export async function verifyMfaLogin(code: string): Promise<LoginResponse> {
    return readLoginResponse(await api.post<unknown>('/auth/mfa/verify-login', { code }, { retry: false }));
}

export interface OpaqueLoginResult {
    success: boolean;
    user: OpaqueLoginFinishResponse['user'];
    /**
     * The unwrapped data encryption key, base64. Held only in memory by the
     * vault; never written to disk in this form.
     */
    dek: string | null;
    /** True when the account has a recovery blob, so the UI can offer recovery. */
    hasRecoveryKey: boolean;
}

/**
 * OPAQUE sign-in — the port of agent-hub/src/lib/opaque.js opaqueLogin().
 *
 * The server never sees the password. What it does see, at the end, is the DEK
 * encrypted under the OPAQUE session key ("Option B" in the web comments): the
 * backend needs the key in memory to run AI over the user's own data for the
 * life of the session. That is a deliberate product decision, not a leak — but
 * it is why `encryptedDEK` is sent and why the session key never touches disk.
 */
export async function opaqueLogin(
    username: string,
    password: string,
    /**
     * Reports 0..1 while the key-stretching runs. That step is Argon2id at
     * 64 MiB in pure JavaScript — the single slowest thing the app does, and
     * measurably slower on Hermes than the ~1 s it costs on a desktop V8. The
     * sign-in screen shows this so the wait is legible instead of looking like
     * a frozen button.
     */
    onProgress?: (fraction: number) => void,
): Promise<OpaqueLoginResult> {
    const { clientLoginState, startLoginRequest } = await opaque.startLoginAsync({ password });

    const start = readOpaqueLoginStart(
        await api.post<unknown>('/auth/opaque/login/start', { username, startLoginRequest }, { retry: false }),
    );
    if (!start) throw new Error('The server did not answer the sign-in request.');

    const finished = await opaque.finishLoginAsync({
        clientLoginState,
        loginResponse: start.loginResponse,
        password,
        onProgress,
    });
    // A null result is the protocol saying the password is wrong. The server
    // answers a well-formed response for accounts that do not exist too (see
    // fakeRecordFor in opaqueRoutes.js), so this is also what "no such user"
    // looks like — deliberately indistinguishable.
    if (!finished) throw new InvalidCredentialsError();

    let dek: Uint8Array | null = null;
    let encryptedDEK: WrappedKey | null = null;
    const kek = deriveKEK(finished.exportKey);
    try {
        if (start.wrappedDEK) {
            // AAD context is `dek-wrap:<username>` — the username as the user
            // typed it, which is what the browser used when wrapping.
            dek = unwrapDEK(start.wrappedDEK, kek, `dek-wrap:${username}`);
            encryptedDEK = encryptDEKForServer(dek, finished.sessionKey);
        }

        const result = readOpaqueLoginFinish(
            await api.post<unknown>(
                '/auth/opaque/login/finish',
                { loginId: start.loginId, finishLoginRequest: finished.finishLoginRequest, encryptedDEK },
                { retry: false },
            ),
        );
        if (!result?.success) throw new InvalidCredentialsError();

        return {
            success: true,
            user: result.user,
            dek: dek ? toBase64(dek) : null,
            hasRecoveryKey: Boolean(start.recoveryWrappedDEK),
        };
    } finally {
        scrub(kek, dek);
    }
}

export class InvalidCredentialsError extends Error {
    constructor() {
        // Wording matches the server's generic answer on purpose: the client
        // must not be more specific than the server about which half was wrong.
        super('Invalid credentials');
        this.name = 'InvalidCredentialsError';
    }
}

export async function logout(): Promise<void> {
    // Best-effort: a failed logout must still clear local state, or a user who
    // is offline can never sign out of their own device.
    try {
        await api.post('/auth/logout', undefined, { retry: false, timeoutMs: 8000 });
    } catch {
        /* local sign-out proceeds regardless */
    }
}
