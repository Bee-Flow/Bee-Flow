/**
 * Cowork — work you hand over, that runs without you.
 *
 * Every route below has shipped on the server since before this app existed,
 * and `mobile/` had never called one of them. There was no Cowork screen, no
 * tab, no menu row and no route: `grep -rni cowork mobile/app/` returned
 * nothing across 65 route files. The only way in was a push notification about
 * a run — and that notification pointed at `/tasks`, which reads
 * `/api/ai-tasks` and `/api/reminders`, a different store entirely, so it
 * opened a screen that structurally could not contain the thing it was about.
 *
 * Paths are the full client-visible ones: the router is mounted at
 * `/api/cowork` in server/index.js.
 */

import { api } from '../../api/client';
import { field, shapeListOf } from '../../api/contract';

export const coworkKeys = {
    schedules: ['cowork', 'schedules'] as const,
    schedule: (id: string) => ['cowork', 'schedule', id] as const,
    runs: (id: string) => ['cowork', 'runs', id] as const,
};

/** Mirrors `rowToSchedule` in server/stores/coworkStore.js. */
export interface CoworkSchedule {
    id: string;
    userId: string;
    title: string;
    prompt: string;
    repeatInterval: string | null;
    daysOfWeek: string[] | null;
    timeOfDay: string | null;
    nextRunAt: string | null;
    lastRunAt: string | null;
    lastResult: string | null;
    lastStatus: string | null;
    isActive: boolean;
    modelTier: string | null;
    runCount: number;
    timezone: string | null;
    agentId: string | null;
    conversationId: string | null;
    createdAt: string | null;
}

export interface CoworkRun {
    id?: string;
    status?: string;
    result?: string | null;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    createdAt?: string | null;
}

/**
 * What the AI composer returns from a plain-language brief. Note what is NOT
 * here: `nextRunAt`. The composer is read-only and returns a shape, not a
 * schedule — turning "every Monday morning" into an instant is the client's
 * job (see schedule.ts), and POST /api/cowork 400s without it.
 */
export interface ComposedCowork {
    title?: string;
    prompt?: string;
    repeatInterval?: string | null;
    daysOfWeek?: string[] | null;
    timeOfDay?: string | null;
    runOnce?: boolean;
    agentId?: string | null;
}

/**
 * Allow-list mirror of `rowToSchedule` — the same field list
 * serverContract.test.ts pins on the server side. The tab renders every one
 * of these directly, so a missing field degrades to a stated default
 * ("Untitled cowork", inactive, zero runs) instead of an undefined mid-render.
 */
const readScheduleRows = shapeListOf({
    id: field.str(''),
    userId: field.str(''),
    title: field.str('Untitled cowork'),
    prompt: field.str(''),
    repeatInterval: field.strOrNull,
    daysOfWeek: field.strArrayOrNull,
    timeOfDay: field.strOrNull,
    nextRunAt: field.strOrNull,
    lastRunAt: field.strOrNull,
    lastResult: field.strOrNull,
    lastStatus: field.strOrNull,
    isActive: field.bool(false),
    modelTier: field.strOrNull,
    runCount: field.num(0),
    timezone: field.strOrNull,
    agentId: field.strOrNull,
    conversationId: field.strOrNull,
    createdAt: field.strOrNull,
});

export async function listSchedules(signal?: AbortSignal): Promise<CoworkSchedule[]> {
    const res = await api.get<unknown[] | { schedules?: unknown }>('/api/cowork', {
        signal,
    });
    const rows = Array.isArray(res) ? res : res?.schedules;
    // An id-less row has no detail screen, no toggle and no delete — skip it.
    return readScheduleRows(rows).filter((s) => s.id !== '');
}

export async function getSchedule(id: string, signal?: AbortSignal): Promise<CoworkSchedule | null> {
    return api.get<CoworkSchedule>(`/api/cowork/${encodeURIComponent(id)}`, { signal });
}

export async function listRuns(id: string, signal?: AbortSignal): Promise<CoworkRun[]> {
    const res = await api.get<CoworkRun[] | { runs?: CoworkRun[] }>(
        `/api/cowork/${encodeURIComponent(id)}/runs`,
        { signal },
    );
    if (Array.isArray(res)) return res;
    return res?.runs ?? [];
}

/** Read-only. Returns a shape to confirm, never a created schedule. */
export async function composeCowork(
    brief: string,
    signal?: AbortSignal,
): Promise<ComposedCowork | null> {
    return api.post<ComposedCowork>(
        '/api/cowork/compose',
        { brief, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        { signal },
    );
}

export async function createSchedule(body: unknown): Promise<CoworkSchedule | null> {
    return api.post<CoworkSchedule>('/api/cowork', body);
}

/** Pause or resume. The server flips `is_active` and recomputes the next run. */
export async function toggleSchedule(id: string): Promise<CoworkSchedule | null> {
    return api.post<CoworkSchedule>(`/api/cowork/${encodeURIComponent(id)}/toggle`);
}

export async function runNow(id: string): Promise<void> {
    await api.post(`/api/cowork/${encodeURIComponent(id)}/run-now`);
}

export async function deleteSchedule(id: string): Promise<void> {
    await api.delete(`/api/cowork/${encodeURIComponent(id)}`);
}
