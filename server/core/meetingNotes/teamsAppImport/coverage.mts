/**
 * Who organisation-wide Teams import (option B) covers: the cross-tenant
 * guard. An application token for tenant T reads the calendars and meetings
 * of everyone in T that an access policy allows, so it may only ever be used
 * for a user who passes ALL of these, re-checked at every use (discovery,
 * the claim of each import job, the member's own settings flag):
 *
 *   1. the instance allows it (TEAMS_APP_IMPORT is not '0')     instance_disabled
 *   2. the organisation switched it on                          not_enabled
 *   3. the organisation has a verified tenant (orgTenant.mts),
 *      and it is the one it was switched on for               tenant_not_bound / tenant_changed
 *   4. the account exists, is active, and its home
 *      organisation is this one                                inactive / other_organisation
 *   5. its verified Microsoft identity (users.azureTenantId,
 *      azureUserId) is from that tenant                        no_identity / other_tenant
 *   6. coverage is 'all', or the member is selected             not_selected
 *   7. the member has Meeting Notes                             no_access
 *   8. an app registration serves that tenant                   app_not_configured
 *
 * Because the tenant comes only from orgTenant.mts, a tenant maps to at most
 * one organisation, and rule 4 keeps a member of another organisation that
 * shares the tenant out. Group-only membership does not count: only the
 * account's own organisation.
 *
 * Also here: the availability and member counts the admin screen shows, and
 * `updateAppImport`, the rules a change of the setting must pass before
 * settings.mts stores it. Nothing in this module calls Microsoft.
 */

import { createRequire } from 'node:module';
import { GUID, microsoftCredentialsForTenant } from '../../../auth/oauth/microsoftConnections.mts';
import type { MicrosoftProviderConfig } from '../../../auth/oauth/microsoftConnections.mts';
import { appImportAllowed, maxSelectedUsers } from '../teamsSetup/limits.mts';
import type { OrgMemberRow } from '../../../stores/teamsSetupStore.mts';
import { readAppImportSettings, uniqueIds, writeAppImportSettings } from './settings.mts';
import type { AppImportCoverage, AppImportSettings } from './settings.mts';
import { orgVerifiedTenant } from './orgTenant.mts';
import type { OrgTenant } from './orgTenant.mts';

const nodeRequire = createRequire(import.meta.url);

export type AuthConfigLike = { providers?: { microsoft?: MicrosoftProviderConfig } } | null | undefined;

export type CoverageReason = 'instance_disabled' | 'not_enabled' | 'tenant_not_bound' | 'tenant_changed' | 'inactive'
    | 'other_organisation' | 'no_identity' | 'other_tenant' | 'not_selected' | 'no_access' | 'app_not_configured';

export type CoverageResult = { covered: true; tenantId: string; objectId: string } | { covered: false; reason: CoverageReason };

/** The user fields coverage reads (a users row, or an overview row). */
export interface CoverageUser {
    id: string;
    status?: string | null;
    organizationId?: string | null;
    azureTenantId?: string | null;
    azureUserId?: string | null;
}

type HasCapability = (capId: string, ctx: { userId: string; orgId: string }) => Promise<boolean>;

interface CoverageDeps {
    getUser: (userId: string) => Promise<CoverageUser | null>;
    hasCapability: HasCapability;
    loadConfig: () => Promise<AuthConfigLike>;
    readSettings: typeof readAppImportSettings;
    writeSettings: typeof writeAppImportSettings;
    orgTenant: typeof orgVerifiedTenant;
    listOrgMemberRows: (orgId: string, limit: number) => Promise<{ rows: OrgMemberRow[]; truncated: boolean }>;
    log: { warn: (...args: unknown[]) => void };
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<CoverageDeps>({
    getUser: () => {
        const userStore = nodeRequire('../../../stores/userStore.js') as Pick<CoverageDeps, 'getUser'>;
        return (userId: string) => userStore.getUser(userId);
    },
    hasCapability: () => (nodeRequire('../../entitlements/entitlements.js') as { hasCapability: HasCapability }).hasCapability,
    loadConfig: () => (nodeRequire('../../../auth/permissions.js') as Pick<CoverageDeps, 'loadConfig'>).loadConfig,
    readSettings: () => readAppImportSettings,
    writeSettings: () => writeAppImportSettings,
    orgTenant: () => orgVerifiedTenant,
    listOrgMemberRows: () => (nodeRequire('../../../stores/teamsSetupStore.mts') as Pick<CoverageDeps, 'listOrgMemberRows'>).listOrgMemberRows,
    log: () => nodeRequire('../../../telemetry/log.js'),
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<CoverageDeps> = {}): void { lazy.init(overrides); }

const lower = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const no = (reason: CoverageReason): CoverageResult => ({ covered: false, reason });

/** Rules 1-3: the organisation-level part. Null when it holds. */
export function orgLevelReason(settings: AppImportSettings, orgTenant: OrgTenant): CoverageReason | null {
    if (!appImportAllowed()) return 'instance_disabled';
    if (!settings.enabled) return 'not_enabled';
    if (!orgTenant.ok) return 'tenant_not_bound';
    if (settings.tenantId !== orgTenant.tenantId) return 'tenant_changed';
    return null;
}

/**
 * Rules 4-6 for one user against `tenantId`. With `tenantId` null (no
 * verified tenant), only a missing identity is told apart.
 */
export function memberReason(user: CoverageUser | null, orgId: string, tenantId: string | null, settings: Pick<AppImportSettings, 'coverage' | 'selectedUserIds'>): CoverageReason | null {
    if (!user || (user.status ?? 'active') !== 'active') return 'inactive';
    if (!orgId || user.organizationId !== orgId) return 'other_organisation';
    const tid = lower(user.azureTenantId);
    if (!GUID.test(tid) || !GUID.test(lower(user.azureUserId))) return 'no_identity';
    if (tenantId !== null && tid !== tenantId) return 'other_tenant';
    if (settings.coverage !== 'all' && !settings.selectedUserIds.includes(user.id)) return 'not_selected';
    return null;
}

async function capabilityOf(hasCapability: HasCapability, userId: string, orgId: string): Promise<boolean> {
    try { return (await hasCapability('meeting_notes', { userId, orgId })) === true; } catch (err) {
        lazy.deps.log.warn('[TeamsAppImport] capability check failed:', (err as Error).message);
        return false;
    }
}

/**
 * The coverage decision for one user (rules 1-8). `access`, when given, is the
 * already known answer of rule 7 (the overview computed it); otherwise
 * `hasCapability` is asked. A failure to ask is "no access".
 */
export async function coverageFor(a: {
    user: CoverageUser | null; orgId: string | null; settings: AppImportSettings; orgTenant: OrgTenant; config: AuthConfigLike;
    hasCapability: HasCapability; access?: boolean;
}): Promise<CoverageResult> {
    const orgReason = orgLevelReason(a.settings, a.orgTenant);
    if (orgReason) return no(orgReason);
    if (!a.orgTenant.ok || !a.orgId) return no('tenant_not_bound');
    const tenantId = a.orgTenant.tenantId;
    const userReason = memberReason(a.user, a.orgId, tenantId, a.settings);
    if (userReason || !a.user) return no(userReason || 'inactive');
    const access = a.access ?? await capabilityOf(a.hasCapability, a.user.id, a.orgId);
    if (!access) return no('no_access');
    if (!microsoftCredentialsForTenant(a.config, tenantId)) return no('app_not_configured');
    return { covered: true, tenantId, objectId: lower(a.user.azureUserId) };
}

/**
 * Coverage of `userId` for `orgId`, everything read now. `fresh` reads the
 * setting and the tenant link past every cache (the claim of an import job).
 */
export async function coverageForUser(userId: string, orgId: string | null, { fresh = false }: { fresh?: boolean } = {}): Promise<CoverageResult> {
    if (!appImportAllowed()) return no('instance_disabled');
    if (!orgId) return no('other_organisation');
    const settings = await lazy.deps.readSettings(orgId, { fresh });
    // Off is the common case: answer it without reading anything else.
    if (!settings.enabled) return no('not_enabled');
    const [orgTenant, user, config] = await Promise.all([
        lazy.deps.orgTenant(orgId, { fresh }),
        lazy.deps.getUser(userId),
        lazy.deps.loadConfig(),
    ]);
    return coverageFor({ user, orgId, settings, orgTenant, config, hasCapability: lazy.deps.hasCapability });
}

/** For GET /api/teams-notes-settings/user/me: whether the caller's own organisation imports their meetings. */
export async function orgImportActive(userId: string): Promise<boolean> {
    if (!appImportAllowed()) return false;
    const user = await lazy.deps.getUser(userId);
    const orgId = user?.organizationId || null;
    if (!user || !orgId) return false;
    return (await coverageForUser(userId, orgId)).covered;
}

export type AvailabilityReason = 'ok' | 'instance_disabled' | 'tenant_not_bound' | 'tenant_mismatch_sso' | 'app_not_configured';
export interface AppImportAvailability {
    reason: AvailabilityReason;
    tenantId: string | null;
    source: 'directory_binding' | 'single_org' | null;
}

/** Whether the organisation could switch it on now. */
export function availabilityOf(orgTenant: OrgTenant, config: AuthConfigLike): AppImportAvailability {
    if (!appImportAllowed()) return { reason: 'instance_disabled', tenantId: null, source: null };
    if (!orgTenant.ok) return { reason: orgTenant.reason, tenantId: null, source: null };
    const { tenantId, source } = orgTenant;
    if (!microsoftCredentialsForTenant(config, tenantId)) return { reason: 'app_not_configured', tenantId, source };
    return { reason: 'ok', tenantId, source };
}

export interface AppImportCounts {
    eligible: number;
    covered: number;
    withoutIdentity: number;
    otherTenant: number;
    withoutAccess: number;
    notSelected: number;
}

const CAPABILITY_CONCURRENCY = 8;

/**
 * Coverage over the organisation's active members (overview rows). The
 * member counts are what the setting WOULD cover against the verified tenant
 * (so an admin sees them before switching on); `covered` is who IS covered
 * now. Meeting Notes access is asked only for members who pass every other
 * per-member rule, at most 8 at a time, unless `access` already says it.
 */
export async function evaluateMembers(a: {
    orgId: string; rows: OrgMemberRow[]; settings: AppImportSettings; orgTenant: OrgTenant; config: AuthConfigLike; access?: Map<string, boolean>;
}): Promise<{ covered: Set<string>; counts: AppImportCounts }> {
    const counts: AppImportCounts = { eligible: a.rows.length, covered: 0, withoutIdentity: 0, otherTenant: 0, withoutAccess: 0, notSelected: 0 };
    const covered = new Set<string>();
    const tenantId = a.orgTenant.ok ? a.orgTenant.tenantId : null;
    const orgOk = orgLevelReason(a.settings, a.orgTenant) === null && !!tenantId && !!microsoftCredentialsForTenant(a.config, tenantId);
    const candidates: OrgMemberRow[] = [];
    for (const r of a.rows) {
        const reason = memberReason({ id: r.userId, status: 'active', organizationId: a.orgId, azureTenantId: r.azureTenantId, azureUserId: r.azureUserId }, a.orgId, tenantId, a.settings);
        if (reason === 'no_identity') counts.withoutIdentity++;
        else if (reason === 'other_tenant') counts.otherTenant++;
        else if (reason === 'not_selected') counts.notSelected++;
        else if (reason === null) candidates.push(r);
    }
    let next = 0;
    const worker = async () => {
        while (next < candidates.length) {
            const r = candidates[next++];
            const known = a.access?.get(r.userId);
            const access = known ?? await capabilityOf(lazy.deps.hasCapability, r.userId, a.orgId);
            if (!access) { counts.withoutAccess++; continue; }
            if (orgOk) { covered.add(r.userId); counts.covered++; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(CAPABILITY_CONCURRENCY, candidates.length) }, worker));
    return { covered, counts };
}

/** The overview's `appImportCovered` per row: who is covered now. Empty when the organisation has it off. */
export async function coveredUserIds(a: { orgId: string; rows: OrgMemberRow[]; config: AuthConfigLike; access?: Map<string, boolean> }): Promise<Set<string>> {
    if (!appImportAllowed()) return new Set();
    const settings = await lazy.deps.readSettings(a.orgId);
    if (!settings.enabled) return new Set();
    const orgTenant = await lazy.deps.orgTenant(a.orgId);
    return (await evaluateMembers({ ...a, settings, orgTenant })).covered;
}

export interface TeamsAppImportState {
    settings: { enabled: boolean; coverage: AppImportCoverage; selectedUserIds: string[]; tenantId: string | null; enabledAt: string | null; enabledBy: string | null; updatedAt: string | null };
    availability: AppImportAvailability;
    counts: AppImportCounts;
}

/**
 * GET /api/teams-setup/org/app-import. Selected ids that are no longer active
 * members are left out of the answer (and so of the next save).
 */
export async function appImportState(orgId: string, { fresh = true }: { fresh?: boolean } = {}): Promise<TeamsAppImportState> {
    const [settings, orgTenant, config, members] = await Promise.all([
        lazy.deps.readSettings(orgId, { fresh }),
        lazy.deps.orgTenant(orgId, { fresh }),
        lazy.deps.loadConfig(),
        lazy.deps.listOrgMemberRows(orgId, 0),
    ]);
    const memberIds = new Set(members.rows.map((r) => r.userId));
    const { counts } = await evaluateMembers({ orgId, rows: members.rows, settings, orgTenant, config });
    return {
        settings: {
            enabled: settings.enabled,
            coverage: settings.coverage,
            selectedUserIds: settings.selectedUserIds.filter((id) => memberIds.has(id)),
            tenantId: settings.tenantId,
            enabledAt: settings.enabledAt,
            enabledBy: settings.enabledBy,
            updatedAt: settings.updatedAt,
        },
        availability: availabilityOf(orgTenant, config),
        counts,
    };
}

export type UpdateRefusal = { ok: false; status: 400 | 409; code: 'too_many_selected' | 'not_a_member' | 'app_import_unavailable'; message: string };

/**
 * PUT /api/teams-setup/org/app-import: check a change and store it.
 *
 *   - ids are deduplicated; more than TEAMS_APP_IMPORT_MAX_SELECTED_USERS (0 = no cap): too_many_selected;
 *   - every id must be an active member of THIS organisation: not_a_member (the message counts, never names);
 *   - switching on needs availability 'ok' now: app_import_unavailable (the message names the reason code).
 *
 * The tenant is taken when it is switched on and kept while it stays on;
 * switching off clears it. Switching off is always allowed.
 */
export async function updateAppImport(a: {
    orgId: string; actorId: string; body: { enabled: boolean; coverage: AppImportCoverage; selectedUserIds: string[] }; now?: Date;
}): Promise<{ ok: true; state: TeamsAppImportState } | UpdateRefusal> {
    const ids = uniqueIds(a.body.selectedUserIds);
    const cap = maxSelectedUsers();
    if (cap > 0 && ids.length > cap) return { ok: false, status: 400, code: 'too_many_selected', message: `At most ${cap} members can be selected` };
    const members = await lazy.deps.listOrgMemberRows(a.orgId, 0);
    const memberIds = new Set(members.rows.map((r) => r.userId));
    const outside = ids.filter((id) => !memberIds.has(id)).length;
    if (outside > 0) return { ok: false, status: 400, code: 'not_a_member', message: `${outside} of the selected people are not active members of this organisation` };

    const previous = await lazy.deps.readSettings(a.orgId, { fresh: true });
    let tenantId: string | null = null;
    let enabledAt: string | null = null;
    let enabledBy: string | null = null;
    if (a.body.enabled) {
        const [orgTenant, config] = await Promise.all([lazy.deps.orgTenant(a.orgId, { fresh: true }), lazy.deps.loadConfig()]);
        const availability = availabilityOf(orgTenant, config);
        if (availability.reason !== 'ok') {
            return { ok: false, status: 409, code: 'app_import_unavailable', message: `Organisation-wide import cannot be switched on: ${availability.reason}` };
        }
        const keep = previous.enabled && previous.tenantId;
        tenantId = keep ? previous.tenantId : availability.tenantId;
        enabledAt = keep ? previous.enabledAt : (a.now || new Date()).toISOString();
        enabledBy = keep ? previous.enabledBy : a.actorId;
    }
    await lazy.deps.writeSettings({
        orgId: a.orgId,
        actorId: a.actorId,
        previous,
        next: { enabled: a.body.enabled, coverage: a.body.coverage === 'all' ? 'all' : 'selected', selectedUserIds: ids, tenantId, enabledAt, enabledBy },
        now: a.now,
    });
    return { ok: true, state: await appImportState(a.orgId) };
}
