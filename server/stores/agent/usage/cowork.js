// @typecheck strict
'use strict';

/**
 * The cowork module's part of "what breaks if I delete this agent?" (stores/agent/agentUsage.js
 * asks for it by name): the scheduled AI tasks and the Cowork schedules bound to an agent.
 */

/** @typedef {import('../agentUsage').AgentScan} AgentScan */

/** @type {Readonly<Record<string, AgentScan>>} */
const SCANS = Object.freeze({
    // A scheduled AI task bound to an agent. `aiTaskRunner` resolves it with
    // getForRuntime and throws "Linked agent no longer exists" when it is
    // gone — the exact breakage this guard exists to announce first.
    task: {
        table: 'ai_tasks',
        role: 'automation',
        sql: `SELECT t.agent_id AS agent_id, t.id AS id, t.title AS title,
                     t.user_id AS owner_id, COALESCE(t.last_run_at, t.created_at) AS last_at
                FROM ai_tasks t
               WHERE t.agent_id = ANY($1::text[])`,
    },
    // The same relationship on the Cowork side.
    cowork: {
        table: 'cowork_schedules',
        role: 'automation',
        sql: `SELECT c.agent_id AS agent_id, c.id AS id, c.title AS title,
                     c.user_id AS owner_id, COALESCE(c.last_run_at, c.created_at) AS last_at
                FROM cowork_schedules c
               WHERE c.agent_id = ANY($1::text[])`,
    },
});

module.exports = { SCANS };
