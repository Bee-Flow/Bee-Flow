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

import { ApiError, api } from '@/core/api/client';
import { nullable } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import {
    readComposed,
    readNeeds,
    readReceipt,
    readGoalLine,
    readRuns,
    readSchedule,
    readSchedules,
    readShared,
    readSharedView,
} from './readers';
import type { CoworkPayload } from '../model/schedule';
import type {
    ComposedCowork,
    CoworkGoalLine,
    CoworkNeed,
    CoworkReceipt,
    CoworkRun,
    CoworkSchedule,
    ReviewAction,
    SharedItem,
    SharedView,
} from '../model/types';

const path = (id: string) => `/api/cowork/${encodeURIComponent(id)}`;

export async function listSchedules(signal?: AbortSignal): Promise<CoworkSchedule[]> {
    // An id-less row has no detail screen, no toggle and no delete — skip it.
    return withId(readSchedules(await api.get<unknown>('/api/cowork', { signal })));
}

/** Everything of the caller's Cowork work that waits for them, most urgent first. */
export async function listNeedsYou(signal?: AbortSignal): Promise<CoworkNeed[]> {
    return readNeeds(await api.get<unknown>('/api/cowork/needs-you', { signal }));
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

/** Someone else's work that is shared with the caller, as a viewer or as the one who decides its questions. */
export async function listShared(signal?: AbortSignal): Promise<SharedItem[]> {
    return readShared(await api.get<unknown>('/api/cowork/shared', { signal }));
}

/** One shared item, read only (the owner's own edit routes refuse anyone else). */
export async function getShared(id: string, signal?: AbortSignal): Promise<SharedView | null> {
    return readSharedView(await api.get<unknown>(`/api/cowork/shared/${encodeURIComponent(id)}`, { signal }));
}

/**
 * One run's receipt. A 404 is the answer "no receipt yet" (the sweep writes it
 * a few minutes after the run closed), not a failure: it reads as null.
 */
export async function getRunReceipt(id: string, runId: string, signal?: AbortSignal): Promise<CoworkReceipt | null> {
    try {
        return readReceipt(await api.get<unknown>(`${path(id)}/runs/${encodeURIComponent(runId)}/receipt`, { signal }));
    } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
    }
}

/** Handle a run that asked its owner: answer it (the agent continues), or close it as done by hand or not needed. */
export async function resolveReview(id: string, runId: string, action: ReviewAction, answer?: string): Promise<void> {
    await api.post(
        `${path(id)}/runs/${encodeURIComponent(runId)}/review`,
        action === 'answer' ? { action, answer: (answer ?? '').trim() } : { action },
    );
}

/** An item's goal line: its sentence and latest count, or null without a goal. */
export async function getGoal(id: string, signal?: AbortSignal): Promise<CoworkGoalLine | null> {
    return readGoalLine(await api.get<unknown>(`${path(id)}/goal`, { signal }));
}
