// @typecheck strict
/**
 * Reading the JSON columns of a chat message back into their shapes. Each
 * keeps only what the wire contract names and drops the rest, so a column that
 * holds more than it should never leaks it through the API.
 */

'use strict';

/** @param {unknown} v */
function parseMentions(v) {
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
    if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []; } catch (_) { return []; }
    }
    return [];
}

/**
 * What an answer says about how it was made: the tier it ran on, and how many
 * values the Privacy Shield replaced (a count and kinds, never the values).
 * @param {unknown} v
 */
function parseAiMeta(v) {
    let meta = /** @type {{ usedSources?: unknown[], tier?: string, requestedTier?: string, redacted?: number, categories?: unknown[] } | null} */ (v);
    if (typeof v === 'string') {
        try { meta = JSON.parse(v); } catch (_) { return null; }
    }
    if (!meta || typeof meta !== 'object') return null;
    /** @param {unknown} x */
    const str = (x) => (typeof x === 'string' && x ? x.slice(0, 64) : null);
    return {
        ...(Array.isArray(meta.usedSources) ? { usedSources: parseRefs(meta.usedSources).slice(0, 20) } : {}),
        tier: str(meta.tier),
        requestedTier: str(meta.requestedTier),
        redacted: typeof meta.redacted === 'number' && Number.isFinite(meta.redacted) ? Math.max(0, Math.floor(meta.redacted)) : 0,
        categories: Array.isArray(meta.categories) ? meta.categories.map(str).filter(Boolean).slice(0, 20) : [],
    };
}

/**
 * The project items a message tags: `{ kind, id }` pairs, nothing else.
 * @param {unknown} v
 */
function parseRefs(v) {
    let list = v;
    if (typeof v === 'string') {
        try { list = JSON.parse(v); } catch (_) { return []; }
    }
    if (!Array.isArray(list)) return [];
    return list
        .filter((x) => x && (x.kind === 'document' || x.kind === 'notebook' || x.kind === 'meeting' || x.kind === 'task') && typeof x.id === 'string' && x.id)
        .map((x) => ({ kind: x.kind, id: x.id }));
}

module.exports = { parseMentions, parseRefs, parseAiMeta };
