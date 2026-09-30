/**
 * The Test tab's endpoints (server/routes/skills/test.js and the test-runs
 * read in routes/skills.js). All carry `manage_skills`; the runs read and the
 * run itself also refuse a visible-but-not-editable skill with 403
 * `not_editable`.
 *
 * `POST /:id/test` is SSE with NAMED events:
 *   notice  `{ code: 'kb_dropped', declared, used }` — fewer bases searched
 *   answer  `{ text }` — what the agent replied
 *   done    `{ run }`  — the stored, graded run
 *   error   `{ error, code }` instead of `done`
 * A refusal before the stream opens is ordinary JSON, which streamSse turns
 * into an ApiError carrying the code.
 */

import { api } from '@/core/api/client';
import { pick } from '@/core/api/contract';
import { streamSse } from '@/core/api/sse';

import { skillPath } from './endpoints';
import { readTestAgents, readTestRun, readTestRuns } from './readers';
import type { TestAgent, TestRun } from '../model/types';

export async function listTestAgents(signal?: AbortSignal): Promise<TestAgent[]> {
    return readTestAgents(await api.get<unknown>('/api/skills/test-agents', { signal }));
}

export async function listTestRuns(id: string, signal?: AbortSignal): Promise<TestRun[]> {
    return readTestRuns(await api.get<unknown>(`${skillPath(id)}/test-runs`, { signal }));
}

export type TestEvent =
    | { type: 'answer'; text: string }
    | { type: 'kb_dropped'; declared: number; used: number }
    | { type: 'done'; run: TestRun | null }
    | { type: 'error'; code?: string; message?: string };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** One wire frame → the event the tab acts on, or null for anything else (pings). */
export function toTestEvent(event: string, data: unknown): TestEvent | null {
    if (event === 'answer') return { type: 'answer', text: str(pick(data, 'text')) ?? '' };
    if (event === 'notice' && pick(data, 'code') === 'kb_dropped') {
        return { type: 'kb_dropped', declared: Number(pick(data, 'declared')) || 0, used: Number(pick(data, 'used')) || 0 };
    }
    if (event === 'done') {
        const run = pick(data, 'run');
        return { type: 'done', run: run && typeof run === 'object' ? readTestRun(run) : null };
    }
    if (event === 'error') return { type: 'error', code: str(pick(data, 'code')), message: str(pick(data, 'error')) };
    return null;
}

export async function* runSkillTest(
    id: string,
    input: { agentId: string | null; question: string },
    signal?: AbortSignal,
): AsyncGenerator<TestEvent> {
    // A graded run is one agent turn plus a grading call; allow the silence.
    for await (const frame of streamSse(`${skillPath(id)}/test`, { body: input, signal, idleTimeoutMs: 120_000 })) {
        const event = toTestEvent(frame.event, frame.data);
        if (event) yield event;
    }
}
