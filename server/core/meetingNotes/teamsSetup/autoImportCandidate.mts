/**
 * Whether the Teams auto-import poller still visits a user, by the rule of
 * teamsAutoImport.js `discoverUser`: the effective `autoImport` setting is on,
 * or the user holds a live, explicit "record" mark for a Teams meeting.
 *
 * A stored skip state (teamsImportSkipState.mts) only says something while
 * this holds. The poller drops it when it still visits a user who stopped
 * qualifying, but a user who is no longer listed as a candidate at all (the
 * organisation switched auto-import off, the last mark expired) is never
 * visited again, so the setup screens ask this before they show a skip.
 *
 * Reads stored settings and meeting preferences only; no Graph call.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type PrefRow = { userId?: string | null; record?: boolean | null; idKind?: string; updatedAt?: string | null };

export interface AutoImportCandidateDeps {
    resolveTeamsNotesSettings: (a: { orgId: string | null; userId: string }) => Promise<{ autoImport: boolean }>;
    loadMeetingPrefs: (a: { provider: string; userId: string; orgId: string | null }) => Promise<{ rows: PrefRow[] }>;
    hasLiveRecordOptIn: (rows: PrefRow[]) => boolean;
    listUsersWithRecordOptIn: (a: { provider: string }) => Promise<string[]>;
}

type LazyDeps<T> = { deps: T; init: (overrides?: Partial<T>) => void };
const { lazyDeps } = nodeRequire('../lazyDeps.js') as { lazyDeps: <T>(loaders: Record<string, () => unknown>) => LazyDeps<T> };
const lazy = lazyDeps<AutoImportCandidateDeps>({
    resolveTeamsNotesSettings: () => (nodeRequire('../teamsNotesSettings.js') as Pick<AutoImportCandidateDeps, 'resolveTeamsNotesSettings'>).resolveTeamsNotesSettings,
    loadMeetingPrefs: () => (nodeRequire('../../../stores/meetingPrefsStore.js') as Pick<AutoImportCandidateDeps, 'loadMeetingPrefs'>).loadMeetingPrefs,
    hasLiveRecordOptIn: () => (nodeRequire('../../../stores/meetingPrefsOptIn.js') as Pick<AutoImportCandidateDeps, 'hasLiveRecordOptIn'>).hasLiveRecordOptIn,
    listUsersWithRecordOptIn: () => (nodeRequire('../../../stores/meetingPrefsOptIn.js') as Pick<AutoImportCandidateDeps, 'listUsersWithRecordOptIn'>).listUsersWithRecordOptIn,
});

/** Test seam: swap collaborators (the rest stay the real ones). */
export function init(overrides: Partial<AutoImportCandidateDeps> = {}): void { lazy.init(overrides); }

/**
 * One user. `autoImport`, when given, is the already resolved effective
 * setting (saves a read); otherwise it is resolved here.
 */
export async function isAutoImportCandidate(a: { userId: string; orgId: string | null; autoImport?: boolean }): Promise<boolean> {
    const autoImport = a.autoImport ?? (await lazy.deps.resolveTeamsNotesSettings({ orgId: a.orgId, userId: a.userId })).autoImport;
    if (autoImport) return true;
    const prefs = await lazy.deps.loadMeetingPrefs({ provider: 'teams', userId: a.userId, orgId: a.orgId });
    return lazy.deps.hasLiveRecordOptIn(prefs?.rows || []);
}

/**
 * The candidates among `userIds`, members of `orgId`. The marks are read in
 * one query, and only when a user's setting is off.
 */
export async function autoImportCandidates(a: { orgId: string; userIds: string[] }): Promise<Set<string>> {
    const out = new Set<string>();
    let marked: Set<string> | null = null;
    for (const userId of a.userIds) {
        if ((await lazy.deps.resolveTeamsNotesSettings({ orgId: a.orgId, userId })).autoImport) { out.add(userId); continue; }
        marked ??= new Set(await lazy.deps.listUsersWithRecordOptIn({ provider: 'teams' }));
        if (marked.has(userId)) out.add(userId);
    }
    return out;
}
