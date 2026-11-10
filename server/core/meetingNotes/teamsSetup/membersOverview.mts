/**
 * The organisation admin's Teams overview (GET /api/teams-setup/org/overview):
 * per active member whether Microsoft 365 is connected, which Teams
 * permissions the stored grant lacks, the last auto-import skip and the failed
 * imports of the window, whether organisation-wide import (option B) covers
 * them now, plus the two organisation checks (consent link, recorded admin
 * consent).
 *
 * Built from stored state only: the users and automation_credentials rows,
 * teams_import_jobs error codes and the stored skip state. No Graph call, no
 * token, no meeting title, no attendee, no e-mail address, no scope string and
 * no Microsoft identity leaves this module; `verifiedMicrosoftIdentity` is a
 * boolean.
 */

import { createRequire } from 'node:module';
import { GUID } from '../../../auth/oauth/microsoftConnections.mts';
import { toCheck } from './checks.mts';
import type { TeamsCheck } from './checks.mts';
import { adminConsentOutcome, consentLinkOutcome, readAdminConsentOutcome } from './consent.mts';
import type { AuthConfigLike } from './consent.mts';
import { maxMembers } from './limits.mts';
import type { OrgMemberRow } from '../../../stores/teamsSetupStore.mts';

const nodeRequire = createRequire(import.meta.url);

type SkipState = { reason: string; missingPermissions: string[]; at: string; orgId: string | null };

export interface MembersOverviewDeps {
    store: {
        listOrgMemberRows: (orgId: string, limit: number) => Promise<{ rows: OrgMemberRow[]; truncated: boolean }>;
        countRecentTeamsFailures: (orgId: string, days: number) => Promise<{ userId: string; code: string; count: number }[]>;
    };
    hasCapability: (capId: string, ctx: { userId: string; orgId: string }) => Promise<boolean>;
    settings: {
        getOrgSettings: (orgId: string) => Promise<Record<string, unknown>>;
        hasTeamsScopes: (scope: string | null | undefined) => boolean;
        missingTeamsPermissions: (scope: string | null | undefined, opts?: { includeOptional?: boolean }) => string[];
    };
    skipState: { readSkips: (userIds: string[]) => Promise<Map<string, SkipState>> };
    /** Who of `userIds` the poller still visits (autoImportCandidate.mts); a stored skip counts only for them. */
    autoImportCandidates: (a: { orgId: string; userIds: string[] }) => Promise<Set<string>>;
    readAdminConsentOutcome: typeof readAdminConsentOutcome;
    /** Option B: who the organisation's app import covers now (teamsAppImport/coverage.mts). */
    appImportCovered: (a: { orgId: string; rows: OrgMemberRow[]; config: AuthConfigLike; access?: Map<string, boolean> }) => Promise<Set<string>>;
    log: { warn: (...args: unknown[]) => void };
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<MembersOverviewDeps>({
    store: () => nodeRequire('../../../stores/teamsSetupStore.mts'),
    hasCapability: () => (nodeRequire('../../entitlements/entitlements.js') as Pick<MembersOverviewDeps, 'hasCapability'>).hasCapability,
    settings: () => nodeRequire('../teamsNotesSettings.js'),
    skipState: () => nodeRequire('../teamsImportSkipState.mts'),
    autoImportCandidates: () => (nodeRequire('./autoImportCandidate.mts') as { autoImportCandidates: MembersOverviewDeps['autoImportCandidates'] }).autoImportCandidates,
    readAdminConsentOutcome: () => readAdminConsentOutcome,
    appImportCovered: () => (nodeRequire('../teamsAppImport/coverage.mts') as { coveredUserIds: MembersOverviewDeps['appImportCovered'] }).coveredUserIds,
    log: () => nodeRequire('../../../telemetry/log.js'),
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<MembersOverviewDeps> = {}): void { lazy.init(overrides); }

export type MicrosoftState = 'none' | 'active' | 'needs_reauth' | 'revoked';

/** Why the last automatic import run did not use this member's account. */
type MemberSkip = { reason: string; missingPermissions: string[]; at: string };
/** One teams_import_jobs error code and how often it occurred in the window. */
type MemberFailure = { code: string; count: number };
/** The organisation document; null = members decide. */
type OrgTeamsChoices = { autoImport: boolean | null; autoRecordConfig: boolean | null };
type OverviewTotals = { members: number; connected: number; missingPermissions: number; needsReauth: number; skipped: number; failedImports: number };

export interface TeamsMemberRow {
    userId: string;
    displayName: string | null;
    username: string | null;
    meetingNotesAccess: boolean;
    microsoft: MicrosoftState;
    missingPermissions: string[];
    teamsReady: boolean;
    verifiedMicrosoftIdentity: boolean;
    autoImportSkip: MemberSkip | null;
    failures: MemberFailure[];
    appImportCovered: boolean;
}

export interface TeamsOrgOverview {
    windowDays: number;
    generatedAt: string;
    truncated: boolean;
    settings: OrgTeamsChoices;
    checks: TeamsCheck[];
    totals: OverviewTotals;
    members: TeamsMemberRow[];
}

const CAPABILITY_CONCURRENCY = 8;
export const DEFAULT_WINDOW_DAYS = 7;

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

async function safely<T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> {
    try { return await run(); } catch (err) {
        lazy.deps.log.warn(`[TeamsSetup] overview: ${what} unreadable:`, (err as Error).message);
        return fallback;
    }
}

function failuresByUser(rows: { userId: string; code: string; count: number }[]): Map<string, { code: string; count: number }[]> {
    const map = new Map<string, { code: string; count: number }[]>();
    for (const r of rows) {
        const list = map.get(r.userId) || [];
        list.push({ code: r.code, count: r.count });
        map.set(r.userId, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
    return map;
}

/**
 * The username as shown, or null when it is an e-mail address: accounts made
 * by Microsoft sign-in and directory sync take the address as their username,
 * and this answer never carries one.
 */
export function shownUsername(username: string | null): string | null {
    return username && !username.includes('@') ? username : null;
}

function memberRow(r: OrgMemberRow, extra: { access: boolean; covered: boolean; skip: SkipState | null; failures: { code: string; count: number }[] }): TeamsMemberRow {
    const microsoft: MicrosoftState = r.credentialStatus || 'none';
    const s = lazy.deps.settings;
    return {
        userId: r.userId,
        displayName: r.displayName,
        username: shownUsername(r.username),
        meetingNotesAccess: extra.access,
        microsoft,
        missingPermissions: microsoft === 'none' ? [] : s.missingTeamsPermissions(r.credentialScope, { includeOptional: true }),
        teamsReady: microsoft === 'active' && s.hasTeamsScopes(r.credentialScope),
        verifiedMicrosoftIdentity: !!(r.azureTenantId && r.azureUserId && GUID.test(r.azureTenantId) && GUID.test(r.azureUserId)),
        autoImportSkip: extra.skip ? { reason: extra.skip.reason, missingPermissions: [...(extra.skip.missingPermissions || [])], at: extra.skip.at } : null,
        failures: extra.failures,
        appImportCovered: extra.covered,
    };
}

function totalsOf(members: TeamsMemberRow[], requiredMissing: (m: TeamsMemberRow) => boolean): TeamsOrgOverview['totals'] {
    return {
        members: members.length,
        connected: members.filter((m) => m.microsoft === 'active').length,
        missingPermissions: members.filter((m) => m.microsoft === 'active' && requiredMissing(m)).length,
        needsReauth: members.filter((m) => m.microsoft === 'needs_reauth').length,
        skipped: members.filter((m) => m.autoImportSkip).length,
        failedImports: members.reduce((n, m) => n + m.failures.reduce((k, f) => k + f.count, 0), 0),
    };
}

async function orgChecks(orgId: string, config: AuthConfigLike, callerTenantId: string | null): Promise<TeamsCheck[]> {
    const record = await safely('admin consent outcome', () => lazy.deps.readAdminConsentOutcome(orgId), null);
    return [
        toCheck({ id: 'org.consent_link', option: 'A', dependsOn: [] }, consentLinkOutcome(config, callerTenantId), 'org'),
        toCheck({ id: 'org.admin_consent', option: 'A', dependsOn: [] }, adminConsentOutcome(record), 'org'),
    ];
}

/**
 * The overview of `orgId` (always the caller's own organisation; the route
 * never takes it from the request). Skip states recorded for another
 * organisation are ignored.
 */
export async function buildOrgOverview(a: { orgId: string; days?: number; config: AuthConfigLike; callerTenantId: string | null; now?: Date }): Promise<TeamsOrgOverview> {
    const windowDays = a.days ?? DEFAULT_WINDOW_DAYS;
    const { rows, truncated } = await lazy.deps.store.listOrgMemberRows(a.orgId, maxMembers());
    const ids = rows.map((r) => r.userId);
    const [failures, skips, orgDoc, checks] = await Promise.all([
        safely('failed imports', () => lazy.deps.store.countRecentTeamsFailures(a.orgId, windowDays), []),
        safely('skip state', () => lazy.deps.skipState.readSkips(ids), new Map<string, SkipState>()),
        safely('org settings', () => lazy.deps.settings.getOrgSettings(a.orgId), {} as Record<string, unknown>),
        orgChecks(a.orgId, a.config, a.callerTenantId),
    ]);
    const byUser = failuresByUser(failures);
    const access = await mapLimited(rows, CAPABILITY_CONCURRENCY, (r) => safely('capability', () => lazy.deps.hasCapability('meeting_notes', { userId: r.userId, orgId: a.orgId }), false));
    const accessById = new Map(rows.map((r, i) => [r.userId, access[i]]));
    const covered = await safely('app import coverage', () => lazy.deps.appImportCovered({ orgId: a.orgId, rows, config: a.config, access: accessById }), new Set<string>());
    // A skip counts only for this organisation and only while the poller still
    // visits the member; it is not cleared for someone it no longer visits.
    // Unreadable candidacy keeps the skips.
    const skippedIds = ids.filter((id) => skips.get(id)?.orgId === a.orgId);
    const visited = skippedIds.length
        ? await safely('auto-import candidates', () => lazy.deps.autoImportCandidates({ orgId: a.orgId, userIds: skippedIds }), new Set(skippedIds))
        : new Set<string>();
    const members = rows.map((r, i) => {
        const skip = visited.has(r.userId) ? skips.get(r.userId) || null : null;
        return memberRow(r, { access: access[i], covered: covered.has(r.userId), skip, failures: byUser.get(r.userId) || [] });
    });
    const scopes = new Map(rows.map((r) => [r.userId, r.credentialScope]));
    const required = (m: TeamsMemberRow) => lazy.deps.settings.missingTeamsPermissions(scopes.get(m.userId) ?? null).length > 0;
    return {
        windowDays,
        generatedAt: (a.now || new Date()).toISOString(),
        truncated,
        settings: { autoImport: boolOrNull(orgDoc?.autoImport), autoRecordConfig: boolOrNull(orgDoc?.autoRecordConfig) },
        checks,
        totals: totalsOf(members, required),
        members,
    };
}
