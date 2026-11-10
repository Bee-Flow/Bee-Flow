/**
 * The Microsoft branch of POST /auth/providers/:provider/test, and the two facts it shares
 * with the Teams setup router: the redirect addresses an app registration must list and the
 * caller's verified Microsoft tenant.
 *
 * It lives apart from teamsSetup.mts on purpose: auth/oauth/ssoConfigRoutes.js loads
 * it, and that file is also read by type checks that run without the server's packages, so
 * this module names no package type. A request is described by the two members it reads.
 */

import { createRequire } from 'node:module';
import { testAppRegistration } from '../core/meetingNotes/teamsSetup/appRegistration.mts';
import type { AuthConfigLike } from '../core/meetingNotes/teamsSetup/appRegistration.mts';
import { takeDiagnosticsSlot } from '../core/meetingNotes/teamsSetup/rateLimit.mts';
import { GUID } from '../auth/oauth/microsoftConnections.mts';

const nodeRequire = createRequire(import.meta.url);

/** What this module reads of an incoming request. */
export interface ProviderTestRequest {
    protocol: string;
    get(name: string): string | undefined;
}

type HttpErrorCtor = new (status: number, code: string, message: string) => Error;
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: HttpErrorCtor };
const { sessionUser } = nodeRequire('../core/http/sessionUser.js') as { sessionUser: (req: unknown) => { id: string } };

export interface ProviderTestDeps {
    identityBinding: (userId: string) => Promise<{ azureTenantId?: string | null } | null>;
    /** The connect callback address for this request (routes/integrations/microsoft365.js). */
    buildRedirectUri: (req: never) => string;
    log: { warn: (...args: unknown[]) => void };
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../core/meetingNotes/lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<ProviderTestDeps>({
    identityBinding: () => (nodeRequire('../stores/microsoftIdentityStore.js') as { getIdentityBinding: ProviderTestDeps['identityBinding'] }).getIdentityBinding,
    buildRedirectUri: () => (nodeRequire('./integrations/microsoft365.js') as Pick<ProviderTestDeps, 'buildRedirectUri'>).buildRedirectUri,
    log: () => nodeRequire('../telemetry/log.js'),
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<ProviderTestDeps> = {}): void { lazy.init(overrides); }

/** The two redirect addresses an app registration must list (Web platform). */
export function redirectUrisFor<R extends ProviderTestRequest>(
    req: R,
    buildConnect: (r: R) => string = lazy.deps.buildRedirectUri as (r: R) => string,
): { signIn: string; connect: string } {
    const host = process.env.SERVER_PUBLIC_HOST;
    const base = host ? `${process.env.SERVER_PROTOCOL || 'https'}://${host}` : `${req.protocol}://${req.get('host')}`;
    return { signIn: `${base}/auth/callback/microsoft`, connect: buildConnect(req) };
}

/** The caller's verified Microsoft tenant (users.azureTenantId), or null. */
export async function callerVerifiedTenant(userId: string, binding: ProviderTestDeps['identityBinding'] = lazy.deps.identityBinding): Promise<string | null> {
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
export async function answerMicrosoftProviderTest(req: ProviderTestRequest, config: AuthConfigLike): Promise<{ status: number; body: Record<string, unknown> }> {
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
