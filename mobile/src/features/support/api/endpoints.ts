/**
 * Support threads (routes/support/threads.js). The support module is optional
 * (`requireModule('support')`), so a self-host without it answers 404, which
 * `optional` folds to null — a different thing from "you have no threads".
 */

import { api } from '@/core/api/client';
import { optional } from '@/core/api/optional';

import { readCreatedThread, readThreadDetail, readThreadList } from './readers';
import type { CreatedThread, SupportThread, SupportThreadDetail } from '../model/types';

/** Your own threads, newest first; the server caps the list at fifty. */
export async function listMySupportThreads(signal?: AbortSignal): Promise<SupportThread[] | null> {
    return optional(async () =>
        readThreadList(await api.get<unknown>('/api/support/threads/mine', { signal })),
    );
}

export async function getSupportThread(
    id: string,
    signal?: AbortSignal,
): Promise<SupportThreadDetail | null> {
    return optional(async () =>
        readThreadDetail(
            await api.get<unknown>(`/api/support/threads/${encodeURIComponent(id)}`, { signal }),
        ),
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
}): Promise<CreatedThread | null> {
    return readCreatedThread(
        await api.post<unknown>('/api/support/threads', { ...body, source: 'in_app' }),
    );
}

export async function replyToSupportThread(id: string, message: string): Promise<void> {
    await api.post(`/api/support/threads/${encodeURIComponent(id)}/messages`, { body: message });
}
