/**
 * The Microsoft admin consent link for Teams meeting notes, and what came back.
 *
 * The link is Microsoft identity platform v2's admin consent endpoint
 * (`/{tenant}/v2.0/adminconsent`) with `scope=https://graph.microsoft.com/.default`:
 * Microsoft then asks an administrator to approve every permission listed on
 * the app registration, delegated and application alike. Its answer comes
 * back on the registered connect callback with `admin_consent`, `tenant`,
 * `scope`, `state`, or `error` and `error_description`.
 *
 * Trust: the callback records an outcome only when its `state` matches the
 * pending request in the same browser session (one pending request per
 * session, 30 minutes), and the org and tenant come from that session record.
 * The `tenant` in the query is only compared, never trusted: Microsoft's page
 * warns that the redirect can be forged. A forwarded link opened by another
 * person records nothing. The approval itself still counts in Entra; Bee Flow
 * only loses the note that it happened.
 *
 * Stored per organisation under `org_${orgId}_teams_admin_consent` (deleted
 * with the organisation by the `org_${orgId}_%` sweep). No user id is stored,
 * so account erasure has nothing to remove here.
 */

import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { GUID, microsoftCredentialsFor, microsoftCredentialsForTenant, normalizeTenantId } from '../../../auth/oauth/microsoftConnections.mts';
import type { MicrosoftProviderConfig } from '../../../auth/oauth/microsoftConnections.mts';
import type { Outcome } from './checks.mts';

const nodeRequire = createRequire(import.meta.url);

type ConfigStore = { getConfig(key: string): Promise<unknown>; setConfig(key: string, value: unknown): Promise<unknown> };
/** The request-shaped part the callback reads: the session and Microsoft's query. */
type CallbackSession = { teamsAdminConsent?: unknown; user?: { id?: unknown } | null; save?: () => unknown; [key: string]: unknown };
type CallbackRequest = { session?: CallbackSession | null; query: Record<string, unknown> };
interface ConsentDeps {
    configStore: ConfigStore;
    isOrgAdminForOrg: (req: CallbackRequest, orgId: string) => Promise<boolean>;
    orgScope: (req: CallbackRequest, opts: { strict: boolean }) => Promise<{ orgId: string | null; identityError: string | null }>;
    log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}
type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<ConsentDeps>({
    configStore: () => nodeRequire('../../../stores/configStore.js') as ConfigStore,
    isOrgAdminForOrg: () => (nodeRequire('../../../auth/permissions.js') as Pick<ConsentDeps, 'isOrgAdminForOrg'>).isOrgAdminForOrg,
    orgScope: () => (nodeRequire('../../../auth/orgScope.js') as Pick<ConsentDeps, 'orgScope'>).orgScope,
    log: () => nodeRequire('../../../telemetry/log.js'),
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<ConsentDeps> = {}): void { lazy.init(overrides); }

export type AuthConfigLike = { providers?: { microsoft?: MicrosoftProviderConfig } } | null | undefined;

export const CONSENT_STATE_TTL_MS = 30 * 60_000;
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
const OAUTH_ERROR = /^[a-z_]{1,64}$/;
const AADSTS_IN_TEXT = /AADSTS(\d{4,7})/;

export type ConsentTenant =
    | { ok: true; tenantId: string; tenantSource: 'configured' | 'your_account' }
    | { ok: false; reason: 'tenant_unknown' | 'tenant_consumers' | 'app_not_configured' };

export type AdminConsentOutcome = 'granted' | 'denied' | 'tenant_mismatch';
export interface AdminConsentRecordInput { outcome: AdminConsentOutcome; error?: string | null; aadsts?: string | null; tenantId: string; byUserId?: string | null }
export interface AdminConsentRecord { outcome: AdminConsentOutcome; error: string | null; aadsts: string | null; tenantId: string; at: string }

/** The pending consent request a browser session holds (`req.session.teamsAdminConsent`). */
export interface PendingConsent { state: string; orgId: string; tenantId: string; expiresAt: number }

const consentKey = (orgId: string) => `org_${orgId}_teams_admin_consent`;

/**
 * Which tenant the link asks: the configured tenant when it is a GUID, else
 * the caller's verified tenant when the app is multi-tenant; never `consumers`.
 */
export function consentTenantFor(config: AuthConfigLike, callerTenantId: string | null): ConsentTenant {
    if (!microsoftCredentialsFor(config)) return { ok: false, reason: 'app_not_configured' };
    const configured = normalizeTenantId(config?.providers?.microsoft?.tenantId);
    if (configured === 'consumers') return { ok: false, reason: 'tenant_consumers' };
    let picked: ConsentTenant;
    if (configured && GUID.test(configured)) picked = { ok: true, tenantId: configured, tenantSource: 'configured' };
    else if ((configured === 'common' || configured === 'organizations') && callerTenantId && GUID.test(callerTenantId)) {
        picked = { ok: true, tenantId: callerTenantId.toLowerCase(), tenantSource: 'your_account' };
    } else return { ok: false, reason: 'tenant_unknown' };
    if (!microsoftCredentialsForTenant(config, picked.tenantId)) return { ok: false, reason: 'app_not_configured' };
    return picked;
}

/** The client id the link names: the registration that serves the tenant. */
export function consentClientId(config: AuthConfigLike, tenantId: string): string | null {
    return microsoftCredentialsForTenant(config, tenantId)?.clientId || null;
}

export function buildAdminConsentUrl(a: { tenantId: string; clientId: string; redirectUri: string; state: string }): string {
    if (!GUID.test(a.tenantId)) throw new TypeError('buildAdminConsentUrl needs a directory (tenant) GUID');
    const query = new URLSearchParams({ client_id: a.clientId, scope: GRAPH_DEFAULT_SCOPE, redirect_uri: a.redirectUri, state: a.state });
    return `https://login.microsoftonline.com/${a.tenantId.toLowerCase()}/v2.0/adminconsent?${query.toString()}`;
}

/** A fresh pending request for the session: 32 random bytes as hex, 30 minutes. */
export function newPendingConsent(orgId: string, tenantId: string, now: number = Date.now()): PendingConsent {
    return { state: randomBytes(32).toString('hex'), orgId, tenantId: tenantId.toLowerCase(), expiresAt: now + CONSENT_STATE_TTL_MS };
}

/** Constant-time comparison of the returned state with the pending one. */
export function statesMatch(received: unknown, expected: unknown): boolean {
    if (typeof received !== 'string' || typeof expected !== 'string' || !received || !expected) return false;
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function isPending(v: unknown): v is PendingConsent {
    const p = v as PendingConsent | null;
    return !!p && typeof p.state === 'string' && typeof p.orgId === 'string' && typeof p.tenantId === 'string' && typeof p.expiresAt === 'number';
}

/**
 * Whether a callback may record anything: a signed-in caller, a pending
 * request that has not expired, the same state, the same organisation, and
 * the caller still an admin of it (checked by the caller of this function).
 */
export function callbackIsTrusted(a: { pending: unknown; state: unknown; userId: string | null | undefined; sessionOrgId: string | null; isOrgAdmin: boolean; now?: number }): boolean {
    if (!a.userId || !isPending(a.pending)) return false;
    if ((a.now ?? Date.now()) > a.pending.expiresAt) return false;
    if (!statesMatch(a.state, a.pending.state)) return false;
    return a.sessionOrgId === a.pending.orgId && a.isOrgAdmin;
}

/** What Microsoft's answer says, against the tenant the pending request asked. */
export function outcomeOfCallback(query: Record<string, unknown>, pendingTenantId: string): Omit<AdminConsentRecordInput, 'tenantId' | 'byUserId'> {
    if (query.error !== undefined) {
        const description = typeof query.error_description === 'string' ? query.error_description.slice(0, 4096) : '';
        const match = AADSTS_IN_TEXT.exec(description);
        return { outcome: 'denied', error: typeof query.error === 'string' && OAUTH_ERROR.test(query.error) ? query.error : 'unknown', aadsts: match ? `AADSTS${match[1]}` : null };
    }
    if (query.admin_consent === 'True' && String(query.tenant).toLowerCase() === pendingTenantId) return { outcome: 'granted' };
    return { outcome: 'tenant_mismatch' };
}

export async function recordAdminConsentOutcome(orgId: string, o: AdminConsentRecordInput): Promise<void> {
    const record: AdminConsentRecord = {
        outcome: o.outcome,
        error: o.outcome === 'denied' ? (o.error || 'unknown') : null,
        aadsts: o.outcome === 'denied' ? (o.aadsts || null) : null,
        tenantId: String(o.tenantId || '').toLowerCase(),
        at: new Date().toISOString(),
    };
    await lazy.deps.configStore.setConfig(consentKey(orgId), record);
}

export async function readAdminConsentOutcome(orgId: string): Promise<AdminConsentRecord | null> {
    const v = await lazy.deps.configStore.getConfig(consentKey(orgId)) as AdminConsentRecord | null;
    if (!v || typeof v !== 'object' || !['granted', 'denied', 'tenant_mismatch'].includes(v.outcome)) return null;
    return v;
}

async function soft<T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try { return await run(); } catch (err) {
        lazy.deps.log.warn(`[TeamsSetup] admin consent answer: ${what} failed:`, (err as Error).message);
        return fallback;
    }
}

/**
 * Microsoft's answer on the connect callback (`admin_consent` in the query).
 * The pending request leaves the session first, whatever happens next. An
 * outcome is recorded only for a trusted answer (callbackIsTrusted: a session
 * user, a fresh matching state, the same organisation now, still its admin).
 * `recorded: false` means the caller shows a neutral page and nothing was written.
 */
export async function answerAdminConsent(req: CallbackRequest): Promise<{ recorded: boolean; granted: boolean }> {
    const session = req.session || null;
    const pending: unknown = session?.teamsAdminConsent;
    if (session) {
        delete session.teamsAdminConsent;
        session.save?.();
    }
    const userId = typeof session?.user?.id === 'string' ? session.user.id : null;
    if (!userId || !isPending(pending)) return { recorded: false, granted: false };
    const [isOrgAdmin, scope] = await Promise.all([
        soft('admin check', () => lazy.deps.isOrgAdminForOrg(req, pending.orgId), false),
        soft('organisation lookup', () => lazy.deps.orgScope(req, { strict: true }), null),
    ]);
    const sessionOrgId = scope && !scope.identityError ? scope.orgId : null;
    if (!callbackIsTrusted({ pending, state: req.query.state, userId, sessionOrgId, isOrgAdmin })) return { recorded: false, granted: false };
    const outcome = outcomeOfCallback(req.query, pending.tenantId);
    await recordAdminConsentOutcome(pending.orgId, { ...outcome, tenantId: pending.tenantId, byUserId: userId });
    lazy.deps.log.info(`[TeamsSetup] admin consent answer recorded for org ${pending.orgId}: ${outcome.outcome}`);
    return { recorded: true, granted: outcome.outcome === 'granted' };
}

/** org.consent_link (catalogue 3.3): whether a link can be made, without making one. */
export function consentLinkOutcome(config: AuthConfigLike, callerTenantId: string | null): Outcome {
    const t = consentTenantFor(config, callerTenantId);
    if (t.ok) return { status: 'pass', code: 'ok', params: { tenantSource: t.tenantSource, tenantId: t.tenantId } };
    if (t.reason === 'tenant_unknown') return { status: 'unknown', code: 'tenant_unknown', fix: 'sign_in_with_microsoft_or_set_tenant', fixer: 'platform_admin' };
    if (t.reason === 'tenant_consumers') return { status: 'warn', code: 'tenant_consumers', fix: 'tenant_not_consumers', fixer: 'platform_admin' };
    return { status: 'fail', code: 'app_not_configured', fix: 'configure_app_registration', fixer: 'platform_admin' };
}

/** org.admin_consent (catalogue 3.3): the last recorded answer. */
export function adminConsentOutcome(record: AdminConsentRecord | null): Outcome {
    if (!record) return { status: 'unknown', code: 'consent_not_recorded', fix: 'open_consent_link', fixer: 'entra_admin' };
    if (record.outcome === 'granted') return { status: 'pass', code: 'consent_granted', params: { at: record.at, tenantId: record.tenantId } };
    if (record.outcome === 'denied') {
        return { status: 'fail', code: 'consent_denied', params: { error: record.error || 'unknown', at: record.at, ...(record.aadsts ? { aadsts: record.aadsts } : {}) }, fix: 'consent_denied', fixer: 'entra_admin' };
    }
    return { status: 'fail', code: 'consent_tenant_mismatch', params: { at: record.at }, fix: 'open_consent_link', fixer: 'entra_admin' };
}
