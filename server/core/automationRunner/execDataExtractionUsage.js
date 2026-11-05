// @typecheck strict
'use strict';
/**
 * The usage row of a data_extraction step (execDataExtraction.js): the same
 * ledger row an ai_step writes (aiStepMessages.logAiStepUsage), source
 * 'automation', from the usage of the one extraction call.
 */

const usageStore = require('../../stores/usageStore');
const { usageLogFields } = require('../providers/usageNormalizer');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

/**
 * The run context fields the row reads.
 * @typedef {{ userId?: string, orgId?: string, automationId?: string, automationTitle?: string, actorUserId?: string | null, runId?: string | null }} ExtractionUsageCtx
 */

/**
 * Record the spend of an extraction call. Bookkeeping only: never throws.
 * @param {ExtractionUsageCtx} ctx
 * @param {string} modelId
 * @param {unknown} usage   the adapter's usage of the call (normalised, cache read/write included)
 */
function logExtractionUsage(ctx, modelId, usage) {
    try {
        usageStore.logUsage({
            user_id: ctx.userId, organization_id: ctx.orgId || null,
            agent_id: ctx.automationId, agent_name: ctx.automationTitle || null,
            agent_type: 'automation', model: modelId, source: 'automation',
            conversation_id: ctx.automationId,
            actor_user_id: ctx.actorUserId ?? null, run_id: ctx.runId ?? null,
            // Normalised by the adapter (cache read/write included).
            ...usageLogFields(usage),
        }).catch((/** @type {unknown} */ e) => bestEffort('core/automationRunner/execDataExtraction:execDataExtraction', e));
    } catch (_) { log.warn('could not record AI usage of the extraction step', _); }
}

module.exports = { logExtractionUsage };
