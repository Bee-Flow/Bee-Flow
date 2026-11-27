// @typecheck strict
'use strict';

/**
 * The webpages module's part of "what breaks if I delete this agent?"
 * (stores/agent/agentUsage.js asks for it by name): the pages whose bridge grants name it.
 */

/** @typedef {import('../agentUsage').AgentScan} AgentScan */

/** @type {Readonly<Record<string, AgentScan>>} */
const SCANS = Object.freeze({
    // W3's `bridge_grants.agent`. The exact shape is W3's to choose, so all
    // three plausible ones are covered: a nested `agentId` key at any depth
    // (which is how `automations` and `integrations` already record their
    // grants), and a bare string at `bridge_grants.agent`.
    webpage: {
        table: 'webpages',
        role: 'bridge',
        sql: `SELECT DISTINCT agent_id, id, title, owner_id, last_at FROM (
                  SELECT v.val #>> '{}' AS agent_id, w.id AS id, w.name AS title,
                         w.user_id AS owner_id, w.updated_at AS last_at
                    FROM webpages w,
                         LATERAL jsonb_path_query(COALESCE(w.bridge_grants, '{}'::jsonb), '$.**.agentId') AS v(val)
                   WHERE jsonb_typeof(v.val) = 'string'
                  UNION ALL
                  SELECT w.bridge_grants ->> 'agent' AS agent_id, w.id AS id, w.name AS title,
                         w.user_id AS owner_id, w.updated_at AS last_at
                    FROM webpages w
                   WHERE jsonb_typeof(w.bridge_grants -> 'agent') = 'string'
              ) x
              WHERE agent_id = ANY($1::text[])`,
    },
});

module.exports = { SCANS };
