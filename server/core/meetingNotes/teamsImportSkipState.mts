/**
 * Why the Teams auto-import poller last skipped a user, kept so the setup
 * screens can say it instead of the poller staying silent.
 *
 * One configStore document per user, `teams_autoimport_skip_user_<userId>`:
 * `{ reason, missingPermissions, at, orgId }`. The stem is listed in
 * stores/user/userSecretKeys.mts, so account erasure deletes it. Written only
 * when the reason, the missing permissions or the organisation change, and
 * deleted as soon as the poller gets a session for the user again, so a
 * steady state costs one cached read per user per tick and no writes.
 *
 * Holds no token, no meeting, no e-mail address: a reason code and Graph
 * permission names only. A failure here is logged and never stops discovery.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../../telemetry/log') as { warn: (...args: unknown[]) => void };

export type TeamsSkipReason = 'not_licensed' | 'no_credential' | 'credential_needs_reauth' | 'credential_revoked'
    | 'missing_scopes' | 'session_unavailable' | 'app_token_failed';

export interface TeamsSkipState {
    reason: TeamsSkipReason;
    missingPermissions: string[];
    at: string;
    orgId: string | null;
}

interface ConfigStoreLike {
    getConfig(key: string): Promise<unknown>;
    setConfig(key: string, value: unknown): Promise<unknown>;
    deleteConfig(key: string): Promise<unknown>;
    getConfigsByKeys(keys: string[]): Promise<Record<string, unknown>>;
}

export const SKIP_STATE_STEM = 'teams_autoimport_skip';

const REASONS: ReadonlySet<string> = new Set<TeamsSkipReason>([
    'not_licensed', 'no_credential', 'credential_needs_reauth', 'credential_revoked',
    'missing_scopes', 'session_unavailable', 'app_token_failed',
]);

// Permission names are short Graph scope names; the caps only keep a corrupt
// or hostile document from growing a response.
const MAX_PERMISSIONS = 20;
const MAX_PERMISSION_LENGTH = 128;

let configStoreOverride: ConfigStoreLike | null = null;

function configStore(): ConfigStoreLike {
    return configStoreOverride ?? (nodeRequire('../../stores/configStore') as ConfigStoreLike);
}

/** Test seam: swap the configStore (call with `{}` to restore the real one). */
export function init(overrides: { configStore?: unknown } = {}): void {
    configStoreOverride = (overrides.configStore as ConfigStoreLike | undefined) ?? null;
}

export function skipStateKey(userId: string): string {
    return `${SKIP_STATE_STEM}_user_${userId}`;
}

function cleanPermissions(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    return list
        .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= MAX_PERMISSION_LENGTH)
        .slice(0, MAX_PERMISSIONS);
}

/** A stored document as a TeamsSkipState, or null when it is not one. */
function asState(value: unknown): TeamsSkipState | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (typeof v.reason !== 'string' || !REASONS.has(v.reason)) return null;
    return {
        reason: v.reason as TeamsSkipReason,
        missingPermissions: cleanPermissions(v.missingPermissions),
        at: typeof v.at === 'string' ? v.at : '',
        orgId: typeof v.orgId === 'string' && v.orgId ? v.orgId : null,
    };
}

function sameList(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Remember why the poller skipped `userId`. Writes only when the reason, the
 * missing permissions or the organisation differ from what is stored, so `at`
 * is when the skip started, not the last tick.
 */
export async function recordSkip(userId: string, orgId: string | null, reason: TeamsSkipReason, missingPermissions: string[] = []): Promise<void> {
    if (!userId || !REASONS.has(reason)) return;
    const missing = cleanPermissions(missingPermissions);
    const org = orgId || null;
    try {
        const key = skipStateKey(userId);
        const stored = asState(await configStore().getConfig(key));
        if (stored && stored.reason === reason && stored.orgId === org && sameList(stored.missingPermissions, missing)) return;
        const doc: TeamsSkipState = { reason, missingPermissions: missing, at: new Date().toISOString(), orgId: org };
        await configStore().setConfig(key, doc);
    } catch (err) {
        log.warn(`[TeamsAutoImport] could not record the skip state for user ${userId}: ${(err as Error)?.message}`);
    }
}

/** Forget the skip state of `userId`; deletes only when something is stored. */
export async function clearSkip(userId: string): Promise<void> {
    if (!userId) return;
    try {
        const key = skipStateKey(userId);
        const stored = await configStore().getConfig(key);
        if (stored === null || stored === undefined) return;
        await configStore().deleteConfig(key);
    } catch (err) {
        log.warn(`[TeamsAutoImport] could not clear the skip state for user ${userId}: ${(err as Error)?.message}`);
    }
}

/** The stored skip states of `userIds` (one batched read); users without one are absent. */
export async function readSkips(userIds: string[]): Promise<Map<string, TeamsSkipState>> {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).filter((id) => typeof id === 'string' && id))];
    const out = new Map<string, TeamsSkipState>();
    if (ids.length === 0) return out;
    const docs = await configStore().getConfigsByKeys(ids.map(skipStateKey));
    for (const id of ids) {
        const state = asState(docs?.[skipStateKey(id)]);
        if (state) out.set(id, state);
    }
    return out;
}
