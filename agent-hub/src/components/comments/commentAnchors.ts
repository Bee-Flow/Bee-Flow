// Pure helpers for comment anchors: is a thread's passage still in the text,
// where does a thread sit in the item, and keeping an anchor within the
// server's bounds. No React, no text of their own.

import type { CommentAnchor, CommentThread } from '../../api/queries/comments';

export const QUOTE_MAX = 2000;
export const CONTEXT_MAX = 200;

export type AnchorState = 'whole' | 'found' | 'outdated' | 'unknown' | 'unreadable';

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Whether the quote can still be found in the item's text. Whitespace does not
 * count, case only when the exact spelling is gone. `text` null: not known
 * (the host gave no way to read the text).
 */
export function anchorState(thread: Pick<CommentThread, 'anchor' | 'anchorUnreadable'>, text: string | null): AnchorState {
    if (thread.anchorUnreadable) return 'unreadable';
    if (!thread.anchor) return 'whole';
    if (text === null) return 'unknown';
    const quote = collapse(thread.anchor.quote || '');
    if (!quote) return 'whole';
    const hay = collapse(text);
    if (hay.includes(quote) || hay.toLowerCase().includes(quote.toLowerCase())) return 'found';
    return 'outdated';
}

/** An anchor cut to what the server accepts: the start of a long quote, the ends of the context nearest to it. */
export function clampAnchor(anchor: CommentAnchor): CommentAnchor {
    const out: CommentAnchor = {
        quote: anchor.quote.slice(0, QUOTE_MAX),
        prefix: (anchor.prefix || '').slice(-CONTEXT_MAX),
        suffix: (anchor.suffix || '').slice(0, CONTEXT_MAX),
        blockIndex: Number.isInteger(anchor.blockIndex) && anchor.blockIndex >= 0 ? anchor.blockIndex : 0,
    };
    if (anchor.relStart && anchor.relEnd) { out.relStart = anchor.relStart; out.relEnd = anchor.relEnd; }
    if (anchor.sectionId) out.sectionId = anchor.sectionId;
    return out;
}

/** A usable selection: some words, not just whitespace. */
export function isUsableAnchor(anchor: CommentAnchor | null | undefined): anchor is CommentAnchor {
    return !!anchor && typeof anchor.quote === 'string' && anchor.quote.trim().length > 0;
}

/**
 * Threads in reading order: the ones about the whole item first, then by the
 * block their passage starts in, then oldest first.
 */
export function inReadingOrder<T extends Pick<CommentThread, 'anchor' | 'createdAt'>>(threads: T[]): T[] {
    const position = (t: T) => (t.anchor ? (Number.isFinite(t.anchor.blockIndex) ? t.anchor.blockIndex : 0) : -1);
    return [...threads].sort((a, b) => position(a) - position(b) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** The passage on one or a few lines, for the card. */
export function quoteExcerpt(quote: string, max = 180): string {
    const flat = collapse(quote);
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
