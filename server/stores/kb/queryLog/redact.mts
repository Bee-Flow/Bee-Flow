/**
 * redact.mts: what of a log row may leave the log (step results, run history).
 */

import type { EntryRow } from './types.mts';

/**
 * Summary rows (the DEFAULT) carry no logged text at all: no question, passages, answer or
 * review note. Only `detail: 'full'` hands the decrypted content to the next steps.
 */
export function summarise(r: EntryRow): Record<string, unknown> {
    const { chunks, answer, citations, query, reviewNote, ...rest } = r;
    return { ...rest, query: null, reviewNote: null, chunks: [], answer: null, citations: [], chunkCount: r.chunkCount ?? chunks?.length ?? 0 };
}

/**
 * The step output as it may be PERSISTED (automation run history, which outlives the log's
 * retention and its erasure): the content fields are emptied, the metadata stays. The live
 * result is not touched.
 */
export function redactLogStepOutput(output: unknown): unknown {
    if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
    const o = output as Record<string, unknown>;
    const out: Record<string, unknown> = { ...o };
    if (Array.isArray(o.rows)) {
        out.rows = o.rows.map((r) => (r && typeof r === 'object' ? summarise(r as EntryRow) : r));
    }
    if ('note' in o) out.note = null;
    const would = o.wouldUpdate;
    if (would && typeof would === 'object') out.wouldUpdate = { ...(would as Record<string, unknown>), note: null };
    return out;
}

