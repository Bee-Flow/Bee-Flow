// @typecheck
/**
 * Windowed scanning — cutting oversized text into overlapping windows,
 * memoising each window so a retry makes progress, and folding the parts back
 * into one result shaped exactly like a single scan.
 */

const { resolveSpanOverlaps } = require('../../dlp/spanOverlap');
const { MAX_REQUEST_CHARS, WINDOW_OVERLAP_CHARS, MAX_WINDOWS } = require('./requestShaping');
const { cacheKey, cacheGet, cacheSet, _cloneScanResult } = require('./scanCache');
const { detectPiiViaCpuModel } = require('./guardClient');
const log = require('../../../telemetry/log');

/**
 * Split *text* into overlapping [start, chunk] windows.
 *
 * The overlap is what keeps an entity that straddles a boundary detectable;
 * duplicates it produces are removed by absolute offset in mergeWindowResults.
 */
function windowText(text) {
    const windows = [];
    let start = 0;
    while (start < text.length && windows.length < MAX_WINDOWS) {
        const end = Math.min(start + MAX_REQUEST_CHARS, text.length);
        windows.push([start, text.slice(start, end)]);
        if (end >= text.length) break;
        start = end - WINDOW_OVERLAP_CHARS;
    }
    return windows;
}

/**
 * How many windows *text* will be scanned as — i.e. how many guard round trips
 * this scan costs, and therefore how long a caller should expect to wait.
 *
 * Exported because the chat runtimes render this to the user ("part 2/6") and
 * used to reimplement the arithmetic inline; two copies of a formula that
 * depends on MAX_REQUEST_CHARS *and* WINDOW_OVERLAP_CHARS is one copy too many.
 */
function windowCountFor(text) {
    return windowText(typeof text === 'string' ? text : '').length || 1;
}

/**
 * Fold per-window results into one result shaped exactly like a single scan.
 */
function mergeWindowResults(text, parts, coveredChars) {
    const seen = new Set();
    const collected = [];
    for (const { start, result } of parts) {
        for (const e of result.entities || []) {
            const offset = e.offset + start;
            const dedupeKey = `${offset}:${e.length}:${e.category}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            collected.push({ ...e, offset });
        }
    }
    // The exact-triple dedupe above is necessary but NOT sufficient: windows
    // overlap by WINDOW_OVERLAP_CHARS, so an entity the boundary clipped in one
    // window and left whole in the next has the SAME offset and a DIFFERENT
    // length. Two distinct keys, two overlapping spans, and the tokenizer then
    // splices one into the middle of the other. Collapse them to the union
    // instead — same rule the guard applies inside a single window.
    const entities = resolveSpanOverlaps(collected, text);
    entities.sort((a, b) => a.offset - b.offset);

    // The guard's answers for "Your own data" types, when the windows were
    // scanned with custom labels. Folded the same way, kept apart for the
    // final merge in customTypes/scan.js; absent otherwise, so a scan without
    // them merges to exactly the shape it always did.
    let customEntities = null;
    if (parts.some(p => Array.isArray(p.result.customEntities))) {
        const seenCustom = new Set();
        const collectedCustom = [];
        for (const { start, result } of parts) {
            for (const e of result.customEntities || []) {
                const offset = e.offset + start;
                const k = `${offset}:${e.length}:${e.category}`;
                if (seenCustom.has(k)) continue;
                seenCustom.add(k);
                collectedCustom.push({ ...e, offset });
            }
        }
        customEntities = resolveSpanOverlaps(collectedCustom, text, { collectAlso: true });
        customEntities.sort((a, b) => a.offset - b.offset);
    }

    let degraded = false;
    let degradedReason = null;
    let anyUnknownScope = false;
    const degradedCategories = new Set();
    let tierMode = null;
    let engineFingerprint = null;
    for (const { result } of parts) {
        tierMode = tierMode || result.tierMode || null;
        // Windows of one scan all hit the same pod class; take the first and
        // refuse to memoise if any window disagrees (a rolling upgrade).
        if (engineFingerprint === null) engineFingerprint = result.engineFingerprint || null;
        else if (result.engineFingerprint && result.engineFingerprint !== engineFingerprint) engineFingerprint = false;
        if (!result.degraded) continue;
        degraded = true;
        degradedReason = degradedReason || result.degradedReason || null;
        if (result.degradedCategories) {
            result.degradedCategories.forEach(c => degradedCategories.add(c));
        } else {
            // A window that cannot say WHICH categories it lost means "assume
            // all". One such window poisons the merged scope — narrowing it to
            // the categories the other windows named would claim coverage we
            // do not have.
            anyUnknownScope = true;
        }
    }

    const partial = coveredChars < text.length;
    if (partial) {
        degraded = true;
        degradedReason = degradedReason || 'input_too_large_partial';
        anyUnknownScope = true;   // the unscanned tail can hide anything
    }

    const merged = {
        hasPii: entities.length > 0,
        entities,
        redactedText: text,
        degraded,
        degradedReason,
        degradedCategories: (anyUnknownScope || degradedCategories.size === 0)
            ? null
            : [...degradedCategories],
        processedChars: partial ? coveredChars : null,
        totalChars: partial ? text.length : null,
        tierMode,
        engineFingerprint: engineFingerprint || null,
    };
    if (customEntities) merged.customEntities = customEntities;
    return merged;
}

// Whole-scan wall clock. Before this bound, "slow" could never error: 40
// windows x 90s each is a theoretical hour of user-blocking latency in which
// nothing fails and nothing finishes. On expiry the scan STOPS and reports the
// covered prefix through the existing partial-result contract
// (input_too_large_partial -> the actionable "too large" copy -> the caller's
// fail-open/closed policy) — zero new degradation semantics.
//
// THE BUDGET SCALES WITH THE WORK — and that is the whole point.
//
// It used to be one flat number for every scan, which made it a SIZE limit
// wearing a clock's clothes. Detection costs roughly 4ms/char on a 3-core
// guard, so one 8000-char window is ~33s and a flat 60s could never finish
// more than two of them. A 41k-char paste (6 windows) therefore died at the
// same place every single time — 31k chars in — and the user was told the
// message was "too large to scan", which was true only because the allowance
// refused to grow with it. Pasting the same text as six separate messages
// worked fine, which is the tell: the work was affordable, the accounting
// was not.
//
// So the allowance is now per window, and the flat number becomes the ceiling
// that bounds the worst case: min(windows x WINDOW_BUDGET_MS, SCAN_DEADLINE_MS).
//   - a one-window scan is bounded at 60s, exactly as before;
//   - that six-window paste gets six windows' worth of time and completes;
//   - a 300k-char dump still hits the ceiling and still fails closed with the
//     "split it into smaller parts" copy, because past some size that IS the
//     honest answer.
const WINDOW_BUDGET_MS = Math.max(1000, Number(process.env.PII_GUARD_WINDOW_BUDGET_MS || 60_000));
const SCAN_DEADLINE_MS = Math.max(5000, Number(process.env.PII_GUARD_SCAN_DEADLINE_MS || 300_000));

/** Wall clock a scan is allowed, given how many windows it has to cover. */
function scanBudgetMs(windowCount) {
    return Math.min(Math.max(1, windowCount) * WINDOW_BUDGET_MS, SCAN_DEADLINE_MS);
}
// Windows of ONE scan sent concurrently. Default 1 (sequential): two windows
// of one paste would consume both of this pod's MAX_INFLIGHT slots — exactly
// the pre-incident fan-out shape. An operator raises it only after the guard
// admits >1 concurrent scan (GUARD_PII_MAX_CONCURRENCY >= 2).
const WINDOW_CONCURRENCY = Math.max(1, Number(process.env.PII_GUARD_WINDOW_CONCURRENCY || 1));

/**
 * Scan text larger than one request's budget as a bounded sequence of windows.
 *
 * Near-sequential on purpose (WINDOW_CONCURRENCY defaults to 1). Unbounded
 * parallel windows would multiply one user's paste into N simultaneous calls
 * against a guard that serialises inference — the exact fan-out that made bulk
 * pastes the trigger in the first place.
 *
 * A window that throws aborts the whole scan rather than being skipped: if the
 * guard is failing, grinding through 37 more windows adds load and still cannot
 * produce a trustworthy answer.
 */
/**
 * @param {{ labels: Array<object>, key: string } | null} [custom]  the "Your
 *   own data" types recognised by the model: sent with every window, and part
 *   of each window's memo key.
 */
async function detectPiiWindowed(text, enabledCategories, confidenceThreshold, endpoint, priority = 'interactive', onProgress = null, custom = null) {
    const windows = windowText(text);
    const parts = [];
    let coveredChars = 0;
    const budgetMs = scanBudgetMs(windows.length);
    const deadline = Date.now() + budgetMs;
    let deadlineHit = false;
    let done = 0;
    let reused = 0;

    let next = 0;
    let aborted = false;
    const worker = async () => {
        while (next < windows.length && !aborted) {
            if (Date.now() >= deadline) { deadlineHit = true; return; }
            const [start, chunk] = windows[next];
            next += 1;
            const { result, memoised } = await scanWindow(chunk, enabledCategories, confidenceThreshold, endpoint, priority, custom);
            if (memoised) reused += 1;
            parts.push({ start, result });
            coveredChars = Math.max(coveredChars, start + (
                // Respect a window that was itself only partially scanned.
                typeof result.processedChars === 'number' ? result.processedChars : chunk.length
            ));
            done += 1;
            if (typeof onProgress === 'function') {
                // Never let a caller's progress handler take the scan down with
                // it: this is a status line, the scan is a privacy control.
                try {
                    onProgress({ done, total: windows.length, coveredChars, totalChars: text.length, memoised });
                } catch (_) { /* ignore */ }
            }
        }
    };
    // allSettled + rethrow: with concurrency > 1, a plain Promise.all would
    // reject while the sibling worker keeps running — its own later failure
    // would then be an unhandled rejection. `aborted` also stops the sibling
    // from grinding through more windows against a failing guard.
    const settled = await Promise.allSettled(
        Array.from({ length: Math.min(WINDOW_CONCURRENCY, windows.length) }, () =>
            worker().catch((err) => { aborted = true; throw err; })),
    );
    const failure = settled.find(s => s.status === 'rejected');
    if (failure) throw failure.reason;

    if (deadlineHit) {
        log.warn(`[PiiDetection] scan deadline (${budgetMs}ms for ${windows.length} window(s)) hit after ${coveredChars}/${text.length} chars — returning partial fail-closed result. Raise PII_GUARD_SCAN_DEADLINE_MS if this text should be scannable in one message.`);
    }
    log.info(`[PiiDetection] windowed scan: ${text.length} chars → ${windows.length} window(s) (${reused} memoised), covered ${coveredChars}, budget ${budgetMs}ms`);
    // coveredChars only counts contiguous-from-zero coverage when windows
    // complete in order; with concurrency > 1 a later window can finish first,
    // so recompute the contiguous prefix from the parts actually scanned.
    return mergeWindowResults(text, parts, _contiguousCoverage(parts, coveredChars));
}

/**
 * The contiguous scanned prefix [0, n) given completed window parts.
 *
 * mergeWindowResults' partial-result contract promises "everything before
 * processedChars was scanned". With concurrent windows, window 3 finishing
 * while window 2 timed out must NOT claim window 3's end as covered — the gap
 * at window 2 would silently pass unscanned text as clean.
 */
function _contiguousCoverage(parts, fallback) {
    if (!parts.length) return 0;
    const sorted = [...parts].sort((a, b) => a.start - b.start);
    let covered = 0;
    for (const { start, result } of sorted) {
        if (start > covered) break;   // gap — an unscanned window sits before this one
        const len = typeof result.processedChars === 'number'
            ? result.processedChars
            : (result.redactedText || '').length;
        covered = Math.max(covered, start + len);
    }
    return Math.min(covered, fallback);
}

/**
 * One window's verdict, memoised — so a scan makes progress ACROSS attempts.
 *
 * Windows are cut at fixed offsets, so the same text always yields the same
 * windows. That matters because a scan that runs out of budget is degraded,
 * and a degraded result is (correctly) never cached at the whole-text level:
 * without this, retrying a paste that died at window 4 of 6 re-scanned windows
 * 1-4 from scratch, ran out of budget in exactly the same place, and failed
 * identically forever. With it the finished windows come back for free and the
 * retry spends its whole budget on the tail.
 *
 * Only complete, non-degraded window results are stored — same rule as every
 * other cache write in this file, for the same reason (piiDetection.js:1419).
 * Deliberately NOT detectPii(): that swallows transport failures into a
 * degraded result, and detectPiiWindowed relies on a throw to abort the
 * remaining windows rather than grinding through them against a dead guard.
 */
async function scanWindow(chunk, enabledCategories, confidenceThreshold, endpoint, priority, custom = null) {
    const key = cacheKey('window', chunk, enabledCategories, confidenceThreshold, custom?.key || null);
    const hit = cacheGet(key);
    if (hit) return { result: _cloneScanResult(hit), memoised: true };
    const result = await detectPiiViaCpuModel(chunk, enabledCategories, confidenceThreshold, endpoint, priority, custom?.labels || null);
    if (!result.degraded) cacheSet(key, result);
    return { result, memoised: false };
}

module.exports = {
    windowText,
    windowCountFor,
    mergeWindowResults,
    scanBudgetMs,
    detectPiiWindowed,
    scanWindow,
    _contiguousCoverage,
};
