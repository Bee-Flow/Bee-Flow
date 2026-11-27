// @typecheck strict
/**
 * The automation module's part of "who uses this knowledge base?" (core/kb/kbUsage.js asks
 * for it by name): the automations whose definition names the base. An automation is never
 * scrubbed (kbUsage.js says why).
 */

'use strict';

/** @typedef {import('../kbUsage').KbScan} KbScan */

/** @type {Readonly<Record<string, KbScan>>} */
const SCANS = Object.freeze({
    automation: {
        table: 'automations',
        // The ids live at an unknown depth inside the definition, so the
        // containment operator cannot be used — `jsonb_path_exists` with a
        // recursive wildcard is the one form that finds them wherever an
        // editor put them.
        //
        // The id goes in through jsonpath's own VARS argument, never
        // concatenated into the path. A kb id is a route parameter, and a
        // value carrying a quote would otherwise close the string literal
        // inside the jsonpath and be parsed as path syntax — bound to a
        // placeholder or not, the injection would be into the path, not the
        // SQL.
        sql: `SELECT id, title, user_id AS owner_id, updated_at AS last_at
                FROM automations
               WHERE jsonb_path_exists(definition_json, '$.**.knowledgeBaseIds[*] ? (@ == $id)', jsonb_build_object('id', $1::text))`,
        params: (kbId) => [kbId],
        role: 'ai_step',
    },
});

module.exports = { SCANS };
