// @typecheck
/**
 * Which versions of ONE item may be thinned out.
 *
 * Notebooks and documents keep a version per checkpoint (an idle pause, a
 * stretch of continuous editing, an AI write, a restore). Kept forever that is
 * thousands of rows per busy item, most of them a few words apart. The policy
 * keeps the recent past in full and the older past at a coarser grain:
 *
 *   younger than 48 hours       every version
 *   48 hours to 14 days         one per hour
 *   14 days to 90 days          one per day
 *   older than 90 days          one per week
 *
 * and then at most MAX_PER_ITEM versions that are free to go.
 *
 * Inside a bucket the NEWEST version is the one kept: it is the state the item
 * had when that hour (day, week) ended, which is what somebody browsing the
 * history at that grain expects to see.
 *
 * A HIDDEN version (`hidden: true`: a row the history list does not show, such
 * as an autosave revision folded into the later save of the same session)
 * never holds a bucket: the version a bucket keeps must be one the list shows,
 * or thinning would delete the only listed state of that hour and keep an
 * invisible one in its place. Past the keep-all window a hidden version is
 * free to go (the listed version of its session carries the same moment on);
 * inside it, it stays like everything else.
 *
 * Never pruned, whatever their age:
 *   - a version with a name, or pinned;
 *   - the first version (`created`) and both halves of a restore
 *     (`restore`, `pre_restore`), so "what did it look like before I
 *     restored" always has an answer;
 *   - any id the caller names as referenced (an automation that pins a
 *     document version, a section that quotes one, the current head);
 *   - the newest version of the item.
 *
 * Pure: the caller reads the rows, calls this, and deletes what it returns.
 * The rows are those of one item; mixing items would thin one by another.
 */

'use strict';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Everything younger than this is kept. */
const KEEP_ALL_MS = 48 * HOUR_MS;
/** Up to this age, one version per hour. */
const HOURLY_UNTIL_MS = 14 * DAY_MS;
/** Up to this age, one per day; older, one per week. */
const DAILY_UNTIL_MS = 90 * DAY_MS;
/** Versions that are free to go, kept at most per item after thinning. */
const MAX_PER_ITEM = 1000;

/** Sources that record something a person must always be able to go back to. */
const PROTECTED_SOURCES = new Set(['named', 'created', 'restore', 'pre_restore']);

/**
 * @typedef {object} VersionRow
 * @property {string} id
 * @property {string|number|Date} createdAt
 * @property {string} [source]
 * @property {string|null} [name]
 * @property {boolean} [pinned]
 * @property {boolean} [referenced]   the caller knows something points at it
 * @property {boolean} [hidden]       not shown in the history list (folded into a later version)
 */

/** Milliseconds since the epoch, or NaN for a value that is not a time. */
function timeOf(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value) return Date.parse(value);
    return NaN;
}

/**
 * The bucket a version of this age falls in, or null when it is kept anyway
 * (young enough to keep every version). Buckets are UTC-aligned, so the same
 * version lands in the same bucket on every run and thinning is stable.
 */
function bucketOf(createdMs, nowMs) {
    const age = nowMs - createdMs;
    if (age < KEEP_ALL_MS) return null;
    if (age < HOURLY_UNTIL_MS) return `h:${Math.floor(createdMs / HOUR_MS)}`;
    if (age < DAILY_UNTIL_MS) return `d:${Math.floor(createdMs / DAY_MS)}`;
    // Weeks start on Monday: 1970-01-01 was a Thursday, three days later.
    return `w:${Math.floor((createdMs / DAY_MS + 3) / 7)}`;
}

/** @param {VersionRow} row @param {Set<string>} referenced */
function isProtected(row, referenced) {
    if (!row || typeof row.id !== 'string') return true;
    if (referenced.has(row.id) || row.referenced === true) return true;
    if (row.pinned === true) return true;
    if (typeof row.name === 'string' && row.name.trim()) return true;
    return PROTECTED_SOURCES.has(String(row.source || ''));
}

/**
 * The ids of the versions that may be deleted.
 *
 * @param {VersionRow[]} rows       every version of ONE item, any order
 * @param {Date|number|string} [now]
 * @param {{ referencedIds?: Iterable<string>, maxPerItem?: number }} [opts]
 * @returns {string[]}  oldest first
 */
function selectPrunable(rows, now = Date.now(), opts = {}) {
    const nowMs = timeOf(now);
    if (!Array.isArray(rows) || rows.length < 2 || !Number.isFinite(nowMs)) return [];
    const referenced = new Set(opts.referencedIds || []);
    const cap = Number.isInteger(opts.maxPerItem) && opts.maxPerItem > 0 ? opts.maxPerItem : MAX_PER_ITEM;

    // Newest first; a row without a readable time is never touched (it would
    // otherwise sort to one end and look like the oldest thing there is).
    const dated = rows
        .map((row) => ({ row, at: timeOf(row && row.createdAt) }))
        .filter((r) => Number.isFinite(r.at))
        .sort((a, b) => b.at - a.at || String(b.row.id).localeCompare(String(a.row.id)));
    if (dated.length < 2) return [];

    const newestId = dated[0].row.id;
    const seenBuckets = new Set();
    const prunable = [];
    const keptFree = [];
    for (const { row, at } of dated) {
        if (row.id === newestId || isProtected(row, referenced)) continue;
        const bucket = bucketOf(at, nowMs);
        if (row.hidden === true) {
            if (bucket !== null) prunable.push(row.id);
            continue;
        }
        if (bucket === null || !seenBuckets.has(bucket)) {
            if (bucket !== null) seenBuckets.add(bucket);
            keptFree.push(row.id);
            continue;
        }
        prunable.push(row.id);
    }
    // The cap applies to what thinning left of the unprotected listed
    // versions; the oldest of those go first (keptFree is newest first).
    if (keptFree.length > cap) prunable.push(...keptFree.slice(cap));

    const order = new Map(dated.map((d, i) => [d.row.id, i]));
    return prunable.sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0));
}

module.exports = {
    selectPrunable,
    PROTECTED_SOURCES,
    MAX_PER_ITEM,
    KEEP_ALL_MS,
    HOURLY_UNTIL_MS,
    DAILY_UNTIL_MS,
};
