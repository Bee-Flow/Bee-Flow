/**
 * The platform test of the Microsoft app registration (catalogue 3.1), run by
 * POST /auth/providers/microsoft/test, and the token check the user report
 * shares with it.
 *
 *   app.config         the stored client id is a GUID, a secret is stored, the tenant is valid
 *   app.token          Microsoft issues a client-credentials token: secret, app and tenant work
 *   app.redirect_uris  cannot be read without Application.Read.All: shown for a manual check
 *
 * Only the primary registration is tested here. The secret is sent to
 * Microsoft's token endpoint and nowhere else; the report holds codes, the
 * tenant and the redirect addresses, never the secret or the token.
 */

import { GUID, microsoftCredentialsFor, microsoftCredentialsForTenant, normalizeTenantId } from '../../../auth/oauth/microsoftConnections.mts';
import type { MicrosoftProviderConfig } from '../../../auth/oauth/microsoftConnections.mts';
import { buildReport, PROBE_TIMEOUT, toCheck, skippedCheck, firstNonPass } from './checks.mts';
import type { Outcome, ReportLevel, TeamsCheck, TeamsDiagnosticsReport } from './checks.mts';
import { aadstsMeaning, aadstsParam } from './aadsts.mts';
import { requestClientCredentialsToken } from './entraToken.mts';
import type { TokenResult } from './entraToken.mts';
import { probeTimeoutMs } from './limits.mts';

export type AuthConfigLike = { providers?: { microsoft?: MicrosoftProviderConfig } } | null | undefined;
export type TenantMode = 'single' | 'common' | 'organizations' | 'consumers';
export interface RedirectUris { signIn: string; connect: string }

const primaryOf = (config: AuthConfigLike): MicrosoftProviderConfig => config?.providers?.microsoft || {};

/** The configured tenant as a mode; null when the stored value is not a valid tenant. */
export function tenantModeOf(config: AuthConfigLike): TenantMode | null {
    const tid = normalizeTenantId(primaryOf(config).tenantId);
    if (tid === null) return null;
    if (tid === 'common' || tid === 'organizations' || tid === 'consumers') return tid;
    return 'single';
}

/** The configured tenant when it is a directory GUID (lower case), else null. */
export function configuredTenantGuid(config: AuthConfigLike): string | null {
    const tid = normalizeTenantId(primaryOf(config).tenantId);
    return tid && GUID.test(tid) ? tid : null;
}

/** app.config: what is stored, without any request. */
export function appConfigOutcome(config: AuthConfigLike): Outcome {
    const primary = primaryOf(config);
    const clientId = String(primary.clientId || '').trim();
    if (!clientId) return { status: 'fail', code: 'client_id_missing', fix: 'enter_client_id', fixer: 'platform_admin' };
    if (!GUID.test(clientId)) return { status: 'fail', code: 'client_id_invalid', fix: 'enter_client_id', fixer: 'platform_admin' };
    if (!primary.clientSecret) return { status: 'fail', code: 'secret_missing', fix: 'enter_secret', fixer: 'platform_admin' };
    const tenantMode = tenantModeOf(config);
    if (tenantMode === null) return { status: 'fail', code: 'tenant_invalid', fix: 'enter_tenant', fixer: 'platform_admin' };
    if (tenantMode === 'consumers') return { status: 'warn', code: 'tenant_consumers', params: { tenantMode }, fix: 'tenant_not_consumers', fixer: 'platform_admin' };
    return { status: 'pass', code: 'ok', params: { tenantMode } };
}

/** The outcome of a token request result. */
export function tokenResultOutcome(result: TokenResult, params: Record<string, unknown>): Outcome {
    if (result.ok) return { status: 'pass', code: 'ok', params };
    if (result.kind === 'network') {
        return result.timedOut ? { ...PROBE_TIMEOUT } : { status: 'fail', code: 'entra_unreachable', fix: 'check_network', fixer: 'platform_admin' };
    }
    const meaning = aadstsMeaning(result.aadsts);
    const aadsts = aadstsParam(result.aadsts);
    return { status: 'fail', code: meaning.code, params: aadsts ? { aadsts } : {}, fix: meaning.remediation, fixer: meaning.fixer };
}

/**
 * app.token: a client-credentials token from the configured GUID tenant, else
 * from the caller's verified tenant. `primaryOnly` tests the primary
 * registration (platform level); otherwise the registration that serves that
 * tenant (what the caller's imports use).
 */
export async function tokenOutcome(a: { config: AuthConfigLike; callerTenantId: string | null; primaryOnly: boolean; timeoutMs?: number }): Promise<Outcome> {
    const configured = configuredTenantGuid(a.config);
    const caller = a.callerTenantId && GUID.test(a.callerTenantId) ? a.callerTenantId.toLowerCase() : null;
    const tenantId = configured || caller;
    if (!tenantId) {
        return { status: 'unknown', code: 'tenant_needed', params: { tenantMode: tenantModeOf(a.config) || 'common' }, fix: 'sign_in_with_microsoft_or_set_tenant', fixer: 'platform_admin' };
    }
    const creds = a.primaryOnly ? microsoftCredentialsFor(a.config) : microsoftCredentialsForTenant(a.config, tenantId);
    if (!creds) return { status: 'fail', code: 'app_not_configured', fix: 'configure_app_registration', fixer: 'platform_admin' };
    const result = await requestClientCredentialsToken({
        clientId: creds.clientId, clientSecret: creds.clientSecret, tenantId, timeoutMs: a.timeoutMs ?? probeTimeoutMs(),
    });
    return tokenResultOutcome(result, { tenantSource: configured ? 'configured' : 'your_account', tenantId });
}

export function redirectUrisOutcome(uris: RedirectUris | null | undefined): Outcome {
    const list = uris ? [uris.signIn, uris.connect].filter((u) => typeof u === 'string' && u) : [];
    return { status: 'unknown', code: 'manual_check', params: { uris: list }, fix: 'register_redirect_uris', fixer: 'platform_admin' };
}

/** The platform report. `callerTenantId` is the caller's verified Microsoft tenant, or null. */
export async function testAppRegistration(input: {
    config: AuthConfigLike; callerTenantId: string | null; redirectUris?: RedirectUris | null; timeoutMs?: number; now?: Date;
}): Promise<TeamsDiagnosticsReport> {
    const level: ReportLevel = 'platform';
    const done = new Map<string, TeamsCheck>();
    const configSpec = { id: 'app.config', option: 'app' as const, dependsOn: [] };
    done.set(configSpec.id, toCheck(configSpec, appConfigOutcome(input.config), level));

    const tokenSpec = { id: 'app.token', option: 'app' as const, dependsOn: ['app.config'] };
    const blocked = firstNonPass(done, tokenSpec.dependsOn);
    done.set(tokenSpec.id, blocked
        ? skippedCheck(tokenSpec, blocked)
        : toCheck(tokenSpec, await tokenOutcome({ config: input.config, callerTenantId: input.callerTenantId, primaryOnly: true, timeoutMs: input.timeoutMs }), level));

    const urisSpec = { id: 'app.redirect_uris', option: 'app' as const, dependsOn: [] };
    done.set(urisSpec.id, toCheck(urisSpec, redirectUrisOutcome(input.redirectUris), level));
    return buildReport(level, [...done.values()], input.now);
}
