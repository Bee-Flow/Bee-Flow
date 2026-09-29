'use strict';
/**
 * A web search run by a chat that dispatches it itself (webpage chat, notebook
 * chat), with the same egress row every other tool call gets.
 *
 * Those two chats call executeAgentSearchTool directly rather than through the
 * tool dispatcher, so its chokepoint never saw them: the search provider got
 * the query and the ledger said nothing. The call runs in its own capture
 * context, the row is written whether it succeeded or threw, and the search's
 * own result or throw reaches the caller unchanged.
 */

function defaultDeps() {
    return {
        captureCall: require('../core/http/captureCall').captureCall,
        logToolEgress: require('../core/integrations/integrationLogging').logToolEgress,
        executeAgentSearchTool: require('./agentSearchTools').executeAgentSearchTool,
        now: Date.now,
    };
}

/**
 * @param {string} toolName
 * @param {object} toolArgs
 * @param {{ source: string, ids: object }} egress  row attribution
 * @param {object} [deps]  test seam
 */
async function runAgentSearchWithEgress(toolName, toolArgs, egress, deps = defaultDeps()) {
    const t0 = deps.now();
    const run = await deps.captureCall(() => deps.executeAgentSearchTool(toolName, toolArgs));
    deps.logToolEgress({
        toolName,
        toolArgs,
        result: run.ok ? run.value : null,
        error: run.ok ? null : run.error,
        probe: run.probe,
        source: egress.source,
        durationMs: deps.now() - t0,
        ids: egress.ids || {},
    });
    if (!run.ok) throw run.error;
    return run.value;
}

module.exports = { runAgentSearchWithEgress };
