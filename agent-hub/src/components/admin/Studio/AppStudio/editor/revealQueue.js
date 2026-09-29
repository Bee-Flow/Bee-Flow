/**
 * WHEN each thing an AI draft added should appear on the App Studio canvas —
 * the pure half of the film. A draft lands several components at once; the
 * routine builder deals its cards ~1.2 s apart (shared/builder/revealSchedule)
 * and this does the same for cells: ids in render order (draftDiff already
 * walks screens → sections → children), re-ordered by the server's own
 * `added` list when the tool_call carried one (the story the model told),
 * with a delay per id.
 *
 * Screens are listed separately: a new screen is a chapter break (its tab
 * pill rings), not a card in the grid.
 *
 * Under reduced motion the plan still names the ids (the cells must appear)
 * but carries no delays and `animate:false` — the caller then dispatches with
 * no delays so nothing waits.
 */

import { orderAdded, revealSchedule } from '../../../../shared/builder/revealSchedule';

export function planReveal({ diff, definition, hintIds = [], reducedMotion = false } = {}) {
    const added = diff && diff.addedIds instanceof Set ? [...diff.addedIds] : [];
    if (!added.length) return { ids: [], screens: [], delays: new Map(), animate: false };
    const screenIds = new Set((definition && Array.isArray(definition.screens) ? definition.screens : []).map((s) => s && s.id).filter(Boolean));
    const screens = added.filter((id) => screenIds.has(id));
    const cells = orderAdded(added.filter((id) => !screenIds.has(id)), Array.isArray(hintIds) ? hintIds : []);
    if (reducedMotion) return { ids: cells, screens, delays: new Map(), animate: false };
    const schedule = revealSchedule(cells);
    const delays = new Map();
    for (const [id, { delayMs }] of schedule) delays.set(id, delayMs);
    return { ids: cells, screens, delays, animate: true };
}

/** Milliseconds until the LAST card of a plan has appeared (its delay + the 1.2 s pulse). */
export function revealEndsAfterMs(plan, pulseMs = 1200) {
    if (!plan || !(plan.delays instanceof Map) || !plan.ids.length) return 0;
    let max = 0;
    for (const id of plan.ids) max = Math.max(max, plan.delays.get(id) || 0);
    return max + pulseMs;
}
