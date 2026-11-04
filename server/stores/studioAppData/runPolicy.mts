/**
 * The policy of action-run rows (studio_app_action_runs, queries in ./actionRuns.mts): the id
 * shape, the heartbeat window and the retention knobs. Beside the store, in the platform layer,
 * so the jobs that sweep and prune the rows (jobs/studioAppActionRuns.js,
 * jobs/platformRetention.js) and the App Studio runner read one copy. Background jobs create
 * the rows today; the run log adds its own later.
 *
 *   STUDIO_APP_RUN_RETENTION_DAYS    30     rows older than this are deleted (0 = keep)
 *   STUDIO_APP_RUN_RESULT_TTL_HOURS  24     result / vars / effects / progress are nulled after this (0 = keep)
 *   STUDIO_APP_BACKGROUND_STALE_MS   90000  a running row whose heartbeat is older is dead (0 keeps the default)
 */

import { randomBytes } from 'node:crypto';

export const RUN_ID_RE = /^sar_[a-f0-9]{32}$/;

export function newRunId(): string {
    return `sar_${randomBytes(16).toString('hex')}`;
}

function intFromEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function retentionDays(env: Record<string, string | undefined> = process.env): number {
    return intFromEnv(env, 'STUDIO_APP_RUN_RETENTION_DAYS', 30);
}

export function resultTtlHours(env: Record<string, string | undefined> = process.env): number {
    return intFromEnv(env, 'STUDIO_APP_RUN_RESULT_TTL_HOURS', 24);
}

export const DEFAULT_STALE_MS = 90_000;

/** The heartbeat window: a running row whose last_activity_at is older belongs to a dead process. */
export function staleMs(env: Record<string, string | undefined> = process.env): number {
    return intFromEnv(env, 'STUDIO_APP_BACKGROUND_STALE_MS', DEFAULT_STALE_MS) || DEFAULT_STALE_MS;
}
