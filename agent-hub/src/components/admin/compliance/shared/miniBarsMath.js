/**
 * miniBarsMath — bucketing for the score trend bars on the framework cards
 * (Compliance Center redesign, Sep 2026; artboard 1a: twelve 26px bars,
 * "90 dagen · +9").
 *
 * `GET /score-history` returns one row per sweep — several a day when someone
 * presses "Run now", none for a week the org was quiet. Twelve bars want
 * twelve EQUAL time windows, not the last twelve rows, so the shape of the
 * trend is honest about time: a flat week stays flat, a busy afternoon does
 * not fan out into eight bars.
 *
 * Rules, each pinned by a test:
 *   - the window is the last `days` days up to `now`, cut into `bars` equal
 *     buckets; a row lands in the bucket its `captured_at` falls in, the LAST
 *     row of a bucket wins (the newest sweep is the truth of that window);
 *   - an empty bucket CARRIES the previous value forward — the score did not
 *     drop to zero, nobody measured it — and the latest row before the window
 *     seeds the carry so a quiet first fortnight is not a hole;
 *   - a bucket with nothing before it either is 0 and marked empty;
 *   - rows that are malformed (no parseable date, no numeric score) are
 *     skipped, never thrown on; an empty or absent history yields twelve
 *     zero bars, and a `delta` of null — "no trend yet", not "+0".
 *
 * Per-framework value: the `scores` JSONB keyed by framework id (contract
 * §1.3), falling back to the three legacy columns for rows written before the
 * column existed, and to `overall_score` when no framework is asked for.
 *
 * Pure and React-free; MiniBars.jsx renders the result.
 */

export const DAY_MS = 86_400_000;

/** Legacy per-framework columns on compliance_score_history (still written). */
export const LEGACY_COLUMN = Object.freeze({
    gdpr: 'gdpr_score',
    aia: 'aia_score',
    iso27001: 'iso_score',
});

const finite = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

/**
 * The score a history row holds for one framework (or overall when
 * `frameworkId` is empty). `scores[frameworkId]` first, then the legacy column
 * for the three original frameworks, then `overall_score`. Null when the row
 * carries nothing usable.
 */
export function valueOf(row, frameworkId) {
    if (!row || typeof row !== 'object') return null;
    if (frameworkId) {
        const fromJson = finite(row.scores?.[frameworkId]);
        if (fromJson !== null) return fromJson;
        const legacy = LEGACY_COLUMN[frameworkId];
        // A legacy-column framework whose column is empty has no value for
        // this row: the overall score is not a stand-in for GDPR's.
        if (legacy) return finite(row[legacy]);
    }
    return finite(row.overall_score);
}

const timeOf = (row) => {
    const raw = row?.captured_at ?? row?.created_at;
    if (raw === null || raw === undefined) return null;
    const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
    return Number.isFinite(ms) ? ms : null;
};

/**
 * Bucket `history` into `bars` equal windows over the last `days` days.
 *
 * Returns { values, filled, first, last, delta, days, bars }:
 *   values  number[bars] — 0..100 per bucket (0 when empty)
 *   filled  ('measured' | 'carried' | 'empty')[bars]
 *   first   value of the first non-empty bucket, or null
 *   last    value of the last non-empty bucket, or null
 *   delta   last − first (rounded), or null when fewer than one value exists
 */
export function bucketHistory(history, { days = 90, bars = 12, frameworkId, now = Date.now() } = {}) {
    const nBars = Math.max(1, Math.floor(Number(bars)) || 1);
    const spanDays = Math.max(1, Number(days) || 1);
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const end = Number.isFinite(nowMs) ? nowMs : Date.now();
    const start = end - spanDays * DAY_MS;
    const width = (end - start) / nBars;

    const measured = new Array(nBars).fill(null);
    const measuredAt = new Array(nBars).fill(-Infinity);
    let seed = null;
    let seedAt = -Infinity;

    for (const row of Array.isArray(history) ? history : []) {
        const ms = timeOf(row);
        const value = valueOf(row, frameworkId);
        if (ms === null || value === null) continue;
        if (ms < start) {
            // The newest pre-window row seeds the carry-forward.
            if (ms > seedAt) { seedAt = ms; seed = value; }
            continue;
        }
        // Rows stamped after `now` (clock skew) belong to the last bucket.
        const idx = Math.min(nBars - 1, Math.max(0, Math.floor((ms - start) / width)));
        if (ms >= measuredAt[idx]) { measuredAt[idx] = ms; measured[idx] = value; }
    }

    const values = new Array(nBars).fill(0);
    const filled = new Array(nBars).fill('empty');
    let prev = seed;
    for (let i = 0; i < nBars; i++) {
        if (measured[i] !== null) {
            prev = measured[i];
            values[i] = clamp(prev);
            filled[i] = 'measured';
        } else if (prev !== null) {
            values[i] = clamp(prev);
            filled[i] = 'carried';
        }
    }

    const present = values.filter((_, i) => filled[i] !== 'empty');
    const first = present.length ? present[0] : null;
    const last = present.length ? present[present.length - 1] : null;
    const delta = first === null ? null : Math.round(last - first);

    return { values, filled, first, last, delta, days: spanDays, bars: nBars };
}

function clamp(v) {
    return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * The signed delta as the card prints it: "+9", "−8" (U+2212, a real minus,
 * not a hyphen), "±0" for no change. Null → null (the caller says "no trend").
 */
export function formatDelta(delta) {
    if (delta === null || delta === undefined || !Number.isFinite(Number(delta))) return null;
    const n = Math.round(Number(delta));
    if (n > 0) return `+${n}`;
    if (n < 0) return `−${Math.abs(n)}`;
    return '±0';
}
