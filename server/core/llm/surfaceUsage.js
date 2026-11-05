// @typecheck strict
/**
 * One ledger row for a model call made outside the chat and agent runtimes:
 * a meeting summary, a chat title, the Nextcloud assistant, voice, dictation,
 * a notebook or template chat, the automation builder, a playbook phase, a
 * persona draft, a knowledge-base summary.
 *
 * These surfaces called the model and wrote nothing, so their spend was on no
 * dashboard and counted against no quota, and an organisation could not see
 * that the work happened at all. Each one now writes a row through the same
 * sink as every other call (usageStore.logUsage), with the person, their
 * organisation, a source from the shared vocabulary (shared/usageAreas.js),
 * the model and the tokens the provider reported. A provider that reports no
 * usage still gives a row: zero tokens and the model say "this happened".
 *
 * Built from an explicit field list (the allow-list form): nothing of the
 * prompt or the answer reaches the row. Fire-and-forget: bookkeeping never
 * fails the call it describes.
 */

'use strict';

const log = require('../../telemetry/log');
const { usageLogFields } = require('../providers/usageNormalizer');

/**
 * @typedef {{
 *   source: string,
 *   userId?: string | null,
 *   orgId?: string | null,
 *   model?: string | null,
 *   usage?: unknown,
 *   startedAt?: number | null,
 *   agentId?: string | null,
 *   agentName?: string | null,
 *   agentType?: string | null,
 *   conversationId?: string | null,
 * }} SurfaceCall
 */

/**
 * @param {unknown} v
 * @returns {string | null}
 */
const text = (v) => (typeof v === 'string' && v ? v : null);

/**
 * The ledger entry of one surface call.
 * @param {SurfaceCall} call
 */
function surfaceUsageEntry(call) {
    return {
        user_id: text(call.userId),
        organization_id: text(call.orgId),
        agent_id: text(call.agentId),
        agent_name: text(call.agentName),
        agent_type: text(call.agentType) || 'system',
        model: text(call.model),
        // Tokens, cache read/write and reasoning in the normalised shape; an
        // absent usage block is zero tokens, never a missing row.
        ...usageLogFields(call.usage ?? null),
        duration_ms: typeof call.startedAt === 'number' ? Math.max(0, Date.now() - call.startedAt) : null,
        source: call.source,
        conversation_id: text(call.conversationId),
    };
}

/**
 * Write the row; never throws, never rejects.
 * @param {SurfaceCall} call
 * @param {{ logUsage: (entry: object) => Promise<unknown> }} [store] test seam
 */
function logSurfaceUsage(call, store) {
    try {
        const sink = store || require('../../stores/usageStore');
        Promise.resolve(sink.logUsage(surfaceUsageEntry(call)))
            .catch((e) => log.warn(`[SurfaceUsage] could not record ${call.source} usage:`, /** @type {Error} */ (e)?.message));
    } catch (e) {
        log.warn(`[SurfaceUsage] could not record ${call.source} usage:`, /** @type {Error} */ (e)?.message);
    }
}

module.exports = { logSurfaceUsage, surfaceUsageEntry };
