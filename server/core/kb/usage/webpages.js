// @typecheck strict
/**
 * The webpages module's part of "who uses this knowledge base?" (core/kb/kbUsage.js asks for
 * it by name): the pages that chat with the base, and the array the scrub removes it from.
 */

'use strict';

/** @typedef {import('../kbUsage').KbScan} KbScan */

/** @type {Readonly<Record<string, KbScan>>} */
const SCANS = Object.freeze({
    webpage: {
        table: 'webpages',
        sql: `SELECT id, name AS title, user_id AS owner_id, updated_at AS last_at
                FROM webpages WHERE knowledge_base_ids @> $1::jsonb`,
        params: (kbId) => [JSON.stringify([kbId])],
        role: 'chat',
    },
});

/** The JSON array column that holds the base ids, for the scrub. */
const ARRAY_SCRUB = Object.freeze({ table: 'webpages', column: 'knowledge_base_ids' });

module.exports = { SCANS, ARRAY_SCRUB };
