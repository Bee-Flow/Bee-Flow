// @typecheck strict
'use strict';

/**
 * The apps module's part of "what breaks if I delete this agent?" (stores/agent/agentUsage.js
 * asks for it by name): the apps whose AI blocks name it.
 */

/** @typedef {import('../agentUsage').AgentScan} AgentScan */

/** @type {Readonly<Record<string, AgentScan>>} */
const SCANS = Object.freeze({
    // P's app AI block. Both definitions are searched: an app that names the
    // agent only in its PUBLISHED version still breaks when it goes. They are
    // wrapped in one object rather than merged with `||`, which would let a
    // draft key hide a published one of the same name.
    app: {
        table: 'studio_apps',
        role: 'ai_block',
        sql: `SELECT DISTINCT v.val #>> '{}' AS agent_id, s.id AS id, s.name AS title,
                     s.user_id AS owner_id, s.updated_at AS last_at
                FROM studio_apps s,
                     LATERAL jsonb_path_query(
                         jsonb_build_object('draft', COALESCE(s.definition, '{}'::jsonb),
                                            'published', COALESCE(s.published_definition, '{}'::jsonb)),
                         '$.**.agentId') AS v(val)
               WHERE jsonb_typeof(v.val) = 'string'
                 AND (v.val #>> '{}') = ANY($1::text[])`,
    },
});

module.exports = { SCANS };
