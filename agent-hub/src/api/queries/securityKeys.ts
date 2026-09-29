// Security keys (YubiKey and other FIDO2 keys) — the ONLY place that knows the
// /auth/mfa/security-keys and /auth/mfa/security-key/* wire contracts, and the
// only place that talks to the browser's WebAuthn API.
//
// A security key is a second factor in its own right: an account can have an
// authenticator app, security keys, or both. The first key on an account
// without two-factor authentication turns it on and comes back with recovery
// codes; while 2FA is on, adding a key needs proof of an existing factor.
//
// Every ceremony call goes out with `retry: false`. A challenge answers once,
// so a silent retry after a 5xx would only come back as "that took too long".

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { apiClient, ApiError } from '../client';

export interface SecurityKey {
    id: string;
    name: string;
    /** The relying party the key was registered under; it only works there. */
    rpId: string;
    createdAt: string | null;
    lastUsedAt: string | null;
}

/**
 * A code, never a sentence; the component picks the words. Server codes pass
 * through as they are, browser failures are folded into the first four.
 */
export type SecurityKeyErrorCode =
    | 'cancelled'
    | 'already_registered'
    | 'webauthn_unavailable'
    | 'rate_limited'
    | 'invalid_code'
    | 'mfa_secret_unreadable'
    | 'mfa_not_enabled'
    | 'proof_required'
    | 'last_factor'
    | 'too_many_keys'
    | 'registration_expired'
    | 'challenge_expired'
    | 'security_key_rejected'
    | 'no_security_key_here'
    | 'no_pending_login'
    | 'mfa_attempts_exhausted'
    | 'failed';

const SERVER_CODES = new Set<string>([
    'webauthn_unavailable', 'invalid_code', 'mfa_secret_unreadable', 'mfa_not_enabled', 'proof_required', 'last_factor',
    'too_many_keys', 'registration_expired', 'challenge_expired', 'security_key_rejected',
    'already_registered', 'no_security_key_here', 'no_pending_login', 'mfa_attempts_exhausted',
]);

export const securityKeyKeys = {
    all: ['security-keys'] as const,
};

/** Can this browser, on this page, run a WebAuthn ceremony at all? */
export function securityKeysSupported(): boolean {
    try {
        return browserSupportsWebAuthn() && (typeof window === 'undefined' || window.isSecureContext !== false);
    } catch {
        return false;
    }
}

/**
 * Whether a key registered under `rpId` answers on `hostname`: the same host,
 * or a subdomain of it (a key made on example.com also works on
 * www.example.com, which is how the server picks the RP ID).
 */
export function isUsableHere(rpId: string, hostname: string = window.location.hostname): boolean {
    const host = hostname.toLowerCase();
    const rp = rpId.toLowerCase();
    return host === rp || host.endsWith(`.${rp}`);
}

/** Allow-list one list response. Anything malformed is dropped, not guessed at. */
export function parseSecurityKeys(body: unknown): SecurityKey[] {
    const keys = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys)) return [];
    const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    return keys.flatMap((raw): SecurityKey[] => {
        if (!raw || typeof raw !== 'object') return [];
        const k = raw as Record<string, unknown>;
        const id = str(k.id);
        const rpId = str(k.rpId);
        if (!id || !rpId) return [];
        return [{
            id,
            rpId,
            name: str(k.name) ?? '',
            createdAt: str(k.createdAt),
            lastUsedAt: str(k.lastUsedAt),
        }];
    });
}

// Browser failures, by the DOMException name or @simplewebauthn/browser code.
// NotAllowedError is both "closed the prompt" and "timed out": browsers do not
// tell the two apart, so neither can we.
const BROWSER_ERROR_CODES: Record<string, SecurityKeyErrorCode> = {
    NotAllowedError: 'cancelled',
    AbortError: 'cancelled',
    ERROR_CEREMONY_ABORTED: 'cancelled',
    InvalidStateError: 'already_registered',
    ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: 'already_registered',
    SecurityError: 'webauthn_unavailable',
    ERROR_INVALID_DOMAIN: 'webauthn_unavailable',
    ERROR_INVALID_RP_ID: 'webauthn_unavailable',
};

/** Map whatever a ceremony threw onto a code the UI can word. */
export function securityKeyErrorCode(err: unknown): SecurityKeyErrorCode {
    if (err instanceof ApiError) {
        if (err.status === 429) return 'rate_limited';
        const code = (err.body as { code?: unknown } | null)?.code;
        return typeof code === 'string' && SERVER_CODES.has(code) ? code as SecurityKeyErrorCode : 'failed';
    }
    const e = err as { name?: unknown; code?: unknown } | null;
    const byCode = typeof e?.code === 'string' ? BROWSER_ERROR_CODES[e.code] : undefined;
    const byName = typeof e?.name === 'string' ? BROWSER_ERROR_CODES[e.name] : undefined;
    return byCode ?? byName ?? 'failed';
}

// ── Settings: the caller's keys ─────────────────────────────────────────────

export function useSecurityKeys(enabled = true) {
    return useQuery<SecurityKey[], Error>({
        queryKey: securityKeyKeys.all,
        queryFn: ({ signal }) =>
            apiClient.get<unknown>('/auth/mfa/security-keys', { signal }).then(parseSecurityKeys),
        enabled,
    });
}

/**
 * Proof of a factor the account already has, for changing its factors while
 * 2FA is on: an authenticator or recovery code, or a key's answer.
 */
export type SecondFactorProof = { code: string } | { securityKey: AuthenticationResponseJSON };

/** Touch a key the account already has, as proof. Throws like the ceremonies. */
export async function proveWithSecurityKey(): Promise<{ securityKey: AuthenticationResponseJSON }> {
    const started = await apiClient.post<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        '/auth/mfa/security-keys/proof/options', {}, { retry: false },
    );
    if (!started?.options) throw new ApiError('No proof options', { status: 500 });
    return { securityKey: await startAuthentication({ optionsJSON: started.options }) };
}

export interface AddSecurityKeyInput {
    name?: string;
    /** Needed while 2FA is on; the account's first factor needs none. */
    proof?: SecondFactorProof;
}

export interface AddSecurityKeyResult {
    /** Present when this key turned two-factor authentication on: show once. */
    recoveryCodes?: string[];
}

/** Ask the server for a challenge, let the key answer it, hand the answer back. */
export async function addSecurityKey({ name, proof }: AddSecurityKeyInput): Promise<AddSecurityKeyResult> {
    const started = await apiClient.post<{ options: PublicKeyCredentialCreationOptionsJSON }>(
        '/auth/mfa/security-keys/registration/options',
        { ...(proof ?? {}), ...(name ? { name } : {}) },
        { retry: false },
    );
    if (!started?.options) throw new ApiError('No registration options', { status: 500 });
    const response = await startRegistration({ optionsJSON: started.options });
    const done = await apiClient.post<{ recoveryCodes?: unknown }>(
        '/auth/mfa/security-keys/registration/verify', { response }, { retry: false },
    );
    const codes = done?.recoveryCodes;
    return Array.isArray(codes) ? { recoveryCodes: codes.filter((c): c is string => typeof c === 'string') } : {};
}

export function useAddSecurityKey() {
    const qc = useQueryClient();
    return useMutation<AddSecurityKeyResult, unknown, AddSecurityKeyInput>({
        mutationFn: addSecurityKey,
        onSettled: () => { qc.invalidateQueries({ queryKey: securityKeyKeys.all }); },
    });
}

export function useRenameSecurityKey() {
    const qc = useQueryClient();
    return useMutation<unknown, unknown, { id: string; name: string }>({
        mutationFn: ({ id, name }) =>
            apiClient.patch(`/auth/mfa/security-keys/${encodeURIComponent(id)}`, { name }, { retry: false }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: securityKeyKeys.all }); },
    });
}

export function useRemoveSecurityKey() {
    const qc = useQueryClient();
    return useMutation<unknown, unknown, string>({
        mutationFn: (id) => apiClient.delete(`/auth/mfa/security-keys/${encodeURIComponent(id)}`, { retry: false }),
        onSuccess: () => { qc.invalidateQueries({ queryKey: securityKeyKeys.all }); },
    });
}

// ── Sign-in: the second factor of a pending password login ──────────────────

/** What /auth/mfa/security-key/verify-login answers once the login completes. */
export interface SecurityKeyLoginResult {
    success?: boolean;
    user?: unknown;
    recoveryKey?: string;
    error?: string;
}

/**
 * Complete a pending password login with a security key. Resolves with the
 * same body /auth/mfa/verify-login answers on success; throws otherwise (map
 * the error with securityKeyErrorCode).
 */
export async function signInWithSecurityKey(): Promise<SecurityKeyLoginResult> {
    const started = await apiClient.post<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        '/auth/mfa/security-key/options', {}, { retry: false },
    );
    if (!started?.options) throw new ApiError('No authentication options', { status: 500 });
    const response = await startAuthentication({ optionsJSON: started.options });
    const done = await apiClient.post<SecurityKeyLoginResult>(
        '/auth/mfa/security-key/verify-login', { response }, { retry: false },
    );
    return done ?? {};
}
