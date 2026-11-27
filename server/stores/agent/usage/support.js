// @typecheck strict
'use strict';

/**
 * The support module's part of "what breaks if I delete this agent?" (stores/agent/agentUsage.js
 * asks for it by name): the inboxes whose auto-responder drafts with the agent.
 */

/** @typedef {import('../agentUsage').AgentScan} AgentScan */

/** @type {Readonly<Record<string, AgentScan>>} */
const SCANS = Object.freeze({
    // The inbox's auto-responder drafts replies with this agent. `id` is a
    // UUID here, so it is cast — a client comparing ids across kinds must get
    // text from all of them.
    support: {
        table: 'support_inboxes',
        role: 'auto_reply',
        sql: `SELECT i.default_agent_id AS agent_id, i.id::text AS id, i.display_name AS title,
                     i.created_by AS owner_id, i.updated_at AS last_at
                FROM support_inboxes i
               WHERE i.default_agent_id = ANY($1::text[])`,
    },
});

module.exports = { SCANS };
