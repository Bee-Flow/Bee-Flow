// @typecheck
'use strict';
/**
 * The one merge rule for a scan that involved custom types.
 *
 *   - Overlapping spans collapse to the UNION of their extent (no character a
 *     detector flagged becomes visible by the act of merging; the same
 *     invariant as spanOverlap.js and the guard's own _finalise).
 *   - A custom type names the merged span over a built-in category: the admin
 *     said what this is.
 *   - Between custom types: words over pattern over ai (the more literal the
 *     evidence, the more it is trusted), then the longer span, then
 *     confidence, then the order the admin defined them in. Method comes
 *     before length on purpose: a fuzzy ai span often reaches past an exact
 *     match ("contract KL-12345" around the pattern's "KL-12345"), and the
 *     length rule would then hand the admin's exact type's value to the ai
 *     type's placeholder. The union extent is the same either way.
 *   - The winner carries the losers' categories in `alsoCategories`, so a
 *     tool block on a built-in category still fires when a custom type won
 *     the label.
 *
 * The result is disjoint, sorted by offset, and every span's `text` is
 * re-derived from the source string.
 */

const { resolveSpanOverlaps, defaultSpanBetter } = require('../../dlp/spanOverlap');
const { isCustomTypeId } = require('./ids');

const METHOD_RANK = Object.freeze({ words: 3, pattern: 2, ai: 1 });

/**
 * @param {{ methodFor: (id: string) => string|null, orderFor: (id: string) => number }} plan
 */
function makeBetter(plan) {
    return (a, b) => {
        const ac = isCustomTypeId(a.category);
        const bc = isCustomTypeId(b.category);
        if (ac !== bc) return ac;
        if (!ac) return defaultSpanBetter(a, b);
        const ma = METHOD_RANK[plan.methodFor(a.category) || ''] || 0;
        const mb = METHOD_RANK[plan.methodFor(b.category) || ''] || 0;
        if (ma !== mb) return ma > mb;
        if (a.length !== b.length) return a.length > b.length;
        const ca = a.confidence || 0;
        const cb = b.confidence || 0;
        if (ca !== cb) return ca > cb;
        return plan.orderFor(a.category) < plan.orderFor(b.category);
    };
}

/**
 * @param {Array<any>} entities  built-in and custom entities, absolute offsets into `text`
 * @param {string} text
 * @param {{ methodFor: (id: string) => string|null, orderFor: (id: string) => number, labelFor: (id: string) => string }} plan
 */
function mergeEntities(entities, text, plan) {
    const merged = resolveSpanOverlaps(entities, text, { better: makeBetter(plan), collectAlso: true });
    return merged
        .map(e => (isCustomTypeId(e.category) ? { ...e, label: plan.labelFor(e.category) } : e))
        .sort((a, b) => a.offset - b.offset);
}

/**
 * Node spans → entities in the shape the guard's entities have.
 * @param {Array<{start:number,end:number,typeId:string}>} spans
 * @param {string} text
 */
function spansToEntities(spans, text) {
    return spans.map(s => ({
        text: text.slice(s.start, s.end),
        category: s.typeId,
        subCategory: null,
        confidence: 1,
        offset: s.start,
        length: s.end - s.start,
        label: s.typeId,
    }));
}

module.exports = { mergeEntities, spansToEntities, makeBetter, METHOD_RANK };
