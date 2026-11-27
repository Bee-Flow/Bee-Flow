// @typecheck strict
/**
 * Deleting an agent (stores/agent/agentCrud.js, core) sweeps the automation links that named it.
 * The table is this module's (migrations/automation-agent-bindings-2026-10.js), so the statement
 * lives here and the core asks for it by name (modules/firstParty/moduleData.js moduleForDataDuty).
 */

'use strict';

const { getOne, run } = require('../../db');
const log = require('../../telemetry/log');

/**
 * An agent that is gone can no longer be called by anything, so the grants that
 * named it (automation_agent_bindings, automation/agentBinding.js) go with it.
 * `agent_id` there is a soft reference, not a foreign key, so nothing cascades.
 * Best effort and probe-first: the table belongs to the automation store, which
 * may not have booted yet, and a failed sweep must never fail the delete (the
 * runtime ignores a binding whose agent is gone either way).
 * @param {string} agentId
 */
async function dropAgentBindings(agentId) {
    try {
        const probe = await getOne(`SELECT to_regclass('public.automation_agent_bindings') AS t`);
        if (!probe || !probe.t) return;
        await run('DELETE FROM automation_agent_bindings WHERE agent_id = $1', [agentId]);
    } catch (e) {
        log.warn(`[AgentCrud] could not drop the automation bindings of deleted agent ${agentId}: ${/** @type {Error} */ (e).message}`);
    }
}

module.exports = { dropAgentBindings };
