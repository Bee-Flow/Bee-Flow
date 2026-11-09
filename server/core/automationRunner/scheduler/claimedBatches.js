// @typecheck strict
/**
 * Running the rows one scheduler tick claimed, a few at a time, without
 * losing track of the ones that wait (used by ./ticks.js for the primary and
 * the additional schedules).
 */

'use strict';

const automationStore = require('../../../stores/automationStore');
const { MAX_CONCURRENT } = require('../shared');
const { INSTANCE_ID } = require('../engine');
const log = require('../../../telemetry/log');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * Of the claimed rows still WAITING for their batch: refresh the running marker
 * of each, and drop the ones another instance took over.
 *
 * A claim stamps running_started_at once. Only a row that is actually running
 * has a heartbeat to keep that fresh; a row waiting behind earlier batches has
 * nothing, so once those batches outlast the reaper's stale window the reaper
 * resets it, another instance claims and runs it, and this instance would run
 * it too. touchAutomationRunning is scoped to this instance and returns false
 * for exactly such a row. An infra error (or a store build without the refresh)
 * keeps the row: dropping claimed work on a DB hiccup would be worse.
 * @template T
 * @param {T[]} waiting
 * @param {(item: T) => string} idOf
 * @returns {Promise<T[]>}
 */
async function stillClaimed(waiting, idOf) {
    if (typeof automationStore.touchAutomationRunning !== 'function') return waiting;
    const kept = [];
    for (const item of waiting) {
        let ours = true;
        try { ours = (await automationStore.touchAutomationRunning(idOf(item), INSTANCE_ID)) !== false; }
        catch (e) { bestEffort('core/automationRunner/scheduler/ticks:stillClaimed', e); }
        if (ours) kept.push(item);
        else log.warn(`[AutomationRunner] ${idOf(item)} lost its claim while waiting for a batch — not running it here`);
    }
    return kept;
}

/**
 * Run claimed rows MAX_CONCURRENT at a time. Before every batch after the
 * first, the rows still waiting are re-checked and kept alive (stillClaimed).
 * @template T
 * @param {T[]} claimed
 * @param {(item: T) => string} idOf
 * @param {(batch: T[]) => Promise<unknown>[]} startBatch
 */
async function runClaimedInBatches(claimed, idOf, startBatch) {
    let waiting = claimed;
    for (let first = true; waiting.length > 0; first = false) {
        if (!first) waiting = await stillClaimed(waiting, idOf);
        const batch = waiting.slice(0, MAX_CONCURRENT);
        waiting = waiting.slice(MAX_CONCURRENT);
        if (batch.length) await Promise.allSettled(startBatch(batch));
    }
}

module.exports = { runClaimedInBatches, stillClaimed };
