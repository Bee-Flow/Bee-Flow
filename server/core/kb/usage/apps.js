// @typecheck strict
/**
 * The apps module's part of "who uses this knowledge base?" (core/kb/kbUsage.js asks for it
 * by name): the App Studio apps whose definition names the base. An app is never scrubbed
 * (kbUsage.js says why).
 */

'use strict';

/** @typedef {import('../kbUsage').KbScan} KbScan */

/** @type {Readonly<Record<string, KbScan>>} */
const SCANS = Object.freeze({
    app: {
        table: 'studio_apps',
        // Both the working definition and the published one: an app that only
        // uses the base in its PUBLISHED version still breaks if it goes.
        sql: `SELECT id, name AS title, user_id AS owner_id, updated_at AS last_at
                FROM studio_apps
               WHERE jsonb_path_exists(COALESCE(definition, '{}'::jsonb), '$.**.knowledgeBaseIds[*] ? (@ == $id)', jsonb_build_object('id', $1::text))
                  OR jsonb_path_exists(COALESCE(published_definition, '{}'::jsonb), '$.**.knowledgeBaseIds[*] ? (@ == $id)', jsonb_build_object('id', $1::text))`,
        params: (kbId) => [kbId],
        role: 'answer_block',
    },
});

module.exports = { SCANS };
