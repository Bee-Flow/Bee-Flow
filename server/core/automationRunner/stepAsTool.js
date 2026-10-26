// @typecheck noImplicitAny
/**
 * A published Reusable Step invoked as a chat tool (extracted verbatim from
 * automationRunner.js). Loads the block's published version, runs it through
 * executeAutomation under the 'agent_call' trigger and hands the agent back the
 * final step output.
 */

const { executeAutomation } = require('./execution');
const { fallback } = require('../../utils/bestEffort');

/**
 * @param {string} blockId
 * @param {unknown} args
 * @param {{ userId?: string, callerAgentId?: string | null, callerConversationId?: string | null, startedByUserId?: string | null } | null | undefined} ctx
 */
async function runStepAsTool(blockId, args, ctx, { mode = 'live' } = {}) {
    const automationStore = require('../../stores/automationStore');
    const row = await automationStore.getAutomation(blockId).catch((e) => fallback('core/automationRunner/stepAsTool:runStepAsTool', e, null));
    if (!row || row.kind !== 'block') throw new Error(`Step ${blockId} not found`);
    if (row.userId !== ctx?.userId) throw new Error('Forbidden: caller does not own the Step');
    if (row.publishedVersion == null) throw new Error('Step is not published — publish it before using it in chat.');
    if (!row.exposeAsTool) throw new Error('Step is not exposed as a chat tool.');
    const def = await automationStore.getVersionDefinition(blockId, row.publishedVersion).catch((e) => fallback('core/automationRunner/stepAsTool:runStepAsTool#2', e, null)) || row.definition;
    const synthetic = {
        id: row.id,
        userId: row.userId,
        organizationId: row.organizationId || null,
        title: row.title,
        version: row.publishedVersion,
        definition: def,
        kind: 'block',
    };
    const result = await executeAutomation(synthetic, {
        triggerKind: 'agent_call',
        triggerPayload: args && typeof args === 'object' ? args : {},
        mode,
        // Handoff 5: who started it (agentCallableTools.runnerTraceOptions).
        callerAgentId: ctx?.callerAgentId || null,
        callerConversationId: ctx?.callerConversationId || null,
        // The Step is the caller's own (checked above), so the caller is the starter.
        startedByUserId: ctx?.startedByUserId || ctx?.userId || null,
    });
    return result?.lastOutput ?? null;
}

module.exports = { runStepAsTool };
