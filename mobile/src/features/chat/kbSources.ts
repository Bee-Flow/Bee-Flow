/**
 * The server's citation shape, narrowed to what this app can render.
 *
 * ── WHY A MAPPER AND NOT A CAST ─────────────────────────────────────
 * Two of the three streams wrote `data.sources as KbSource[]` and were done.
 * A cast is a promise, not a check, and this one was false: `KbSource` calls
 * the passage `snippet` and the server has never sent a `snippet` — it sends
 * `content`, with `preview` alongside it as a one-release alias. So every
 * source card in chat and agents rendered a title and nothing under it, while
 * the text sat in the payload under a key nothing read. The notebook stream
 * mapped properly and looked better for no reason anyone could point at.
 *
 * ── ADDITIVE IN BOTH DIRECTIONS ─────────────────────────────────────
 * Every field is optional and anything of the wrong type becomes `undefined`,
 * so a payload from an older server — title, content, score, and none of the
 * rest — maps to exactly what it always did, and a payload from a newer one
 * keeps the parts this app has no use for yet instead of dropping them on the
 * floor. Nothing is renamed: `snippet` stays `snippet`, because the card reads
 * it, and the server keys keep their own names.
 *
 * The shape itself is server/core/kb/citation.js.
 */

import type { KbSource } from './types';

/** A non-empty string, or nothing. An empty title is not a title. */
function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A whole number above zero, or nothing: page 0 and row 0 are not positions. */
function ordinal(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** One citation. `index` is the last-resort id, so every card has a key. */
export function toKbSource(raw: unknown, index: number): KbSource {
    const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    // `chunkId` is a number on the local path and a string on others.
    const chunkId = typeof s.chunkId === 'number' ? String(s.chunkId) : str(s.chunkId);
    return {
        id: str(s.id) ?? chunkId ?? String(index),
        title: str(s.title),
        url: str(s.url),
        // `content` first: `preview` is the alias that is on its way out.
        snippet: str(s.content) ?? str(s.preview),
        score: typeof s.score === 'number' ? s.score : undefined,
        kind: str(s.kind),
        section: str(s.section),
        page: ordinal(s.page),
        rowStart: ordinal(s.rowStart),
        rowEnd: ordinal(s.rowEnd),
        occurredAt: str(s.occurredAt),
        documentId: str(s.documentId),
        chunkId,
    };
}

/** The `kb_sources` payload's `sources` array. Anything else is no sources. */
export function toKbSources(raw: unknown): KbSource[] {
    return Array.isArray(raw) ? raw.map(toKbSource) : [];
}
