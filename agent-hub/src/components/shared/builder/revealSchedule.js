/**
 * The canvas-agnostic half of the build choreography: WHEN each card of a
 * burst is dealt, and in what ORDER — ids in, delays out. The routine canvas
 * (React Flow) and the App Studio editor (a DOM grid) both read it; what a
 * "card" is and how the camera moves is each canvas's own.
 */

/**
 * The cadence of a burst: one card every 1.2 s — the owner's number
 * (2026-09-11). The earlier 450 ms ceiling made a six-card `builder_add_steps`
 * batch a 2.4 s blur that was over before anyone had read the first card, and
 * the whole point of the film is that the audience reads each card as it
 * lands. 1.2 s is the per-card timeline (ribbon ring, flight, landing, name,
 * summary wipe — see index.css) plus a beat of rest before the next departure.
 */
export const REVEAL_STAGGER_MS = 1200;
/** Below this the cards read as a shuffle again; a thirty-card batch compresses to here and no further. */
export const REVEAL_STAGGER_MIN_MS = 500;
/** The ceiling on a whole burst: past thirteen cards the cadence tightens so the last one departs inside this. */
export const REVEAL_BUDGET_MS = 15000;

/** Two camera moves closer together than this read as a haunted canvas, not a film. */
export const MIN_MOVE_GAP_MS = 1200;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * Per-card DEPARTURE delays for one draft's arrivals. A lone card lands at
 * once; a burst is dealt one card at a time at REVEAL_STAGGER_MS, and only a
 * burst too long for the 15 s budget tightens the cadence — never below
 * REVEAL_STAGGER_MIN_MS. So: up to 13 cards at 1200 ms, 20 cards at 789 ms,
 * 31 or more at 500 ms. The delay is when the card's turn BEGINS (the ribbon
 * ring, the ghost's departure); the hook adds the flight time on top for the
 * card's own reveal.
 */
export function revealSchedule(addedIds, { stagger } = {}) {
    const ids = [];
    const seen = new Set();
    for (const id of Array.isArray(addedIds) ? addedIds : []) {
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    const n = ids.length;
    const step = Number.isFinite(stagger) && stagger >= 0
        ? stagger
        : (n <= 1 ? 0 : clamp(REVEAL_BUDGET_MS / (n - 1), REVEAL_STAGGER_MIN_MS, REVEAL_STAGGER_MS));
    const out = new Map();
    ids.forEach((id, index) => out.set(id, { index, delayMs: Math.round(index * step) }));
    return out;
}

/**
 * The order a burst is dealt in. `diffDefinitions` orders additions by
 * flowOrder, which is right for a chain but says nothing about a batch whose
 * steps land on several branches; the model's own `builder_add_steps` result
 * lists the entries in the order it wrote them, and that is the story it is
 * telling. So: ids the hint names (in the hint's order, when the diff really
 * added them), then whatever the hint did not name, in diff order. Nothing is
 * ever dropped — a card the hint forgets still reveals, just last.
 */
export function orderAdded(diffAdded, hintIds) {
    const added = Array.isArray(diffAdded) ? diffAdded : [];
    const inDiff = new Set(added.filter(id => id != null));
    const out = [];
    const seen = new Set();
    for (const id of Array.isArray(hintIds) ? hintIds : []) {
        if (id == null || !inDiff.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    for (const id of added) {
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

