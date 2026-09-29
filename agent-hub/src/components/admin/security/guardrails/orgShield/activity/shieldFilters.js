/**
 * The cross-filter behind the "What happened" tab.
 *
 * Pure: no React, no `t()`, no fetching. Everything interesting here is
 * "which rows survive this combination of filters" and "what do the lists say
 * once they have", and both deserve tests that assert on data rather than on
 * rendered copy.
 *
 * ── The model ─────────────────────────────────────────────────────────────
 * Every panel on the tab is both a READOUT and a CONTROL. A KPI, a day in the
 * chart, a destination, a person, a place, an outcome pill, a finding, and
 * every category chip — including the ones inside a log row — set a filter.
 * Filters STACK across eight independent axes and each is individually
 * removable, because the question an admin actually arrives with is a
 * conjunction: "what did *Sanne* send to *Gmail* on *that day*".
 *
 *   kind     one PII category             (a category chip, a "kinds of data" row)
 *   person   one actor                    (a "people" row)
 *   place    one surface                  (a "where it started" row)
 *   dest     one destination host         (a map pin, a destination row)
 *   region   one location state           (a region group, a finding, a KPI)
 *   outcome  what the shield did          (a legend pill, a finding, a KPI)
 *   pii      contains personal data       (the "personal data found" KPI)
 *   day      one local calendar day       (a bar in the day chart)
 *
 * `region` and `dest` only exist on calls to outside services, so either one
 * leaves the shield's own events out — which the chip at the top makes visible.
 *
 * ── Why the counts are honest about their source ──────────────────────────
 * The overview endpoints aggregate server-side over the WHOLE window; the
 * detail endpoints return at most 200 rows. So an unfiltered KPI must come
 * from the aggregate (it is right for the window), while a FILTERED one can
 * only be counted from the rows we hold. Those two numbers are not
 * interchangeable, and quietly swapping one for the other is how a dashboard
 * ends up reporting "14" for a window that saw 900. `countMode` below makes
 * the switch explicit so the UI can label a sample as a sample.
 */

/** The independent filter axes. Order is the order chips render in. */
export const FILTER_KEYS = ['kind', 'person', 'place', 'dest', 'region', 'outcome', 'pii', 'day'];

export const NO_FILTERS = Object.freeze({});

/**
 * Set an axis, or clear it when the same value is clicked again.
 *
 * Clicking the thing you already filtered by is how people expect to undo it,
 * so every control on the tab is a toggle rather than a one-way set.
 */
export function toggleFilter(filters, key, value) {
    if (!FILTER_KEYS.includes(key)) return filters;
    const next = { ...filters };
    // Loose-ish compare: `pii` is a boolean and everything else a string, and
    // all of them arrive from DOM handlers where a stray cast is easy.
    if (Object.hasOwn(next, key) && String(next[key]) === String(value)) delete next[key];
    else next[key] = value;
    return next;
}

/** Drop one axis regardless of its value — what a chip's ✕ does. */
export function removeFilter(filters, key) {
    if (!Object.hasOwn(filters, key)) return filters;
    const next = { ...filters };
    delete next[key];
    return next;
}

/**
 * The same filters without some axes. A panel that IS one axis (the outcome
 * pills, the day chart, a ranked list) counts over every OTHER filter, so it
 * keeps showing the alternatives while its own choice is highlighted.
 */
export function omitFilters(filters, keys) {
    let next = filters || {};
    for (const key of keys) next = removeFilter(next, key);
    return next;
}

export function isFiltered(filters) {
    return Object.keys(filters || {}).length > 0;
}

/**
 * Does one normalised row survive the active filters?
 *
 * `kinds` is a LIST on every row (a message can carry an e-mail address and a
 * name), so `kind` is a membership test and `pii` a non-empty test, while the
 * other axes are equality.
 */
const EQUAL_AXES = ['person', 'place', 'dest', 'region', 'outcome', 'day'];

export function matches(row, filters) {
    if (!filters) return true;
    if (filters.kind != null && !(row.kinds || []).includes(filters.kind)) return false;
    if (filters.pii != null && (row.found ?? row.kinds ?? []).length === 0) return false;
    for (const key of EQUAL_AXES) {
        if (filters[key] != null && row[key] !== filters[key]) return false;
    }
    return true;
}

export function applyFilters(rows, filters) {
    if (!isFiltered(filters)) return rows;
    return rows.filter(row => matches(row, filters));
}

/**
 * Count occurrences and sort by frequency, for the top-5 lists.
 *
 * `pick` may return a single value or an array (categories), so one row can
 * contribute to several entries. Ties break alphabetically rather than by
 * insertion order, so the same data always renders in the same order instead
 * of reshuffling when a filter changes.
 */
export function rank(rows, pick, limit = 5) {
    const counts = new Map();
    for (const row of rows || []) {
        const picked = pick(row);
        const values = Array.isArray(picked) ? picked : [picked];
        for (const value of values) {
            if (value == null || value === '') continue;
            counts.set(value, (counts.get(value) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])))
        .slice(0, limit)
        .map(([value, count]) => ({ value, count }));
}

/**
 * Which of `buckets` equal slices of a window a timestamp belongs to.
 *
 * Returns `null` for anything outside the window or unparseable, so a row with
 * a broken timestamp is excluded from the trend rather than silently piling
 * into the first bar.
 */
export function bucketIndexFor(timestamp, { start, end, buckets }) {
    if (!(buckets > 0)) return null;
    const t = new Date(timestamp).getTime();
    const from = new Date(start).getTime();
    const to = new Date(end).getTime();
    if (!Number.isFinite(t) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    if (t < from || t > to) return null;
    const idx = Math.floor(((t - from) / (to - from)) * buckets);
    // A timestamp exactly at `end` would land one past the last bar.
    return Math.min(idx, buckets - 1);
}

/**
 * Where the numbers on screen are allowed to come from.
 *
 * 'aggregate' — no filter is active, so the server's window-wide totals are
 *               both correct and cheaper than counting.
 * 'sample'    — a filter is active, so the only rows we can count are the ones
 *               we fetched. The UI MUST label this, and must say when the
 *               sample is capped: see `isCapped`.
 */
export function countMode(filters) {
    return isFiltered(filters) ? 'sample' : 'aggregate';
}

/**
 * Did the detail fetch hit its ceiling, so the sample is not the whole window?
 *
 * `total` is the server's aggregate count for the window; `fetched` is how many
 * rows came back. When they disagree, every recounted number is a floor, not a
 * total — and a filtered view that does not say so is a wrong number with a
 * confident label.
 */
export function isCapped({ fetched, total, limit }) {
    if (!Number.isFinite(total) || !Number.isFinite(fetched)) return false;
    return fetched < total || (Number.isFinite(limit) && fetched >= limit);
}
