/**
 * The organisation app token of option B, and the Graph session built on it.
 *
 * A client-credentials token (entraToken.mts) from the token endpoint of the
 * organisation's verified tenant, never `common`, with the credentials of the
 * app registration that serves that tenant. It is cached in this process per
 * `${clientId}|${tenantId}` while it has more than 10 minutes left. A token
 * whose readable `tid` claim is another tenant is refused and never cached.
 *
 * The session (`appSessionFor`) addresses one covered user by object id
 * (`graphUserPath: /users/<oid>`) and carries no refresh token and no `save`:
 * when Graph answers 401, msGraphClient finds nothing to refresh with and
 * throws NOT_CONNECTED; the app secret is never used as a refresh. The token
 * stays in memory: never in a response, a log or the credential vault.
 *
 * `resolveAppImportSession` is what the poller calls: coverage (coverage.mts,
 * re-checked at every call), then the token, then the session.
 */

import { createRequire } from 'node:module';
import { GUID, microsoftCredentialsForTenant } from '../../../auth/oauth/microsoftConnections.mts';
import { requestClientCredentialsToken } from '../teamsSetup/entraToken.mts';
import type { TokenResult } from '../teamsSetup/entraToken.mts';
import { probeTimeoutMs } from '../teamsSetup/limits.mts';
import { coverageForUser } from './coverage.mts';
import type { AuthConfigLike, CoverageReason, CoverageResult } from './coverage.mts';
import { orgVerifiedTenant } from './orgTenant.mts';

const nodeRequire = createRequire(import.meta.url);

interface AppTokenDeps {
    loadConfig: () => Promise<AuthConfigLike>;
    requestToken: typeof requestClientCredentialsToken;
    orgTenant: typeof orgVerifiedTenant;
    coverageForUser: typeof coverageForUser;
    log: { warn: (...args: unknown[]) => void };
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<AppTokenDeps>({
    loadConfig: () => (nodeRequire('../../../auth/permissions.js') as Pick<AppTokenDeps, 'loadConfig'>).loadConfig,
    requestToken: () => requestClientCredentialsToken,
    orgTenant: () => orgVerifiedTenant,
    coverageForUser: () => coverageForUser,
    log: () => nodeRequire('../../../telemetry/log.js'),
});

/** Kept while it has more than this left. */
export const TOKEN_REUSE_MARGIN_MS = 10 * 60_000;
const MAX_CACHED = 500;

const cache = new Map<string, { accessToken: string; expiresAt: number; roles: string[] | null }>();

/** Test seam: swap collaborators (the rest stay the real ones); also empties the token cache. */
export function init(overrides: Partial<AppTokenDeps> = {}): void {
    lazy.init(overrides);
    cache.clear();
}

/** Forget every cached token. */
export function resetAppTokenCache(): void { cache.clear(); }

export type AppToken = { ok: true; accessToken: string; roles: string[] | null; tenantId: string; clientId: string };
export type AppTokenFailure = { ok: false; result: TokenResult | { kind: 'not_configured' } | { kind: 'tenant_not_verified' } | { kind: 'tenant_mismatch' } };

/**
 * An app token for `orgId` at `tenantId`. The tenant must be the
 * organisation's verified tenant (asked again here) and a directory GUID.
 */
export async function getAppToken(a: { orgId: string; tenantId: string; now?: number }): Promise<AppToken | AppTokenFailure> {
    const tenantId = String(a.tenantId || '').toLowerCase();
    if (!GUID.test(tenantId)) return { ok: false, result: { kind: 'tenant_not_verified' } };
    const verified = await lazy.deps.orgTenant(a.orgId);
    if (!verified.ok || verified.tenantId !== tenantId) return { ok: false, result: { kind: 'tenant_not_verified' } };
    const creds = microsoftCredentialsForTenant(await lazy.deps.loadConfig(), tenantId);
    if (!creds) return { ok: false, result: { kind: 'not_configured' } };
    const now = a.now ?? Date.now();
    const key = `${creds.clientId}|${tenantId}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt - now > TOKEN_REUSE_MARGIN_MS) {
        return { ok: true, accessToken: hit.accessToken, roles: hit.roles ? [...hit.roles] : null, tenantId, clientId: creds.clientId };
    }
    cache.delete(key);
    const result = await lazy.deps.requestToken({ clientId: creds.clientId, clientSecret: creds.clientSecret, tenantId, timeoutMs: probeTimeoutMs() });
    if (!result.ok) return { ok: false, result };
    if (result.tokenTenantId && result.tokenTenantId !== tenantId) {
        lazy.deps.log.warn('[TeamsAppImport] app token refused: it was issued for another tenant than the one asked');
        return { ok: false, result: { kind: 'tenant_mismatch' } };
    }
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(key, { accessToken: result.accessToken, expiresAt: result.expiresAt, roles: result.roles ? [...result.roles] : null });
    return { ok: true, accessToken: result.accessToken, roles: result.roles ? [...result.roles] : null, tenantId, clientId: creds.clientId };
}

export interface AppSession { accessToken: string; graphUserPath: string; appOnly: true }

/**
 * The Graph session for one covered user. Throws unless the coverage is for
 * the token's tenant and names a valid object id.
 */
export function appSessionFor(coverage: CoverageResult, token: { accessToken: string; tenantId: string }): AppSession {
    if (!coverage || coverage.covered !== true) throw new TypeError('appSessionFor needs a covered user');
    if (!token?.accessToken || coverage.tenantId !== String(token.tenantId || '').toLowerCase()) throw new TypeError('appSessionFor: the token is for another tenant');
    if (!GUID.test(coverage.objectId)) throw new TypeError('appSessionFor: invalid object id');
    return { accessToken: token.accessToken, graphUserPath: `/users/${coverage.objectId.toLowerCase()}`, appOnly: true };
}

export type ResolvedAppSession =
    | { status: 'covered'; session: AppSession; transcriptAllowed: boolean }
    | { status: 'not_covered'; reason: CoverageReason }
    | { status: 'token_failed' };

const TRANSCRIPT_ROLE = 'OnlineMeetingTranscript.Read.All';

/** A short, body-free description of a failed token request, for the log. */
function failureKind(f: AppTokenFailure): string {
    const r = f.result as { kind?: string; aadsts?: number | null; timedOut?: boolean };
    if (r.kind === 'entra') return `entra${r.aadsts ? ` AADSTS${r.aadsts}` : ''}`;
    if (r.kind === 'network') return r.timedOut ? 'timeout' : 'network';
    return String(r.kind || 'unknown');
}

/**
 * The app session the poller may use for `userId` in `orgId`, or why not.
 * Coverage is decided now (with `fresh`, past every cache). Transcripts are
 * allowed only when the token's roles name the transcript permission.
 */
export async function resolveAppImportSession(userId: string, orgId: string | null, { fresh = false }: { fresh?: boolean } = {}): Promise<ResolvedAppSession> {
    const coverage = await lazy.deps.coverageForUser(userId, orgId, { fresh });
    if (!coverage.covered) return { status: 'not_covered', reason: coverage.reason };
    const token = await getAppToken({ orgId: String(orgId), tenantId: coverage.tenantId });
    if (!token.ok) {
        lazy.deps.log.warn(`[TeamsAppImport] no app token for user ${userId}: ${failureKind(token)}`);
        return { status: 'token_failed' };
    }
    return {
        status: 'covered',
        session: appSessionFor(coverage, token),
        transcriptAllowed: Array.isArray(token.roles) && token.roles.includes(TRANSCRIPT_ROLE),
    };
}
