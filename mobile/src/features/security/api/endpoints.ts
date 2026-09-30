/**
 * Password, two-factor and app-password endpoints, under `/auth/…`
 * (auth/loginRoutes.js, auth/mfaRoutes.js, auth/admin/appPasswordRoutes.js).
 *
 * `startMfaSetup` and `enableMfa` are also what onboarding enrols with during
 * sign-in (through the index), where a null answer is an error instead.
 */

import { api, type RequestOptions } from '@/core/api/client';

import {
    readMfaSetup,
    readMfaStatus,
    readRecoveryCodes,
} from './readers';
import type {
    MfaSetup,
    MfaStatus,
    RecoveryCodesResponse,
} from '../model/types';

export async function getMfaStatus(signal?: AbortSignal): Promise<MfaStatus | null> {
    return readMfaStatus(await api.get<unknown>('/auth/mfa/status', { signal }));
}

/**
 * Mint (or re-read) the pending enrolment secret. It lives in the SESSION until
 * /enable accepts a code, and is idempotent for ten minutes, so re-opening the
 * screen shows the SAME QR the authenticator already has (a new secret under a
 * scanned QR made every code read as invalid: BFSF-274). Pass `force` only for
 * an explicit "start over". `retry` is the caller's (sign-in never retries).
 */
export async function startMfaSetup(
    force = false,
    { retry }: Pick<RequestOptions, 'retry'> = {},
): Promise<MfaSetup | null> {
    return readMfaSetup(await api.post<unknown>('/auth/mfa/setup', { force }, { retry }));
}

/** Verify a code against the pending secret and only then persist it. The
 *  recovery codes come back exactly once, in this response. */
export async function enableMfa(
    code: string,
    { retry }: Pick<RequestOptions, 'retry'> = {},
): Promise<RecoveryCodesResponse | null> {
    return readRecoveryCodes(await api.post<unknown>('/auth/mfa/enable', { code }, { retry }));
}

export async function disableMfa(code: string): Promise<void> {
    await api.post('/auth/mfa/disable', { code });
}

/** Returns a fresh set of one-time codes. The old set stops working the moment
 *  this resolves, so the caller MUST show them before navigating away. */
export async function regenerateRecoveryCodes(code: string): Promise<RecoveryCodesResponse | null> {
    return readRecoveryCodes(
        await api.post<unknown>('/auth/mfa/recovery-codes/regenerate', { code }),
    );
}

/** Re-wraps the data key under the new password — which is why the old one is
 *  required, and why this cannot be done from a reset link alone. */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await api.post('/auth/change-password', { oldPassword, newPassword });
}
