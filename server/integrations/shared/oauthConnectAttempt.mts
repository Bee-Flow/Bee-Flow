/**
 * oauthConnectAttempt.mts: the authorization-code sign-in of a per-user
 * integration (NMBRS, 2BA), between GET /auth-url and GET /callback.
 *
 * The session holds one attempt: a random state, a PKCE verifier (S256), the
 * redirect address and the user it was started for. The callback takes it out
 * (single use) and accepts the state only when it is equal (constant time), for
 * the same signed-in user and not older than the integration's time-to-live.
 *
 * Also the shape of the encrypted vault (stores/automationCredentialStore.js)
 * as these integrations read it, so each one types it the same way.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** What the session holds between /auth-url and /callback. Single use. */
export interface ConnectAttempt {
    state: string;
    verifier: string;
    redirectUri: string;
    userId: string;
    createdAt: number;
}

export function createConnectAttempt(userId: string, redirectUri: string, now: number): ConnectAttempt {
    return { state: randomBytes(16).toString('hex'), verifier: randomBytes(32).toString('base64url'), redirectUri, userId, createdAt: now };
}

/** The S256 code challenge of a PKCE verifier. */
export function pkceChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

/** The callback's state: equal (in constant time), for this user, and not older than `ttlMs`. */
export function stateMatches(attempt: ConnectAttempt | null | undefined, receivedState: unknown, userId: string | null | undefined, now: number, ttlMs: number): boolean {
    if (!attempt || typeof receivedState !== 'string' || !userId || attempt.userId !== userId) return false;
    if (now - attempt.createdAt > ttlMs) return false;
    const a = Buffer.from(receivedState);
    const b = Buffer.from(String(attempt.state || ''));
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** A vault row as stores/automationCredentialStore.js answers it. */
export interface VaultCredential {
    userId: string;
    orgId: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: number | null;
    scope?: string | null;
    status: string;
}

/** The part of stores/automationCredentialStore.js a token refresh uses. */
export interface CredentialStore {
    getCredential: (userId: string, provider: string) => Promise<VaultCredential | null>;
    upsertCredential: (row: { userId: string; orgId: string; provider: string; accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null }) => Promise<void>;
    markNeedsReauth: (userId: string, provider: string, reason: string) => Promise<void>;
}
