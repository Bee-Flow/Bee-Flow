// @typecheck strict
/**
 * The "disappeared" half of a poll_diff tick (pollDiff.js runPollDiff): every
 * item of the previous cursor that this tick's list no longer holds becomes
 * one event, up to the per-tick cap.
 *
 * Over the cap an item goes back into the cursor with the state it had, so the
 * next tick still sees it as gone, instead of dropping the event.
 *
 * @param {{
 *   prevMap: Map<string, { chg12: string, vals?: Record<string, any> }>,
 *   seenIds: Set<string>,
 *   emitted: Array<Record<string, any>>,
 *   entries: Array<{ id12: string, chg12: string, vals?: Record<string, any> }>,
 *   maxPerTick: number,
 * }} tick  `emitted` and `entries` are appended to
 */
function emitDisappeared({ prevMap, seenIds, emitted, entries, maxPerTick }) {
    for (const [id12, before] of prevMap) {
        if (seenIds.has(id12)) continue;
        if (emitted.length >= maxPerTick) {
            entries.push({ id12, chg12: before.chg12, vals: before.vals });
            continue;
        }
        emitted.push({
            ...(before.vals || {}),
            changedKeys: [],
            changedAt: new Date().toISOString(),
            _reason: 'disappeared',
        });
    }
}

module.exports = { emitDisappeared };
