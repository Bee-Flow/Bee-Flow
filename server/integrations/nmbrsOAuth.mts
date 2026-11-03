/**
 * nmbrsOAuth.mts: OAuth 2.0 for the Nmbrs REST API (authorisation code + PKCE).
 *
 * Facts, each from Nmbrs' own documentation:
 *   - Authorization code grant is "the only mean of authentication offered"; the
 *     authorise, token and revocation URLs below; the access token lives 1 hour; the
 *     refresh token 30 days, single use, a new one on every refresh; `offline_access`
 *     is needed to get one; the token endpoint takes HTTP Basic with
 *     urlEncoded(client_id):urlEncoded(client_secret).
 *     Source: https://nmbrs.stoplight.io/docs/nmbrs-restapi/e9e0f5292b4a1-authentication
 *   - PKCE: `code_challenge_methods_supported: ["plain", "S256"]`; revocation accepts
 *     client_secret_basic. Source: https://identityservice.nmbrs.com/.well-known/openid-configuration
 *   - Revocation request shape (`token`, `token_type_hint`): RFC 7009, the standard the
 *     discovery document's `revocation_endpoint` implements.
 *
 * The client id, client secret and subscription key are per user (the person's own
 * Nmbrs developer-portal app), stored as secrets in configStore like every other
 * NMBRS field. Tokens live in the encrypted automation vault
 * (stores/automationCredentialStore.js, provider `nmbrs`): never in a URL, a log line
 * or a response. The client secret travels only in the Authorization header of the
 * back-channel token / revocation calls.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { nmbrsFetch, safeText } from './nmbrsTransport.mts';
import { NMBRS_READ_SCOPES } from './nmbrsRest.mts';

const nodeRequire = createRequire(import.meta.url);

interface ConfigStore {
    getSecret: (key: string) => Promise<string | null | undefined>;
}
interface VaultCredential {
    userId: string;
    orgId: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: number | null;
    scope: string | null;
    status: string;
}
interface CredentialStore {
    getCredential: (userId: string, provider: string) => Promise<VaultCredential | null>;
    upsertCredential: (row: { userId: string; orgId: string; provider: string; accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null }) => Promise<void>;
    markNeedsReauth: (userId: string, provider: string, reason: string) => Promise<void>;
}

/** Stores, lazily: loading this module must not open the database. Tests replace them. */
export const oauthDeps: { configStore: () => ConfigStore; credentials: () => CredentialStore; now: () => number } = {
    configStore: () => nodeRequire('../stores/configStore.js') as ConfigStore,
    credentials: () => nodeRequire('../stores/automationCredentialStore.js') as CredentialStore,
    now: () => Date.now(),
};

export const PROVIDER = 'nmbrs';
export const AUTHORIZE_URL = 'https://identityservice.nmbrs.com/connect/authorize';
export const TOKEN_URL = 'https://identityservice.nmbrs.com/connect/token';
export const REVOCATION_URL = 'https://identityservice.nmbrs.com/connect/revocation';
/** How long a started connect attempt stays valid (the authorisation code itself lives 5 minutes). */
export const CONNECT_TTL_MS = 10 * 60_000;
/** Refresh when less than this is left of the access token. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

// ─── Client configuration (per user) ─────────────────────────────

export interface ClientConfig {
    clientId: string;
    clientSecret: string;
}

export async function clientConfigFor(userId: string): Promise<ClientConfig> {
    const store = oauthDeps.configStore();
    return {
        clientId: String((await store.getSecret(`nmbrs_client_id_user_${userId}`)) || ''),
        clientSecret: String((await store.getSecret(`nmbrs_client_secret_user_${userId}`)) || ''),
    };
}

export async function subscriptionKeyFor(userId: string): Promise<string> {
    return String((await oauthDeps.configStore().getSecret(`nmbrs_subscription_key_user_${userId}`)) || '');
}

/** HTTP Basic as the authentication article specifies: both parts URL-encoded first. */
export function basicAuth({ clientId, clientSecret }: ClientConfig): string {
    return `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
}

// ─── The connect attempt (state + PKCE) ──────────────────────────

/** What the session holds between /auth-url and /callback. Single use. */
export interface ConnectAttempt {
    state: string;
    verifier: string;
    redirectUri: string;
    userId: string;
    createdAt: number;
}

export function newConnectAttempt(userId: string, redirectUri: string): ConnectAttempt {
    return {
        state: randomBytes(16).toString('hex'),
        verifier: randomBytes(32).toString('base64url'),
        redirectUri,
        userId,
        createdAt: oauthDeps.now(),
    };
}

export function codeChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

export function authorizeUrl(clientId: string, attempt: ConnectAttempt): string {
    const params = new URLSearchParams({
        client_id: clientId,
        state: attempt.state,
        scope: NMBRS_READ_SCOPES.join(' '),
        response_type: 'code',
        redirect_uri: attempt.redirectUri,
        code_challenge: codeChallenge(attempt.verifier),
        code_challenge_method: 'S256',
    });
    return `${AUTHORIZE_URL}?${params}`;
}

/** The callback's state: equal (in constant time), for this user, and not older than CONNECT_TTL_MS. */
export function attemptMatches(attempt: ConnectAttempt | null | undefined, receivedState: unknown, userId: string | null | undefined): boolean {
    if (!attempt || typeof receivedState !== 'string' || !userId) return false;
    if (attempt.userId !== userId) return false;
    if (oauthDeps.now() - attempt.createdAt > CONNECT_TTL_MS) return false;
    const a = Buffer.from(receivedState);
    const b = Buffer.from(String(attempt.state || ''));
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

// ─── Token endpoint ──────────────────────────────────────────────

export interface TokenSet {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    scope: string | null;
}

/** An error the caller must answer with "reconnect" rather than "try again". */
export class NmbrsReauthError extends Error {
    readonly reauthRequired = true;
}

const FATAL_OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

async function tokenRequest(client: ClientConfig, form: Record<string, string>): Promise<TokenSet> {
    const response = await nmbrsFetch(TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: basicAuth(client), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
    });
    const text = await safeText(response);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = {}; }
    if (!response.ok) {
        // Only the OAuth error code is kept: the body may echo request data.
        const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
        if (FATAL_OAUTH_ERRORS.has(code)) throw new NmbrsReauthError(`NMBRS refused the grant (${code}).`);
        throw new Error(`NMBRS token request failed (${code}).`);
    }
    if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('NMBRS token response had no access token.');
    const expiresIn = Number(body.expires_in);
    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? oauthDeps.now() + expiresIn * 1000 : null,
        scope: typeof body.scope === 'string' ? body.scope : null,
    };
}

export function exchangeCode(client: ClientConfig, code: string, attempt: ConnectAttempt): Promise<TokenSet> {
    return tokenRequest(client, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: attempt.redirectUri,
        code_verifier: attempt.verifier,
    });
}

export function refreshTokens(client: ClientConfig, refreshToken: string): Promise<TokenSet> {
    return tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** Best effort: revoke the refresh token (that ends the grant), then the access token. */
export async function revokeAtNmbrs(client: ClientConfig, cred: { refreshToken: string | null; accessToken: string | null }): Promise<boolean> {
    if (!client.clientId || !client.clientSecret) return false;
    let ok = false;
    for (const [token, hint] of [[cred.refreshToken, 'refresh_token'], [cred.accessToken, 'access_token']] as const) {
        if (!token) continue;
        try {
            const response = await nmbrsFetch(REVOCATION_URL, {
                method: 'POST',
                headers: { Authorization: basicAuth(client), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
            });
            ok = ok || response.ok;
        } catch {
            // The local delete still cuts our access; Nmbrs lets the user revoke in its App Manager too.
        }
    }
    return ok;
}

// ─── Access for a tool call ──────────────────────────────────────

export type AccessResult = { token: string } | { error: string };

export const RECONNECT_MESSAGE = 'The NMBRS connection has expired or was revoked. Reconnect NMBRS in Settings → Integrations.';
const NOT_CONNECTED_MESSAGE = 'NMBRS REST is not connected yet. Connect NMBRS in Settings → Integrations.';
const TEMPORARY_MESSAGE = 'NMBRS could not refresh the connection right now. Try again shortly.';

/** One refresh per user at a time: a refresh token is single use, so two at once would kill the grant. */
const inFlight = new Map<string, Promise<AccessResult>>();

function stillFresh(cred: VaultCredential): boolean {
    return !!cred.accessToken && !!cred.expiresAt && cred.expiresAt - oauthDeps.now() > REFRESH_MARGIN_MS;
}

async function refreshFor(userId: string, cred: VaultCredential): Promise<AccessResult> {
    const store = oauthDeps.credentials();
    if (!cred.refreshToken) return { error: RECONNECT_MESSAGE };
    try {
        const fresh = await refreshTokens(await clientConfigFor(userId), cred.refreshToken);
        await store.upsertCredential({ userId, orgId: cred.orgId, provider: PROVIDER, ...fresh });
        return { token: fresh.accessToken };
    } catch (err) {
        if (!(err instanceof NmbrsReauthError)) return { error: TEMPORARY_MESSAGE };
        // Another server may have rotated the token a moment ago: use its result if so.
        const again = await store.getCredential(userId, PROVIDER);
        if (again && again.status === 'active' && stillFresh(again)) return { token: again.accessToken as string };
        await store.markNeedsReauth(userId, PROVIDER, err.message);
        return { error: RECONNECT_MESSAGE };
    }
}

/** A usable access token for `userId`, refreshed when it is about to expire. */
export async function accessTokenFor(userId: string): Promise<AccessResult> {
    const cred = await oauthDeps.credentials().getCredential(userId, PROVIDER);
    if (!cred) return { error: NOT_CONNECTED_MESSAGE };
    if (cred.status !== 'active') return { error: RECONNECT_MESSAGE };
    if (stillFresh(cred)) return { token: cred.accessToken as string };
    const running = inFlight.get(userId);
    if (running) return running;
    const attempt = refreshFor(userId, cred).finally(() => inFlight.delete(userId));
    inFlight.set(userId, attempt);
    return attempt;
}
