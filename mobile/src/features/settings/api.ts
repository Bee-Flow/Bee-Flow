/**
 * Every endpoint the settings, organisation, admin, usage and support screens
 * touch.
 *
 * Paths are the FULL client-visible ones. That matters more here than anywhere
 * else in the app, because these routers are mounted under four different
 * prefixes in server/index.js and the router files all read as if they sat at
 * the root:
 *
 *   /auth/…                 auth/loginRoutes + auth/admin/*  (profile, users, orgs)
 *   /auth/mfa/…             auth/mfaRoutes
 *   /ai/user-settings       routes/ai/config/userSettings.js  — NOT /api/…
 *   /api/…                  everything else
 *
 * Several of these answer 403 by design rather than by accident — licence
 * tier, org-admin gates, super-admin gates. Callers must treat a 403 as a real
 * answer ("not yours to see") and render it, not retry it; ApiError.isForbidden
 * exists for exactly that.
 */

import type {
    AppPasswordStatus,
    AuthUrlResponse,
    ConsumerUsage,
    CostPoint,
    DsrRequest,
    DsrSubmitResponse,
    EffectiveBranding,
    PublicBranding,
    GuardStatus,
    IntegrationStatus,
    LicenseHealth,
    LicenseStatus,
    Locale,
    MaintenanceState,
    MfaSetup,
    MfaStatus,
    ModelUsage,
    ModuleHealth,
    Organization,
    OrgMember,
    OrgShield,
    PlatformModule,
    RecoveryCodesResponse,
    ReleaseNote,
    SupportThread,
    SupportThreadDetail,
    UsageSummary,
    UserBrandingPatch,
    UserBrandingResponse,
    UserGroup,
    UserSettings,
    UserShield,
} from './types';
import { api, ApiError } from '../../api/client';


/**
 * Query keys. Grouped by screen rather than by endpoint so an invalidation
 * after a mutation can name exactly what changed — `settingsKeys.mfa` after
 * enabling 2FA, not a blanket `['settings']` sweep that refetches the licence,
 * the org roster and a month of usage as well.
 */
export const settingsKeys = {
    branding: ['settings', 'branding'] as const,
    brandingPublic: ['settings', 'branding', 'public'] as const,
    mfa: ['settings', 'mfa'] as const,
    appPassword: ['settings', 'app-password'] as const,
    license: ['settings', 'license'] as const,
    licenseHealth: ['settings', 'license', 'health'] as const,
    consumerUsage: ['settings', 'consumer-usage'] as const,
    userSettings: ['settings', 'user-settings'] as const,
    userShield: ['settings', 'user-shield'] as const,
    guardStatus: ['settings', 'guard-status'] as const,
    locales: ['settings', 'locales'] as const,
    maintenance: ['settings', 'maintenance'] as const,
    releaseNotes: ['settings', 'release-notes'] as const,
    health: ['settings', 'health'] as const,
    /** The MIN_SERVER_BUILD capability probe — see src/api/server.ts. */
    serverSupport: ['settings', 'server-support'] as const,

    orgs: ['org', 'list'] as const,
    org: (id: string) => ['org', 'detail', id] as const,
    orgMembers: ['org', 'members'] as const,
    orgGroups: ['org', 'groups'] as const,
    orgShield: (id: string) => ['org', 'shield', id] as const,
    dsr: ['org', 'dsr'] as const,

    integrationStatus: (provider: string) => ['integrations', 'status', provider] as const,

    modules: ['admin', 'modules'] as const,
    moduleHealth: ['admin', 'modules', 'health'] as const,

    usageSummary: (days: number, userId: string | null) =>
        ['usage', 'summary', days, userId] as const,
    usageCostTimeline: (days: number, userId: string | null) =>
        ['usage', 'cost-timeline', days, userId] as const,
    usageByModel: (days: number, userId: string | null) =>
        ['usage', 'by-model', days, userId] as const,

    supportThreads: ['support', 'mine'] as const,
    supportThread: (id: string) => ['support', 'thread', id] as const,
};

/**
 * Run a request that is allowed to be refused, and turn the refusal into
 * `null` instead of an error.
 *
 * Half the surfaces here are gated — the licence health probe is org-admin
 * only, the module list is super-admin only, DSR needs `admin_compliance`, and
 * usage monitoring can 402 on a community licence. A member opening the admin
 * screen should see "not available to you", rendered by the screen, rather
 * than a red error state; and a partially-visible screen should not fail
 * whole because one of its five cards was refused.
 */
async function optional<T>(run: () => Promise<T | null>): Promise<T | null> {
    try {
        return await run();
    } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 402 || err.status === 404)) {
            return null;
        }
        throw err;
    }
}

// ── Appearance / branding ───────────────────────────────────────────────

export async function getBranding(signal?: AbortSignal): Promise<EffectiveBranding | null> {
    return api.get<EffectiveBranding>('/api/branding/effective', { signal });
}

/**
 * The signed-out theme, for the login and onboarding screens.
 *
 * Without this the phone paints those screens from the DEVICE colour scheme
 * while the web paints them from the org's branding — so a customer whose
 * organisation is themed light met a black login screen on Android and a white
 * one in the browser. Unauthenticated by design (see server/routes/branding.js),
 * so it is the one branding call that works before there is a session.
 */
export async function getPublicBranding(signal?: AbortSignal): Promise<PublicBranding | null> {
    return api.get<PublicBranding>('/api/branding/public', { signal, retry: false });
}

/** Persist the theme choice to the account, so the web app agrees with the
 *  phone. 403 means the admin turned user overrides off — a real answer. */
export async function saveUserBranding(patch: UserBrandingPatch): Promise<UserBrandingResponse | null> {
    return api.put<UserBrandingResponse>('/api/branding/user', patch);
}

/** Drop the per-user override and fall back to the org default. A DELETE,
 *  like the web app: a PUT body of `null` never reaches the route, because the
 *  server's JSON parser only accepts objects and arrays. */
export async function clearUserBranding(): Promise<UserBrandingResponse | null> {
    return api.delete<UserBrandingResponse>('/api/branding/user');
}

// ── Account ─────────────────────────────────────────────────────────────

export async function updateProfile(patch: {
    displayName?: string;
    avatar?: string | null;
    avatarType?: string | null;
}): Promise<void> {
    await api.post('/auth/update-profile', patch);
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await api.post('/auth/change-password', { oldPassword, newPassword });
}

export async function listLocales(signal?: AbortSignal): Promise<Locale[]> {
    return (await api.get<Locale[]>('/api/languages/user/locales', { signal })) ?? [];
}

/**
 * `GET /ai/user-settings` — mounted at `/ai`, not `/api`.
 *
 * Carries the app allow-list, the EU-mode preference, Simple Mode and a
 * per-provider "is a credential stored" map. The POST is a partial update:
 * only the keys present in the body are written, so sending `{ simpleMode }`
 * cannot clobber the user's integration keys.
 */
export async function getUserSettings(signal?: AbortSignal): Promise<UserSettings | null> {
    return api.get<UserSettings>('/ai/user-settings', { signal });
}

export async function saveUserSettings(patch: Partial<{
    enabledApps: string[];
    simpleMode: boolean;
}>): Promise<void> {
    await api.post('/ai/user-settings', patch);
}

// ── Security ────────────────────────────────────────────────────────────

export async function getMfaStatus(signal?: AbortSignal): Promise<MfaStatus | null> {
    return api.get<MfaStatus>('/auth/mfa/status', { signal });
}

/** Mint (or re-read) the pending enrolment secret. Idempotent for ten minutes,
 *  so re-opening the screen shows the SAME QR the authenticator already has. */
export async function startMfaSetup(force = false): Promise<MfaSetup | null> {
    return api.post<MfaSetup>('/auth/mfa/setup', { force });
}

export async function enableMfa(code: string): Promise<RecoveryCodesResponse | null> {
    return api.post<RecoveryCodesResponse>('/auth/mfa/enable', { code });
}

export async function disableMfa(code: string): Promise<void> {
    await api.post('/auth/mfa/disable', { code });
}

/** Returns a fresh set of one-time codes. The old set stops working the moment
 *  this resolves, so the caller MUST show them before navigating away. */
export async function regenerateRecoveryCodes(code: string): Promise<RecoveryCodesResponse | null> {
    return api.post<RecoveryCodesResponse>('/auth/mfa/recovery-codes/regenerate', { code });
}

export async function getAppPasswordStatus(signal?: AbortSignal): Promise<AppPasswordStatus | null> {
    return optional(() => api.get<AppPasswordStatus>('/auth/app-password-status', { signal }));
}

// ── Licence, plan and usage ─────────────────────────────────────────────

export async function getLicenseStatus(signal?: AbortSignal): Promise<LicenseStatus | null> {
    return api.get<LicenseStatus>('/api/license/status', { signal });
}

export async function getLicenseHealth(signal?: AbortSignal): Promise<LicenseHealth | null> {
    return optional(() => api.get<LicenseHealth>('/api/license/health', { signal }));
}

export async function getConsumerUsage(signal?: AbortSignal): Promise<ConsumerUsage | null> {
    return optional(() => api.get<ConsumerUsage>('/api/subscriptions/consumer/usage', { signal }));
}

/**
 * Usage endpoints all take the same window and the same optional narrowing.
 *
 * SCOPE IS NOT WHAT YOU MIGHT ASSUME. `/api/usage/*` scopes to the caller's
 * ORGANISATION when they belong to one (routes/usage.js `attachOrgFilter`), so
 * an ordinary member's default view is the whole company's spend, not their
 * own. Only an account with no organisation is force-scoped to itself. Passing
 * `?user=<id>` narrows to one person, which is how "just me" is built — and it
 * is why the usage screen shows which scope it is displaying rather than
 * leaving someone to think the company's bill is theirs.
 */
export type UsageScope = { days: number; userId?: string | null };

function usageQuery({ days, userId }: UsageScope): Record<string, string | number> {
    return userId ? { days, user: userId } : { days };
}

export async function getUsageSummary(
    scope: UsageScope,
    signal?: AbortSignal,
): Promise<UsageSummary | null> {
    return api.get<UsageSummary>('/api/usage/summary', { signal, query: usageQuery(scope) });
}

export async function getCostTimeline(
    scope: UsageScope,
    signal?: AbortSignal,
): Promise<CostPoint[]> {
    return (
        (await api.get<CostPoint[]>('/api/usage/cost-timeline', {
            signal,
            query: { ...usageQuery(scope), interval: 'day' },
        })) ?? []
    );
}

export async function getUsageByModel(
    scope: UsageScope,
    signal?: AbortSignal,
): Promise<ModelUsage[]> {
    return (
        (await api.get<ModelUsage[]>('/api/usage/by-model', { signal, query: usageQuery(scope) })) ??
        []
    );
}

// ── Privacy ─────────────────────────────────────────────────────────────

export async function getUserShield(signal?: AbortSignal): Promise<UserShield | null> {
    return api.get<UserShield>('/api/org-privacy-shield/user/me', { signal });
}

export async function saveUserShield(next: UserShield): Promise<void> {
    await api.put('/api/org-privacy-shield/user/me', next);
}

export async function getGuardStatus(signal?: AbortSignal): Promise<GuardStatus | null> {
    return api.get<GuardStatus>('/api/org-privacy-shield/user/guard-status', { signal });
}

export async function getOrgShield(orgId: string, signal?: AbortSignal): Promise<OrgShield | null> {
    return optional(() =>
        api.get<OrgShield>(`/api/org-privacy-shield/${encodeURIComponent(orgId)}`, { signal }),
    );
}

export async function saveOrgShield(orgId: string, next: Partial<OrgShield>): Promise<void> {
    await api.put(`/api/org-privacy-shield/${encodeURIComponent(orgId)}`, next);
}

// ── Organisation ────────────────────────────────────────────────────────

export async function listOrganizations(signal?: AbortSignal): Promise<Organization[]> {
    return (await api.get<Organization[]>('/auth/organizations', { signal })) ?? [];
}

export async function getOrganization(id: string, signal?: AbortSignal): Promise<Organization | null> {
    return optional(() => api.get<Organization>(`/auth/organizations/${encodeURIComponent(id)}`, { signal }));
}

export async function listOrgMembers(signal?: AbortSignal): Promise<OrgMember[]> {
    return (await api.get<OrgMember[]>('/auth/users', { signal })) ?? [];
}

export async function listGroups(signal?: AbortSignal): Promise<UserGroup[]> {
    return (await api.get<UserGroup[]>('/auth/groups', { signal })) ?? [];
}

// ── Compliance / DSR ────────────────────────────────────────────────────

/** Admin view. Needs `admin_compliance`; `optional` turns a refusal into null
 *  so a member's Organisation screen simply omits the card. */
export async function listDsrRequests(signal?: AbortSignal): Promise<DsrRequest[] | null> {
    return optional(async () => (await api.get<DsrRequest[]>('/api/dsr/requests', { signal })) ?? []);
}

/**
 * File a data-subject request against your own account.
 *
 * Deliberately the PUBLIC endpoint: GDPR Art. 12 requires the channel to stay
 * reachable, so it is mounted without the enterprise gate and never 403s on a
 * community install. It is rate-limited to five per hour per IP, and the org
 * is derived from the email server-side — a client-supplied organization_id is
 * ignored.
 */
export async function submitDsrRequest(body: {
    subject_email: string;
    request_type: string;
    notes?: string;
}): Promise<DsrSubmitResponse | null> {
    return api.post<DsrSubmitResponse>('/api/dsr/requests', body);
}

// ── Integrations ────────────────────────────────────────────────────────

/**
 * Each provider owns its own `/status` shape (see IntegrationStatus). The
 * paths differ too: Google is `/api/integrations/google`, Microsoft is
 * `/api/integrations/microsoft`, and neither matches the catalogue id.
 */
export async function getIntegrationStatus(
    provider: string,
    signal?: AbortSignal,
): Promise<IntegrationStatus | null> {
    return optional(() =>
        api.get<IntegrationStatus>(`/api/integrations/${provider}/status`, { signal, retry: false }),
    );
}

/** The provider's OAuth authorisation URL, with the CSRF state and PKCE
 *  verifier already stashed in this session server-side. */
export async function getIntegrationAuthUrl(provider: string): Promise<string | null> {
    const res = await api.get<AuthUrlResponse>(`/api/integrations/${provider}/auth-url`, {
        retry: false,
    });
    return res?.url ?? null;
}

export async function disconnectIntegration(provider: string): Promise<void> {
    await api.post(`/api/integrations/${provider}/disconnect`);
}

/**
 * GitHub is the one connector with no OAuth dance: it takes a personal access
 * token, validates it against api.github.com before storing it, and answers
 * 400 with a readable message when the token is rejected. That makes it the
 * only one that can be completed entirely inside the app.
 */
export async function connectGithub(token: string): Promise<{ username?: string } | null> {
    return api.post<{ username?: string }>('/api/integrations/github/connect', { token });
}

// ── Admin ───────────────────────────────────────────────────────────────

export async function listModules(signal?: AbortSignal): Promise<PlatformModule[] | null> {
    return optional(async () => {
        const res = await api.get<{ modules: PlatformModule[] }>('/api/admin/modules', { signal });
        return res?.modules ?? [];
    });
}

export async function getModuleHealth(signal?: AbortSignal): Promise<ModuleHealth | null> {
    return optional(() => api.get<ModuleHealth>('/api/admin/modules/health', { signal }));
}

export async function getMaintenance(signal?: AbortSignal): Promise<MaintenanceState | null> {
    return optional(() => api.get<MaintenanceState>('/api/maintenance', { signal }));
}

/** `/api/guard/health` is a top-level route in server/index.js, not part of
 *  the `/api/admin/guard` router. `not-configured` is a normal answer on a
 *  self-host that never enabled the guard profile. */
export async function getGuardHealth(signal?: AbortSignal): Promise<{ status: string } | null> {
    return optional(() => api.get<{ status: string }>('/api/guard/health', { signal }));
}

// ── About / support ─────────────────────────────────────────────────────

/** Public, cached 5 minutes server-side, and 503s rather than erroring when
 *  the changelog store is unavailable — which `optional` folds into null. */
export async function listReleaseNotes(signal?: AbortSignal): Promise<ReleaseNote[] | null> {
    return optional(async () => {
        const res = await api.get<{ entries: ReleaseNote[] }>('/api/release-notes/public', {
            signal,
            retry: false,
        });
        return res?.entries ?? [];
    });
}

export async function listMySupportThreads(signal?: AbortSignal): Promise<SupportThread[] | null> {
    return optional(async () => {
        const res = await api.get<{ threads: SupportThread[] }>('/api/support/threads/mine', { signal });
        return res?.threads ?? [];
    });
}

export async function getSupportThread(
    id: string,
    signal?: AbortSignal,
): Promise<SupportThreadDetail | null> {
    return optional(() =>
        api.get<SupportThreadDetail>(`/api/support/threads/${encodeURIComponent(id)}`, { signal }),
    );
}

/**
 * Open a support request.
 *
 * `source: 'in_app'` is load-bearing: the marketing form carries a honeypot
 * field and a minimum render age, and a submission that trips either is
 * answered 200 with `spam: true` and silently dropped. An in-app submission
 * skips that heuristic entirely (routes/support/threads.js `_isLikelySpam`).
 */
export async function createSupportThread(body: {
    subject: string;
    message: string;
}): Promise<{ ok?: boolean; threadId?: string | null } | null> {
    return api.post<{ ok?: boolean; threadId?: string | null }>('/api/support/threads', {
        ...body,
        source: 'in_app',
    });
}

export async function replyToSupportThread(id: string, message: string): Promise<void> {
    await api.post(`/api/support/threads/${encodeURIComponent(id)}/messages`, { body: message });
}
