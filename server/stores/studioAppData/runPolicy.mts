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

import { createHash, randomBytes } from 'node:crypto';

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

// ── The run log (package 8) ─────────────────────────────────────────────────
//
//   STUDIO_APP_RUN_LOG                    on      `off` stops recording new runs (reads keep working)
//   STUDIO_APP_RUN_LOG_MAX_STEPS          500     step rows kept per run; later steps still count (0 = unlimited)
//   STUDIO_APP_RUN_LOG_MAX_RUNS_PER_APP   100000  newest runs kept per app by the prune (0 = unlimited)
//   STUDIO_APP_RUN_IDLE_CLOSE_MS          60000   a browser run with no step in flight and no activity this long is closed
//   STUDIO_APP_RUN_STALE_STEP_MS          900000  a browser run whose step never reported back is closed after this

export function runLogEnabled(env: Record<string, string | undefined> = process.env): boolean {
    const raw = String(env.STUDIO_APP_RUN_LOG ?? '').trim().toLowerCase();
    return !['off', '0', 'false', 'no'].includes(raw);
}

export function maxStepsPerRun(env: Record<string, string | undefined> = process.env): number {
    return intFromEnv(env, 'STUDIO_APP_RUN_LOG_MAX_STEPS', 500);
}

export function maxRunsPerApp(env: Record<string, string | undefined> = process.env): number {
    return intFromEnv(env, 'STUDIO_APP_RUN_LOG_MAX_RUNS_PER_APP', 100_000);
}

export function idleCloseMs(env: Record<string, string | undefined> = process.env): number {
    return intFromEnv(env, 'STUDIO_APP_RUN_IDLE_CLOSE_MS', 60_000) || 60_000;
}

export function staleStepMs(env: Record<string, string | undefined> = process.env): number {
    return intFromEnv(env, 'STUDIO_APP_RUN_STALE_STEP_MS', 900_000) || 900_000;
}

/** The key a browser sends to tie the steps of one click together (newRunKey in the client). */
export const CLIENT_RUN_KEY_RE = /^rk_[A-Za-z0-9_-]{16,64}$/;

export const MAX_RUN_LOG_ERROR = 300;

/**
 * An error as the run log stores it: the first line, at most 300 characters, with what could
 * carry a customer's value taken out: a JSON tail (a provider payload), every quoted string
 * except a lowercase field or table key (an echoed value, a name, a prompt: "Jan" is as
 * personal as a whole sentence), e-mail addresses. A code is not text and goes in its own column.
 */
// The shape of a field / table key (KEY_RE in core/dataEngine/dataModel/vocabulary.js).
const QUOTED_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function runLogError(text: unknown): string | null {
    if (text === null || text === undefined) return null;
    let s = String(text).split(/\r?\n/, 1)[0] ?? '';
    const tail = s.search(/[{[]\s*["'{[]/);
    if (tail >= 0) s = `${s.slice(0, tail).trimEnd()} …`;
    s = s.replace(/(["'“‘])([^"'”’]+)(["'”’])/g, (m: string, open: string, inner: string, close: string) => (QUOTED_KEY_RE.test(inner) ? m : `${open}…${close}`));
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-mail]');
    s = s.trim();
    if (!s) return null;
    return s.length > MAX_RUN_LOG_ERROR ? `${s.slice(0, MAX_RUN_LOG_ERROR - 1)}…` : s;
}

/** The anonymous viewer of a public page as the run log keeps them: a hash prefix, never the page token. */
export function visitorKey(id: unknown): string | null {
    if (typeof id !== 'string' || !id) return null;
    return `v_${createHash('sha256').update(`studio-run-visitor:${id}`).digest('hex').slice(0, 16)}`;
}
