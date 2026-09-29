import scopedStorage from '../../../utils/scopedStorage';

/**
 * A learned guess at how long THIS model keeps the builder waiting before its
 * first token — purely client-side, per user, per model.
 *
 * A local 27B model reads a ~28k-token prompt at ~150 tok/s: three minutes of
 * silence before anything streams. Nothing on the wire says how long that will
 * take, and the server cannot know either (it depends on the box the runtime
 * is on). What we CAN know is how long it took last time, on this browser,
 * against this model — so every finished silence is filed here and the median
 * of the last few becomes the next wait's "usually about 3m 20s".
 *
 * Median, not mean: the first cold turn (model weights not yet paged in) is
 * routinely 3× the rest, and a mean would keep announcing that outlier for
 * five turns. Five samples: enough to shrug off one cold start, few enough
 * that a runtime upgrade shows up in the estimate within an afternoon.
 *
 * The cap on `fraction` (0.96) keeps the bar from ever reaching the end: a
 * full bar reads as "done", and the one thing this bar must never do is claim
 * an arrival it has no evidence for. Past 1.25× the median the wait is
 * flagged `over`, and the copy switches from an estimate to an admission.
 */

export const HISTORY_SIZE = 5;
export const OVER_FACTOR = 1.25;
export const FRACTION_CAP = 0.96;

const storageKey = (modelKey) => `builderTtft:${modelKey}`;

/**
 * Where a turn's measurement is filed. The server names the model on
 * `model_selected` / `round_start`; until then (and on a server that never
 * does) the requested tier stands in, so a fresh turn shows the history of
 * the same bucket it will later be filed under.
 */
export function modelKeyFor(turn, selectedTier) {
    return turn?.modelId || `tier:${turn?.tier || selectedTier || 'fast'}`;
}

/** The stored samples, oldest first. Anything that is not a positive duration is dropped. */
export function readHistory(modelKey) {
    const raw = scopedStorage.getJSON(storageKey(modelKey), []);
    return Array.isArray(raw) ? raw.filter((n) => Number.isFinite(n) && n > 0) : [];
}

/**
 * File one finished silence. Returns the history AS STORED — read back after
 * the write rather than assumed, because scopedStorage silently drops writes
 * while no user is registered, and a caller holding a list the store does
 * not have would show an estimate the next page load cannot reproduce.
 */
export function recordTtft(modelKey, ms) {
    const prior = readHistory(modelKey);
    if (!Number.isFinite(ms) || ms <= 0) return prior;
    scopedStorage.setJSON(storageKey(modelKey), [...prior, Math.round(ms)].slice(-HISTORY_SIZE));
    return readHistory(modelKey);
}

/** Median of the finite entries; null when there are none. */
export function medianOf(list) {
    const nums = (Array.isArray(list) ? list : []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * What the waiting card may honestly claim right now.
 *   { mode: 'indeterminate' }                      — no history: shimmer only
 *   { mode: 'determinate', fraction, over, medianMs } — a bar that fills towards
 *     (never to) the median, and `over` once the wait has outrun it
 */
export function expectation({ medianMs, elapsedMs }) {
    if (!Number.isFinite(medianMs) || medianMs <= 0) return { mode: 'indeterminate' };
    const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    return {
        mode: 'determinate',
        fraction: Math.min(FRACTION_CAP, elapsed / medianMs),
        over: elapsed > OVER_FACTOR * medianMs,
        medianMs,
    };
}
