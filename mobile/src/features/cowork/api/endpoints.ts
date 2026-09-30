/**
 * Cowork — work you hand over, that runs without you.
 *
 * Every route below had shipped on the server long before `mobile/` called
 * one. The only way in used to be a push notification about a run — and that
 * pointed at `/tasks`, which reads `/api/ai-tasks` and `/api/reminders`, a
 * different store entirely, so it opened a screen that structurally could not
 * contain the thing it was about.
 *
 * Paths are the full client-visible ones: the router is mounted at
 * `/api/cowork` in server/index.js.
 */

import { api } from '@/core/api/client';
import { nullable } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import { readComposed, readRuns, readSchedule, readSchedules } from './readers';
import type { CoworkPayload } from '../model/schedule';
import type { ComposedCowork, CoworkRun, CoworkSchedule } from '../model/types';

const path = (id: string) => `/api/cowork/${encodeURIComponent(id)}`;

export async function listSchedules(signal?: AbortSignal): Promise<CoworkSchedule[]> {
    // An id-less row has no detail screen, no toggle and no delete — skip it.
    return withId(readSchedules(await api.get<unknown>('/api/cowork', { signal })));
}

export async function getSchedule(id: string, signal?: AbortSignal): Promise<CoworkSchedule | null> {
    return nullable(readSchedule)(await api.get<unknown>(path(id), { signal }));
}

/**
 * One schedule's run history, newest first. Not the automation runner's
 * `listRuns` (features/automations): a Cowork run is a row in `cowork_runs`,
 * served by /api/cowork/:id/runs, with its own shape.
 */
export async function listScheduleRuns(id: string, signal?: AbortSignal): Promise<CoworkRun[]> {
    return readRuns(await api.get<unknown>(`${path(id)}/runs`, { signal }));
}

/** Read-only. Returns a shape to confirm, never a created schedule. */
export async function composeCowork(
    brief: string,
    signal?: AbortSignal,
): Promise<ComposedCowork | null> {
    return nullable(readComposed)(
        await api.post<unknown>(
            '/api/cowork/compose',
            { brief, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            { signal },
        ),
    );
}

export async function createSchedule(body: CoworkPayload): Promise<CoworkSchedule | null> {
    return nullable(readSchedule)(await api.post<unknown>('/api/cowork', body));
}

/** Pause or resume. The server flips `is_active` and recomputes the next run. */
export async function toggleSchedule(id: string): Promise<CoworkSchedule | null> {
    return nullable(readSchedule)(await api.post<unknown>(`${path(id)}/toggle`));
}

export async function runNow(id: string): Promise<void> {
    await api.post(`${path(id)}/run-now`);
}

export async function deleteSchedule(id: string): Promise<void> {
    await api.delete(path(id));
}
