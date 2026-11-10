/**
 * Microsoft Teams → Meeting Notes setup and diagnostics, mounted at
 * /api/teams-setup behind the Meeting Notes module, the `meeting_notes`
 * licence feature and the capability-or-org-admin gate (index.js).
 *
 *   GET  /requirements       the permissions and redirect addresses an app registration needs (no Graph call)
 *   POST /me/diagnostics     the caller's own Teams test (read-only Graph probes), rate limited
 *   GET  /org/overview       per member of the caller's org: connection, permissions, skips, failures (stored state only)
 *   POST /org/consent-link   a Microsoft admin consent link for the caller's org
 *   GET  /org/app-import     organisation-wide import (option B): setting, availability, member counts
 *   PUT  /org/app-import     switch it on or off and choose who it covers (audited)
 *   POST /org/app-import/diagnostics   the option B test with one covered member, rate limited
 *
 * The organisation is always the caller's own (auth/orgScope.js: the account's
 * organisation, else the first one a group grants), re-read at every request
 * and never taken from a path, query or body, so a member of one organisation
 * cannot even name another. A failed read of it is a refusal.
 *
 * Nothing secret travels in a URL; no response carries a token, a client
 * secret, a scope string, a Graph body, a meeting subject, an attendee or an
 * e-mail address. The consent answer is recorded by the connect callback
 * (routes/integrations/microsoft365.js), never here.
 */

import { createRequire } from 'node:module';
import type { NextFunction, Request, Response } from 'express';
import { applicationPermissions, delegatedPermissions } from '../core/meetingNotes/teamsSetup/permissions.mts';
import { runUserDiagnostics } from '../core/meetingNotes/teamsSetup/userDiagnostics.mts';
import { buildOrgOverview, DEFAULT_WINDOW_DAYS } from '../core/meetingNotes/teamsSetup/membersOverview.mts';
import { tenantModeOf, testAppRegistration } from '../core/meetingNotes/teamsSetup/appRegistration.mts';
import type { AuthConfigLike } from '../core/meetingNotes/teamsSetup/appRegistration.mts';
import { buildAdminConsentUrl, consentClientId, consentTenantFor, newPendingConsent } from '../core/meetingNotes/teamsSetup/consent.mts';
import { takeDiagnosticsSlot } from '../core/meetingNotes/teamsSetup/rateLimit.mts';
import { GUID, microsoftCredentialsFor } from '../auth/oauth/microsoftConnections.mts';
import { appImportState, updateAppImport } from '../core/meetingNotes/teamsAppImport/coverage.mts';
import { runAppImportDiagnostics } from '../core/meetingNotes/teamsAppImport/diagnostics.mts';

const nodeRequire = createRequire(import.meta.url);

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
type HttpErrorCtor = new (status: number, code: string, message: string) => Error;
type Credential = { status?: string; scope?: string | null } | null;
/**
 * req.session as this router uses it. Typed here, because the agent-hub type check also
 * reaches this file (through auth/oauth/ssoConfigRoutes.js) without the server's types/express.d.ts.
 */
type RouteSession = { teamsAdminConsent?: unknown; save?: () => unknown } & Record<string, unknown>;

/** The express-session of the request; requireAuth guarantees one on every route here. */
function sessionOf(req: Request): RouteSession {
    const session = (req as Request & { session?: RouteSession }).session;
    if (!session) throw new Error('No session on an authenticated request');
    return session;
}

const express = nodeRequire('express') as typeof import('express');
const perms = nodeRequire('../auth/permissions.js') as {
    requireAuth: Handler;
    isOrgAdminForOrg: (req: Request, orgId: string) => Promise<boolean>;
};
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: HttpErrorCtor };
const { validate } = nodeRequire('../core/http/validate.js') as { validate: (schemas: Record<string, unknown>) => Handler };
const { z } = nodeRequire('../utils/zod.js') as { z: typeof import('zod').z };
const { NO_QUERY } = nodeRequire('./transcriptions/schemas.js') as { NO_QUERY: unknown };
const { tagGate } = nodeRequire('../auth/gateMeta.js') as { tagGate: <T>(fn: T, meta: Record<string, unknown>) => T };
const { sessionUser } = nodeRequire('../core/http/sessionUser.js') as { sessionUser: (req: Request) => { id: string; organizationId?: string } };

export interface TeamsSetupRouteDeps {
    loadConfig: () => Promise<AuthConfigLike>;
    identityBinding: (userId: string) => Promise<{ azureTenantId?: string | null } | null>;
    resolveTeamsSession: (req: Request) => Promise<{ session: unknown }>;
    getCredential: (userId: string, provider: string) => Promise<Credential>;
    orgScope: (req: Request, opts: { strict: boolean }) => Promise<{ orgId: string | null; identityError: string | null }>;
    buildRedirectUri: (req: Request) => string;
    getUser: (userId: string) => Promise<{ organizationId?: string | null } | null>;
    log: { warn: (...args: unknown[]) => void };
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../core/meetingNotes/lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<TeamsSetupRouteDeps>({
    loadConfig: () => (nodeRequire('../auth/permissions.js') as { loadConfig: TeamsSetupRouteDeps['loadConfig'] }).loadConfig,
    identityBinding: () => (nodeRequire('../stores/microsoftIdentityStore.js') as { getIdentityBinding: TeamsSetupRouteDeps['identityBinding'] }).getIdentityBinding,
    resolveTeamsSession: () => (nodeRequire('./transcriptions/teamsHelpers.js') as Pick<TeamsSetupRouteDeps, 'resolveTeamsSession'>).resolveTeamsSession,
    getCredential: () => {
        const store = nodeRequire('../stores/automationCredentialStore.js') as { getCredential: TeamsSetupRouteDeps['getCredential'] };
        return (userId: string, provider: string) => store.getCredential(userId, provider);
    },
    orgScope: () => (nodeRequire('../auth/orgScope.js') as { orgScope: TeamsSetupRouteDeps['orgScope'] }).orgScope,
    buildRedirectUri: () => (nodeRequire('./integrations/microsoft365.js') as { buildRedirectUri: TeamsSetupRouteDeps['buildRedirectUri'] }).buildRedirectUri,
    getUser: () => {
        const userStore = nodeRequire('../stores/userStore.js') as Pick<TeamsSetupRouteDeps, 'getUser'>;
        return (userId: string) => userStore.getUser(userId);
    },
    log: () => nodeRequire('../telemetry/log.js'),
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<TeamsSetupRouteDeps> = {}): void { lazy.init(overrides); }

const OverviewQuery = z.object({
    days: z.coerce.number({ error: 'The window must be a whole number of days from 1 to 30.' })
        .int('The window must be a whole number of days from 1 to 30.')
        .min(1, 'The window must be a whole number of days from 1 to 30.')
        .max(30, 'The window must be a whole number of days from 1 to 30.')
        .optional(),
}).strict();

const MEMBER_ID = z.string({ error: 'A member id must be text.' }).trim().min(1, 'A member id must not be empty.').max(128, 'A member id is at most 128 characters.');

// A request array is capped here; the configurable cap (TEAMS_APP_IMPORT_MAX_SELECTED_USERS) is applied after deduplication.
const AppImportBody = z.object({
    enabled: z.boolean({ error: 'enabled must be true or false.' }),
    coverage: z.enum(['all', 'selected'], { error: "coverage must be 'all' or 'selected'." }),
    selectedUserIds: z.array(MEMBER_ID, { error: 'selectedUserIds must be a list of member ids.' }).max(10000, 'At most 10000 members can be sent.'),
}).strict();

// A POST without a body tests with the caller.
const AppImportDiagBody = z.object({ probeUserId: MEMBER_ID.optional() }).strict().optional();

/** The two redirect addresses an app registration must list (Web platform). */
export function redirectUrisFor(req: Request, buildConnect: (r: Request) => string = lazy.deps.buildRedirectUri): { signIn: string; connect: string } {
    const host = process.env.SERVER_PUBLIC_HOST;
    const base = host ? `${process.env.SERVER_PROTOCOL || 'https'}://${host}` : `${req.protocol}://${req.get('host')}`;
    return { signIn: `${base}/auth/callback/microsoft`, connect: buildConnect(req) };
}

/** The caller's verified Microsoft tenant (users.azureTenantId), or null. */
export async function callerVerifiedTenant(userId: string, binding: TeamsSetupRouteDeps['identityBinding'] = lazy.deps.identityBinding): Promise<string | null> {
    try {
        const tid = (await binding(userId))?.azureTenantId;
        return typeof tid === 'string' && GUID.test(tid) ? tid.toLowerCase() : null;
    } catch (err) {
        lazy.deps.log.warn('[TeamsSetup] Microsoft identity unreadable:', (err as Error).message);
        return null;
    }
}

/**
 * The Microsoft branch of POST /auth/providers/:provider/test (auth/oauth/ssoConfigRoutes.js,
 * behind requireSuperAdmin): a real client-credentials token request against Entra, which
 * proves the client id, the secret and the tenant without any permission and changes nothing.
 * The answer keeps the `{ success, message }` / `{ error }` shape the SSO tab toasts and adds
 * the platform `report` (codes, the tenant, the redirect addresses; never the secret or the
 * token). One test per caller per TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS.
 */
export async function answerMicrosoftProviderTest(req: Request, config: AuthConfigLike): Promise<{ status: number; body: Record<string, unknown> }> {
    const userId = sessionUser(req).id;
    if (!takeDiagnosticsSlot(`platform:${userId}`)) throw new HttpError(429, 'diagnostics_rate_limited', 'Wait a few seconds before you test again');
    const report = await testAppRegistration({ config, callerTenantId: await callerVerifiedTenant(userId), redirectUris: redirectUrisFor(req) });
    const token = report.checks.find((c) => c.id === 'app.token');
    if (token?.status === 'pass') return { status: 200, body: { success: true, message: 'Microsoft accepted the app registration.', report } };
    if (token?.status === 'unknown') return { status: 400, body: { error: `The secret could not be tested: ${token.code}.`, report } };
    const failing = report.checks.find((c) => c.status === 'fail')
        || report.checks.find((c) => c.status !== 'pass' && c.status !== 'skipped')
        || token;
    return { status: 400, body: { error: `The Microsoft app registration test failed: ${failing?.code || 'unknown'}.`, report } };
}

/**
 * The organisation the caller acts in, re-read now; null when there is none.
 * A failed read throws (503): a refusal, never a guess.
 */
async function callerOrgId(req: Request): Promise<string | null> {
    let scope;
    try { scope = await lazy.deps.orgScope(req, { strict: true }); } catch {
        throw new HttpError(503, 'org_scope_unavailable', 'Your organisation could not be determined. Try again.');
    }
    if (scope.identityError) throw new HttpError(503, 'org_scope_unavailable', 'Your organisation could not be determined. Try again.');
    return scope.orgId || null;
}

/** Org admin of the caller's own organisation; the org is never taken from the request. */
export const requireSessionOrgAdmin = tagGate(async function requireSessionOrgAdmin(req: Request, res: Response, next: NextFunction) {
    sessionUser(req);
    const orgId = await callerOrgId(req);
    if (!orgId) throw new HttpError(404, 'no_organisation', 'Your account is not in an organisation');
    if (!(await perms.isOrgAdminForOrg(req, orgId))) throw new HttpError(403, 'not_org_admin', 'Only organisation admins can do this');
    res.locals.teamsSetupOrgId = orgId;
    next();
}, { axis: 'scope', kind: 'orgAdminOfSessionOrg', note: 'Org admin of the session organisation; the org is never taken from the request.' });

function requireDiagnosticsSlot(req: Request, _res: Response, next: NextFunction) {
    if (!takeDiagnosticsSlot(sessionUser(req).id)) throw new HttpError(429, 'diagnostics_rate_limited', 'Wait a few seconds before you test again');
    next();
}

async function requirements(req: Request, res: Response) {
    const config = await lazy.deps.loadConfig();
    const configured = !!microsoftCredentialsFor(config);
    res.json({
        tenantMode: configured ? (tenantModeOf(config) || 'not_configured') : 'not_configured',
        redirectUris: redirectUrisFor(req),
        delegated: delegatedPermissions(),
        application: applicationPermissions(),
    });
}

async function myDiagnostics(req: Request, res: Response) {
    const userId = sessionUser(req).id;
    let orgId: string | null = null;
    try { orgId = await callerOrgId(req); } catch { orgId = sessionUser(req).organizationId || null; }
    const [config, callerTenantId, resolved, credential] = await Promise.all([
        lazy.deps.loadConfig(),
        callerVerifiedTenant(userId),
        lazy.deps.resolveTeamsSession(req),
        lazy.deps.getCredential(userId, 'microsoft').catch((err: Error) => { lazy.deps.log.warn('[TeamsSetup] vault unreadable:', err.message); return null; }),
    ]);
    res.json(await runUserDiagnostics({
        userId, orgId, config, callerTenantId, session: resolved?.session ?? null, reqSession: sessionOf(req), credential,
    }));
}

async function orgOverview(req: Request, res: Response) {
    const orgId = String(res.locals.teamsSetupOrgId);
    const asked = (req.query as { days?: unknown }).days;
    const days = typeof asked === 'number' ? asked : DEFAULT_WINDOW_DAYS;
    const [config, callerTenantId] = await Promise.all([lazy.deps.loadConfig(), callerVerifiedTenant(sessionUser(req).id)]);
    res.json(await buildOrgOverview({ orgId, days, config, callerTenantId }));
}

async function consentLink(req: Request, res: Response) {
    const orgId = String(res.locals.teamsSetupOrgId);
    const [config, callerTenantId] = await Promise.all([lazy.deps.loadConfig(), callerVerifiedTenant(sessionUser(req).id)]);
    const tenant = consentTenantFor(config, callerTenantId);
    const clientId = tenant.ok ? consentClientId(config, tenant.tenantId) : null;
    if (!tenant.ok || !clientId) {
        res.json({ available: false, reason: tenant.ok ? 'app_not_configured' : tenant.reason });
        return;
    }
    const redirectUri = lazy.deps.buildRedirectUri(req);
    const pending = newPendingConsent(orgId, tenant.tenantId);
    const session = sessionOf(req);
    session.teamsAdminConsent = pending;
    session.save?.();
    res.json({
        available: true,
        url: buildAdminConsentUrl({ tenantId: tenant.tenantId, clientId, redirectUri, state: pending.state }),
        tenantId: tenant.tenantId,
        tenantSource: tenant.tenantSource,
        redirectUri,
        expiresAt: new Date(pending.expiresAt).toISOString(),
        permissions: { delegated: delegatedPermissions(), application: applicationPermissions() },
    });
}

async function getAppImport(_req: Request, res: Response) {
    res.json(await appImportState(String(res.locals.teamsSetupOrgId)));
}

async function putAppImport(req: Request, res: Response) {
    const body = req.body as { enabled: boolean; coverage: 'all' | 'selected'; selectedUserIds: string[] };
    const result = await updateAppImport({ orgId: String(res.locals.teamsSetupOrgId), actorId: sessionUser(req).id, body });
    if (!result.ok) throw new HttpError(result.status, result.code, result.message);
    res.json(result.state);
}

function requireAppImportDiagnosticsSlot(req: Request, _res: Response, next: NextFunction) {
    if (!takeDiagnosticsSlot(`org_app:${sessionUser(req).id}`)) throw new HttpError(429, 'diagnostics_rate_limited', 'Wait a few seconds before you test again');
    next();
}

async function appImportDiagnostics(req: Request, res: Response) {
    const orgId = String(res.locals.teamsSetupOrgId);
    const probeUserId = (req.body as { probeUserId?: string } | undefined)?.probeUserId || null;
    if (probeUserId) {
        const member = await lazy.deps.getUser(probeUserId);
        if (!member || member.organizationId !== orgId) throw new HttpError(400, 'not_a_member', 'The test member is not a member of this organisation');
    }
    res.json(await runAppImportDiagnostics({ orgId, callerId: sessionUser(req).id, probeUserId }));
}

export const teamsSetupRouter = express.Router();
teamsSetupRouter.get('/requirements', perms.requireAuth, validate({ query: NO_QUERY }), requirements);
teamsSetupRouter.post('/me/diagnostics', perms.requireAuth, validate({ query: NO_QUERY }), requireDiagnosticsSlot, myDiagnostics);
teamsSetupRouter.get('/org/overview', perms.requireAuth, requireSessionOrgAdmin, validate({ query: OverviewQuery }), orgOverview);
teamsSetupRouter.post('/org/consent-link', perms.requireAuth, requireSessionOrgAdmin, validate({ query: NO_QUERY }), consentLink);
teamsSetupRouter.get('/org/app-import', perms.requireAuth, requireSessionOrgAdmin, validate({ query: NO_QUERY }), getAppImport);
teamsSetupRouter.put('/org/app-import', perms.requireAuth, requireSessionOrgAdmin, validate({ body: AppImportBody, query: NO_QUERY }), putAppImport);
teamsSetupRouter.post('/org/app-import/diagnostics', perms.requireAuth, requireSessionOrgAdmin, validate({ body: AppImportDiagBody, query: NO_QUERY }),
    requireAppImportDiagnosticsSlot, appImportDiagnostics);
