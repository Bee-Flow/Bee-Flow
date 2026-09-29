/**
 * How well a retrieved passage matched, RELATIVE to the others in the same
 * answer — and deliberately without a number.
 *
 * ── WHY NOT A PERCENTAGE ────────────────────────────────────────────
 * Both citation surfaces used to render `Math.round(score * 100) + '%'`. That
 * number is not a percentage of anything:
 *
 *   • With no reranker configured the score is an RRF fusion score — around
 *     0.016 for a good hit, because it is a sum of 1/(60+rank) terms. It
 *     rendered as "2%", beside a passage that was in fact the best match in
 *     the document.
 *   • With a cross-encoder it is that model's logit-derived relevance, which
 *     is comparable between passages of ONE query and meaningless across two.
 *   • The old bar also coloured on absolute thresholds (>=80 accent, >=60
 *     amber), so with RRF scores every passage in the product was grey.
 *
 * A person reading "2%" concludes the knowledge base is broken. A person
 * reading "68%" concludes it is a confidence, and eventually asks for a
 * threshold setting built on it. Neither conclusion is available from the
 * number, so the number is not shown: the bar is scaled against the best hit
 * in the SAME answer, which is the only comparison the score supports.
 */
import React from 'react';

/** A floor, so the weakest hit is still visibly a hit rather than an empty rail. */
const MIN_WIDTH = 0.08;

export function relativeWidth(score, best) {
    const s = Number(score);
    const b = Number(best);
    if (!Number.isFinite(s) || !Number.isFinite(b) || b <= 0 || s <= 0) return 0;
    return Math.max(MIN_WIDTH, Math.min(1, s / b));
}

/**
 * @param {number} score  this passage's score
 * @param {number} best   the highest score in the same answer
 */
export default function RelevanceBar({ score, best, className = '' }) {
    const width = relativeWidth(score, best);
    if (width === 0) return null;
    return (
        <div
            className={className}
            data-testid="relevance-bar"
            data-width={width.toFixed(2)}
            aria-hidden="true"
            style={{ height: 3, borderRadius: 999, background: 'var(--bg-tertiary)', overflow: 'hidden' }}
        >
            <div style={{ width: `${width * 100}%`, height: '100%', background: 'var(--accent-primary)' }} />
        </div>
    );
}
