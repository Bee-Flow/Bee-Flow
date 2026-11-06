// @typecheck strict
/**
 * AI Task Runner — the usage ledger of a plain-prompt Cowork run
 * (aiTaskRunner.js): the run id the ledger row names, and the one row per run
 * that accounts for its spend.
 */

'use strict';

const log = require('../telemetry/log');
const { usageLogFields } = require('./providers/usageNormalizer');

/** `source` and `agent_type` of the usage and termination rows a run writes. */
const SOURCE = 'cowork';

/** @typedef {{ id: string, userId: string, title?: string, agentId?: string | null }} UsageTask */

/**
 * The run state the usage row reads (and `usageLogged`, which it writes).
 * @typedef {{
 *   usageLogged: boolean,
 *   lastIter: number,
 *   modelId: string | null,
 *   runId?: string | null,
 *   userOrgForTier: string | null,
 *   usageAcc: { total(): ReturnType<typeof usageLogFields> },
 * }} UsageRun
 */

/**
 * The id of the history row markRunning opened: a string id, or a row with
 * one; null when the store returns nothing (an older store, a test fake).
 * @param {unknown} opened
 * @returns {string | null}
 */
function historyRunId(opened) {
    if (typeof opened === 'string' && opened) return opened;
    if (opened && typeof opened === 'object' && typeof (/** @type {{ id?: unknown }} */ (opened)).id === 'string') {
        return /** @type {{ id: string }} */ (opened).id;
    }
    return null;
}

/**
 * Log this run's spend through the SAME sink as interactive chats
 * (usageStore.logUsage → ai_usage_log; it derives cost, FX and PAYG itself),
 * so scheduled work shows up on the org dashboard and counts against quota
 * instead of running for free. Attribution is an explicit field list — the
 * allow-list form — under the owner and the effective org the tier was
 * already resolved with. SOURCE ('cowork') is both source and agent_type,
 * matching the notification and the termination log.
 *
 * Fire-and-forget with a warn (the terminationStore pattern): usage logging
 * is bookkeeping, not a gatekeeper — a failing log must never fail the run.
 * Logs once per run, and not at all before the first model call.
 * @param {UsageTask} task
 * @param {UsageRun} run
 * @param {number} startTime
 */
function logRunUsage(task, run, startTime) {
    if (run.usageLogged || run.lastIter === 0) return; // nothing spent before the first model call
    run.usageLogged = true;
    const warn = (/** @type {unknown} */ err) => log.warn(
        `[AITaskRunner] Usage log failed for cowork ${task.id} (run unaffected): ${/** @type {Error} */ (err).message}`);
    try {
        require('../stores/usageStore').logUsage({
            user_id: task.userId || null,
            agent_id: task.agentId || null,
            agent_name: task.title || null,
            agent_type: SOURCE,
            model: run.modelId,
            source: SOURCE,
            conversation_id: task.id || null,
            run_id: run.runId || null,
            ...usageLogFields(run.usageAcc.total()),
            duration_ms: Date.now() - startTime,
            organization_id: run.userOrgForTier || null,
        }).catch(warn);
    } catch (err) {
        warn(err);
    }
}

module.exports = { SOURCE, historyRunId, logRunUsage };
