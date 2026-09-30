/**
 * The test question (server/routes/knowledgeBases/ask.js): `POST /:id/ask`,
 * SSE with named events —
 *   kb_sources  the passages, FIRST, so they are on screen while the answer
 *               is still arriving (an empty list is an answer: the sources
 *               do not cover this)
 *   text        `{ text }`, appended as it comes
 *   done        the end
 *   error       instead of `done`
 * A refusal before the stream opens is JSON, which streamSse throws as an ApiError.
 */

import { pick } from '@/core/api/contract';
import { streamSse } from '@/core/api/sse';
import { toKbSources, type KbSource } from '@/shared/stream';

export type AskEvent =
    | { type: 'sources'; sources: KbSource[] }
    | { type: 'text'; text: string }
    | { type: 'done' }
    | { type: 'error'; message: string | null };

export function toAskEvent(event: string, data: unknown): AskEvent | null {
    if (event === 'kb_sources') return { type: 'sources', sources: toKbSources(pick(data, 'sources')) };
    if (event === 'text') {
        const text = pick(data, 'text');
        return typeof text === 'string' ? { type: 'text', text } : null;
    }
    if (event === 'done') return { type: 'done' };
    if (event === 'error') {
        const message = pick(data, 'error');
        return { type: 'error', message: typeof message === 'string' ? message : null };
    }
    return null;
}

export async function* askKnowledgeBase(kbId: string, question: string, signal?: AbortSignal): AsyncGenerator<AskEvent> {
    const path = `/api/kb/${encodeURIComponent(kbId)}/ask`;
    for await (const frame of streamSse(path, { body: { question }, signal })) {
        const event = toAskEvent(frame.event, frame.data);
        if (event) yield event;
    }
}
