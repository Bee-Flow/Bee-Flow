// @typecheck strict
/**
 * The templates module's part of "who uses this knowledge base?" (core/kb/kbUsage.js asks for
 * it by name): the Word templates that contain the base, and the array the scrub removes it from.
 */

'use strict';

/** @typedef {import('../kbUsage').KbScan} KbScan */

/** @type {Readonly<Record<string, KbScan>>} */
const SCANS = Object.freeze({
    template: {
        table: 'word_templates',
        sql: `SELECT id, name AS title, user_id AS owner_id, updated_at AS last_at
                FROM word_templates WHERE knowledge_base_ids @> $1::jsonb`,
        params: (kbId) => [JSON.stringify([kbId])],
        role: 'contains',
    },
});

/** The JSON array column that holds the base ids, for the scrub. */
const ARRAY_SCRUB = Object.freeze({ table: 'word_templates', column: 'knowledge_base_ids' });

module.exports = { SCANS, ARRAY_SCRUB };
