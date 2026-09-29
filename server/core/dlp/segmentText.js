// @typecheck
/**
 * Content-defined segmentation for cacheable PII scans.
 *
 * WHY NOT FIXED-SIZE WINDOWS
 * `piiDetection.windowText` already cuts long text into 8000-char windows at
 * fixed offsets. That is fine for a one-shot scan and useless for a cache: an
 * edit near the top shifts every later boundary by the same delta, so every
 * downstream key changes and the whole document re-scans. A rolling hash makes
 * a boundary depend only on the ~48 bytes around it, so an edit re-synchronises
 * within one segment and the rest of the document keeps hitting.
 *
 * WHY THE SIZE CAP IS LOAD-BEARING
 * `detectPii` windows anything over MAX_REQUEST_CHARS and a windowed scan can
 * trip SCAN_DEADLINE_MS, which returns `degraded: true` — and degraded results
 * are (correctly) never cached. A segment that can never be windowed can never
 * be degraded for that reason, which is what makes a cache with no expiry safe.
 * So `scanText` (segment + its left overlap) is held at or below
 * MAX_REQUEST_CHARS.
 *
 * WHY THE LEFT OVERLAP
 * Same 256 chars `windowText` uses. Two jobs: an entity straddling a boundary
 * is seen whole by the next segment, and a change in the tail of the previous
 * segment changes this segment's scanned bytes, so the key invalidates rather
 * than serving a verdict computed against different context.
 */

const MIN_SEGMENT_CHARS = 2000;
const HASH_WINDOW = 48;
const HASH_BASE = 31;
// 31^HASH_WINDOW mod 2^32 — the weight of the byte falling out of the window.
const HASH_POW = (() => {
    let p = 1;
    for (let i = 0; i < HASH_WINDOW; i++) p = Math.imul(p, HASH_BASE) >>> 0;
    return p >>> 0;
})();
// Average segment ≈ 4 KB (mask of 12 bits). Comfortably under the cap once the
// overlap is added, and large enough that per-segment overhead stays marginal.
const BOUNDARY_MASK = (1 << 12) - 1;

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxChars]      hard ceiling for segment + overlap
 * @param {number} [opts.overlapChars]  left overlap included in the scanned string
 * @param {number} [opts.minChars]
 * @returns {Array<{start:number,end:number,scanStart:number,scanText:string}>}
 *   `start`/`end` bound the segment in `text`; `scanText` is what is hashed and
 *   sent to the detector. Entity offsets from a scan are relative to `scanText`
 *   and become absolute by adding `scanStart`.
 */
function segmentText(text, opts = {}) {
    const str = typeof text === 'string' ? text : '';
    const overlapChars = Number.isFinite(opts.overlapChars) ? opts.overlapChars : 256;
    const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 8000;
    const minChars = Number.isFinite(opts.minChars) ? opts.minChars : MIN_SEGMENT_CHARS;
    // The segment itself must leave room for the overlap that gets prepended.
    const maxSegment = Math.max(1, maxChars - overlapChars);
    if (!str) return [];
    if (str.length <= maxSegment) {
        return [{ start: 0, end: str.length, scanStart: 0, scanText: str }];
    }

    const out = [];
    let start = 0;
    while (start < str.length) {
        const hardEnd = Math.min(str.length, start + maxSegment);
        let end = hardEnd;
        if (hardEnd < str.length) {
            // Rolling polynomial hash over EXACTLY the trailing HASH_WINDOW
            // bytes. The removal term is what makes this shift-invariant: once
            // the window is full, `h` is a function of those bytes alone and
            // carries no memory of where the segment began. Getting that wrong
            // (e.g. XOR-ing the outgoing byte) leaves history in the state, the
            // boundary then depends on `start`, and a single insert at the top
            // cascades through every later key — which is the failure mode this
            // whole function exists to avoid.
            let h = 0;
            const from = start + Math.min(minChars, maxSegment);
            let cut = -1;
            for (let i = start; i < hardEnd; i++) {
                h = (Math.imul(h, HASH_BASE) + str.charCodeAt(i)) >>> 0;
                if (i - start >= HASH_WINDOW) {
                    h = (h - Math.imul(str.charCodeAt(i - HASH_WINDOW), HASH_POW)) >>> 0;
                }
                if (i >= from && (h & BOUNDARY_MASK) === 0) { cut = i + 1; break; }
            }
            if (cut > start) end = cut;
            else {
                // No anchor found before the ceiling — fall back to the last
                // paragraph/line/space break so we still cut somewhere sane.
                const tail = str.slice(start, hardEnd);
                const at = Math.max(tail.lastIndexOf('\n\n'), tail.lastIndexOf('\n'), tail.lastIndexOf(' '));
                end = at > minChars ? start + at + 1 : hardEnd;
            }
        }
        const scanStart = Math.max(0, start - overlapChars);
        out.push({ start, end, scanStart, scanText: str.slice(scanStart, end) });
        start = end;
    }
    return out;
}

module.exports = { segmentText, MIN_SEGMENT_CHARS };
