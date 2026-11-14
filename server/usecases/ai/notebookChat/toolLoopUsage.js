// @typecheck strict
/**
 * Notebook chat: the usage meter of one turn (usecases/ai/notebookChat/toolLoop.js).
 * Every round's usage (the adapter's `done` payload) is added up; one ledger
 * row per turn, source notebook_chat, is written when the loop is over
 * (core/llm/surfaceUsage.js).
 */

'use strict';

const { createUsageAccumulator } = require('../../../core/providers/usageNormalizer');
const { logSurfaceUsage } = require('../../../core/llm/surfaceUsage');

/**
 * @typedef {{
 *   userId: string,
 *   orgId: string | null,
 *   modelId: string,
 *   notebookId: string,
 * }} TurnAttribution
 */

/**
 * A meter for one notebook chat turn, started now.
 * @param {TurnAttribution} who
 * @returns {{ add: (usage: unknown) => void, finish: () => void }}
 */
function createTurnMeter({ userId, orgId, modelId, notebookId }) {
    const usageAcc = createUsageAccumulator();
    const startedAt = Date.now();
    return {
        add(usage) { usageAcc.add(usage); },
        finish() {
            logSurfaceUsage({
                source: 'notebook_chat', userId, orgId, model: modelId,
                usage: usageAcc.total(), startedAt, conversationId: notebookId,
            });
        },
    };
}

module.exports = { createTurnMeter };
