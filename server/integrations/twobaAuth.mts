/**
 * twobaAuth.mts: OAuth 2.0 for the 2BA API, per user.
 *
 * Facts (2BA's discovery document, https://authorize.2ba.nl/.well-known/openid-configuration):
 * token endpoint /connect/token (form-urlencoded, client_secret_post accepted),
 * authorise /connect/authorize, revocation /connect/revocation, scopes openid,
 * profile and offline_access, PKCE S256. The access token lives about 120 s;
 * a refresh token is single use, and a used or expired one answers HTTP 400.
 *
 * Two ways to sign in, chosen per connection (`twoba_auth_mode_user_<id>`):
 *
 *   - password: the 2BA user name and password, stored sealed by
 *     configStore.setSecret like every other connection secret. A token is
 *     simply requested again when the cached one runs out.
 *   - authorization_code: the person signs in at 2BA in a popup
 *     (routes/integrations/twoba.mts, state + PKCE). Tokens live in the
 *     encrypted vault (stores/automationCredentialStore.js, provider `twoba`);
 *     Bee Flow never sees the password.
 *
 * Client id and secret are per user too (from 2BA, per software supplier). The
 * secret travels only in the body of the back-channel token call.
 *
 * Token handling: an access token is reused until 10 s before it expires. One
 * token request per connection at a time (concurrent tool calls in a loop wait
 * for it); a refreshed refresh token is written to the vault before the new
 * access token is handed out, so it is never used twice. A refresh that 2BA
 * refuses marks the connection as needing sign-in (a 401 for the caller, never
 * a 500).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AUTH_BASE, TwobaError, safeText, twobaFetch } from './twobaTransport.mts';
import {
    createConnectAttempt, pkceChallenge, stateMatches, type ConnectAttempt, type CredentialStore, type VaultCredential,
} from './shared/oauthConnectAttempt.mts';

export type { ConnectAttempt, VaultCredential };

const nodeRequire = createRequire(import.meta.url);

interface ConfigStore { getSecret: (key: string) => Promise<string | null | undefined> }

/** Stores, lazily: loading this module opens no database. Tests replace them. */
export const authDeps: { configStore: () => ConfigStore; credentials: () => CredentialStore; now: () => number } = {
    configStore: () => nodeRequire('../stores/configStore.js') as ConfigStore,
    credentials: () => nodeRequire('../stores/automationCredentialStore.js') as CredentialStore,
    now: () => Date.now(),
};

export const PROVIDER = 'twoba';
export const TOKEN_URL = `${AUTH_BASE}/connect/token`;
export const AUTHORIZE_URL = `${AUTH_BASE}/connect/authorize`;
export const REVOCATION_URL = `${AUTH_BASE}/connect/revocation`;
export const CODE_SCOPE = 'openid offline_access';
/** Reuse an access token until this much is left of it. */
export const EXPIRY_MARGIN_MS = 10_000;
/** How long a started sign-in stays valid. */
export const CONNECT_TTL_MS = 10 * 60_000;

export type AuthMode = 'password' | 'authorization_code';

export interface TwobaConfig {
    clientId: string;
    clientSecret: string;
    mode: AuthMode;
    username: string;
    password: string;
}

export async function configFor(userId: string): Promise<TwobaConfig> {
    const store = authDeps.configStore();
    const read = async (field: string) => String((await store.getSecret(`twoba_${field}_user_${userId}`)) || '').trim();
    const mode = (await read('auth_mode')) === 'authorization_code' ? 'authorization_code' : 'password';
    return {
        clientId: await read('client_id'),
        clientSecret: await read('client_secret'),
        mode,
        username: await read('username'),
        password: String((await store.getSecret(`twoba_password_user_${userId}`)) || ''),
    };
}

/** Everything a connection needs before a token can be asked for (a code-mode sign-in excepted). */
export function isConfigured(cfg: TwobaConfig): boolean {
    if (!cfg.clientId || !cfg.clientSecret) return false;
    return cfg.mode === 'authorization_code' || (!!cfg.username && !!cfg.password);
}

export const NOT_CONFIGURED = '2BA is not connected. Add the client id, client secret and sign-in in Settings > Connections.';
export const SIGN_IN_REQUIRED = 'The 2BA sign-in has expired or was revoked. Sign in with 2BA again in Settings > Connections.';
export const NOT_SIGNED_IN = '2BA is set up for "Sign in with 2BA", but nobody signed in yet. Sign in with 2BA in Settings > Connections.';

// ─── Token endpoint ──────────────────────────────────────────────

export interface TokenSet {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number;
    scope: string | null;
}

async function tokenRequest(cfg: TwobaConfig, form: Record<string, string>): Promise<TokenSet> {
    const response = await twobaFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ ...form, client_id: cfg.clientId, client_secret: cfg.clientSecret }).toString(),
    });
    const text = await safeText(response);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = {}; }
    if (!response.ok) throw tokenFailure(response.status, body);
    return tokenSetOf(body);
}

/** Why the token endpoint refused. Only the OAuth error code is read: the body may echo request data. */
function tokenFailure(status: number, body: Record<string, unknown>): TwobaError {
    const code = typeof body.error === 'string' ? body.error : '';
    if (code === 'invalid_client' || code === 'unauthorized_client') return new TwobaError(401, 'twoba_client_refused', '2BA refused the client id or client secret. Check them in Settings > Connections.');
    if (status === 400 || code === 'invalid_grant') return new TwobaError(401, 'twoba_grant_refused', '2BA refused the sign-in.');
    if (status >= 500 || status === 429) return new TwobaError(503, 'twoba_unavailable', '2BA could not sign in right now. Try again shortly.');
    return new TwobaError(502, 'twoba_token_failed', `2BA sign-in failed (HTTP ${status}).`);
}

function tokenSetOf(body: Record<string, unknown>): TokenSet {
    if (typeof body.access_token !== 'string' || !body.access_token) throw new TwobaError(502, 'twoba_token_failed', '2BA answered without an access token.');
    const expiresIn = Number(body.expires_in);
    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
        expiresAt: authDeps.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 120) * 1000,
        scope: typeof body.scope === 'string' ? body.scope : null,
    };
}

/** The password grant. A refused grant is a refused user name or password. */
export async function passwordToken(cfg: TwobaConfig): Promise<TokenSet> {
    try {
        return await tokenRequest(cfg, { grant_type: 'password', username: cfg.username, password: cfg.password });
    } catch (err) {
        if (err instanceof TwobaError && err.code === 'twoba_grant_refused') {
            throw new TwobaError(401, 'twoba_credentials_refused', '2BA refused the user name or password. Check them in Settings > Connections.');
        }
        throw err;
    }
}

// ─── The sign-in attempt (state + PKCE) ──────────────────────────

export function newConnectAttempt(userId: string, redirectUri: string): ConnectAttempt {
    return createConnectAttempt(userId, redirectUri, authDeps.now());
}

export const codeChallenge = pkceChallenge;

export function authorizeUrl(clientId: string, attempt: ConnectAttempt): string {
    const params = new URLSearchParams({
        client_id: clientId, response_type: 'code', scope: CODE_SCOPE, redirect_uri: attempt.redirectUri,
        state: attempt.state, code_challenge: codeChallenge(attempt.verifier), code_challenge_method: 'S256',
    });
    return `${AUTHORIZE_URL}?${params}`;
}

/** The callback's state: equal (constant time), for this user, at most CONNECT_TTL_MS old. */
export function attemptMatches(attempt: ConnectAttempt | null | undefined, receivedState: unknown, userId: string | null | undefined): boolean {
    return stateMatches(attempt, receivedState, userId, authDeps.now(), CONNECT_TTL_MS);
}

export function exchangeCode(cfg: TwobaConfig, code: string, attempt: ConnectAttempt): Promise<TokenSet> {
    return tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: attempt.redirectUri, code_verifier: attempt.verifier });
}

/** Best effort: revoke the refresh token at 2BA (that ends the grant). */
export async function revokeAt2ba(cfg: TwobaConfig, refreshToken: string | null): Promise<boolean> {
    if (!refreshToken || !cfg.clientId || !cfg.clientSecret) return false;
    try {
        const response = await twobaFetch(REVOCATION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: cfg.clientId, client_secret: cfg.clientSecret }).toString(),
        });
        return response.ok;
    } catch {
        return false; // the local delete still ends our access
    }
}

// ─── Access token for a call ─────────────────────────────────────

interface Cached { token: string; expiresAt: number; fingerprint: string }

/** Password mode: the access token per user, with the configuration it was issued for. */
const passwordCache = new Map<string, Cached>();
/** One token request per user at a time. */
const inFlight = new Map<string, Promise<string>>();

function fingerprint(cfg: TwobaConfig): string {
    return createHash('sha256').update([cfg.clientId, cfg.clientSecret, cfg.username, cfg.password].join('\u0000')).digest('hex');
}

function fresh(expiresAt: number | null | undefined): boolean {
    return !!expiresAt && expiresAt - authDeps.now() > EXPIRY_MARGIN_MS;
}

async function passwordAccess(userId: string, cfg: TwobaConfig): Promise<string> {
    const tokens = await passwordToken(cfg);
    passwordCache.set(userId, { token: tokens.accessToken, expiresAt: tokens.expiresAt, fingerprint: fingerprint(cfg) });
    return tokens.accessToken;
}

async function refreshAccess(userId: string, cfg: TwobaConfig, cred: VaultCredential): Promise<string> {
    const store = authDeps.credentials();
    if (!cred.refreshToken) {
        await store.markNeedsReauth(userId, PROVIDER, 'no refresh token');
        throw new TwobaError(401, 'twoba_sign_in_required', SIGN_IN_REQUIRED);
    }
    let tokens: TokenSet;
    try {
        tokens = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: cred.refreshToken });
    } catch (err) {
        if (!(err instanceof TwobaError) || err.code !== 'twoba_grant_refused') throw err;
        // Another replica may have rotated the token a moment ago: use its result.
        const again = await store.getCredential(userId, PROVIDER);
        if (again && again.status === 'active' && (again.expiresAt ?? 0) > (cred.expiresAt ?? 0) && fresh(again.expiresAt) && again.accessToken) return again.accessToken;
        await store.markNeedsReauth(userId, PROVIDER, 'refresh refused by 2BA');
        throw new TwobaError(401, 'twoba_sign_in_required', SIGN_IN_REQUIRED);
    }
    // Persist the rotated refresh token before the access token is used.
    await store.upsertCredential({ userId, orgId: cred.orgId, provider: PROVIDER, ...tokens });
    return tokens.accessToken;
}

async function codeAccess(userId: string, cfg: TwobaConfig, force: boolean): Promise<string> {
    const cred = await authDeps.credentials().getCredential(userId, PROVIDER);
    if (!cred) throw new TwobaError(401, 'twoba_not_signed_in', NOT_SIGNED_IN);
    if (cred.status !== 'active') throw new TwobaError(401, 'twoba_sign_in_required', SIGN_IN_REQUIRED);
    if (!force && cred.accessToken && fresh(cred.expiresAt)) return cred.accessToken;
    return refreshAccess(userId, cfg, cred);
}

/**
 * A usable access token for `userId`. `force` skips a cached token (after 2BA
 * answered 401 to it). Throws TwobaError.
 */
export async function accessTokenFor(userId: string, cfg: TwobaConfig, { force = false } = {}): Promise<string> {
    if (!isConfigured(cfg)) throw new TwobaError(400, 'twoba_not_configured', NOT_CONFIGURED);
    if (cfg.mode === 'password') {
        const cached = passwordCache.get(userId);
        if (!force && cached && cached.fingerprint === fingerprint(cfg) && fresh(cached.expiresAt)) return cached.token;
    }
    const running = inFlight.get(userId);
    if (running) return running;
    const attempt = (cfg.mode === 'password' ? passwordAccess(userId, cfg) : codeAccess(userId, cfg, force))
        .finally(() => inFlight.delete(userId));
    inFlight.set(userId, attempt);
    return attempt;
}

/** Forget the cached password-mode token (the connection changed or was removed). */
export function forgetToken(userId: string): void {
    passwordCache.delete(userId);
}
