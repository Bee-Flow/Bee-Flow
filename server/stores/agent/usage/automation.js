// @typecheck strict
'use strict';

/**
 * The automation module's part of "what breaks if I delete this agent?"
 * (stores/agent/agentUsage.js asks for it by name): the automations whose AI steps name it.
 */

/** @typedef {import('../agentUsage').AgentScan} AgentScan */

/** @type {Readonly<Record<string, AgentScan>>} */
const SCANS = Object.freeze({
    // R2's ai_step. The id sits at an unknown depth inside a definition that
    // also encodes a canvas, so the recursive accessor is the only form that
    // finds it wherever the editor put it. DISTINCT because an automation that
    // names the same agent in two steps is ONE automation that breaks.
    automation: {
        table: 'automations',
        role: 'ai_step',
        sql: `SELECT DISTINCT v.val #>> '{}' AS agent_id, a.id AS id, a.title AS title,
                     a.user_id AS owner_id, a.updated_at AS last_at
                FROM automations a,
                     LATERAL jsonb_path_query(COALESCE(a.definition_json, '{}'::jsonb), '$.**.agentId') AS v(val)
               WHERE jsonb_typeof(v.val) = 'string'
                 AND (v.val #>> '{}') = ANY($1::text[])`,
    },
});

module.exports = { SCANS };
