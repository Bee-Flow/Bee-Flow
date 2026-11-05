// @typecheck strict
/**
 * App Studio action-run bridge: the usage row of a signed-in action
 * (routes/studioAppsRun.js, source studio_app_action).
 *
 * Real work happens under the OWNER (a record write or an owner-scoped run)
 * whoever clicked, so the row is the owner's; the viewer who clicked is the
 * actor, and a click that started an automation run names that run.
 */

'use strict';

const usageStore = require('../stores/usageStore');
const { bestEffort } = require('../utils/bestEffort');

/**
 * The part of a studio app the row reads.
 * @typedef {{ id: string, userId: string, organizationId?: string | null, name?: string | null }} UsageApp
 */

/**
 * @typedef {{
 *   actorUserId: string | null,
 *   runId?: string | null,
 *   startedAt: number,
 *   source?: string,
 * }} ActionUsage
 */

/**
 * The zero-token usage row of one action. `run_id` is only on the row of a
 * click that started a run (`runId` given, null when the run never started).
 * `source` is studio_app_action unless given (the public surface's row,
 * routes/studioAppPublicParts.js).
 * @param {UsageApp} app
 * @param {ActionUsage} action
 */
function actionUsageRow(app, { actorUserId, runId, startedAt, source = 'studio_app_action' }) {
    return {
        user_id: app.userId,
        organization_id: app.organizationId || null,
        agent_id: app.id,
        agent_name: `App: ${app.name || 'Untitled app'}`,
        agent_type: 'studio_app',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        duration_ms: Date.now() - startedAt,
        source,
        conversation_id: app.id,
        actor_user_id: actorUserId,
        ...(runId === undefined ? {} : { run_id: runId }),
    };
}

/**
 * Write the usage row of one action (fire-and-forget: a failed write is
 * logged under `tag`, never thrown).
 * @param {UsageApp} app
 * @param {ActionUsage & { tag: string }} action
 * @returns {void}
 */
function logActionUsage(app, { tag, ...action }) {
    usageStore.logUsage(actionUsageRow(app, action))
        .catch((/** @type {unknown} */ e) => bestEffort(tag, e));
}

module.exports = { actionUsageRow, logActionUsage };
