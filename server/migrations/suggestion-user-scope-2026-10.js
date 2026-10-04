// @typecheck
/**
 * Migration: "Find repeating work" scans and feedback become PER USER.
 *
 * Both tables used to be scoped `org:<id>` for anyone in an organisation, so
 * GET /suggest/last served one person's scan (read with THEIR mail and files)
 * to every colleague, and one person's dismissal hid an idea for the whole
 * org. The stores now always write `user:<id>`; this cleans up what is there:
 *
 *   1. automation_suggestion_feedback: every `org:` row is REWRITTEN to
 *      `user:<user_id>:<title_fingerprint>` (the row's own writer), so built
 *      and asked rows survive. ON CONFLICT DO NOTHING: an existing per-user
 *      row is newer and wins. Rows without a user_id cannot be attributed and
 *      go. Then the `org:` rows are deleted.
 *   2. suggestion_json is cut back to the store's allow-list (title, kind,
 *      signature, apps, template). Old rows carried the full suggestion,
 *      including a buildPrompt that could name real senders and folders.
 *   3. suggestion_scan_cache: the `org:` rows are deleted. A cached scan is
 *      cheap to recompute and nobody but its author should see it.
 *
 * Idempotent (every step is guarded by its own WHERE), and skipped per table
 * when the table does not exist yet: the stores create them lazily, and boot
 * does not sequence this ladder after the store inits.
 */

'use strict';

const log = require('../telemetry/log');

const NAME = 'suggestion-user-scope-2026-10';
const ALLOWED_KEYS = ['title', 'kind', 'signature', 'apps', 'template'];

/** @typedef {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} Db */

/** @param {Db} db @param {string} table */
async function tableExists(db, table) {
    const { rows } = await db.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
    return !!(rows[0] && rows[0].t);
}

/** @param {Db} db */
async function migrateFeedback(db) {
    const moved = await db.query(`
        INSERT INTO automation_suggestion_feedback
            (id, user_id, organization_id, title_fingerprint, title, action, reason,
             suggestion_json, created_at, expires_at)
        SELECT 'user:' || user_id || ':' || title_fingerprint, user_id, organization_id, title_fingerprint,
               title, action, reason, suggestion_json, created_at, expires_at
          FROM automation_suggestion_feedback
         WHERE id LIKE 'org:%' AND user_id IS NOT NULL AND user_id <> ''
        ON CONFLICT (id) DO NOTHING
    `);
    const dropped = await db.query(`DELETE FROM automation_suggestion_feedback WHERE id LIKE 'org:%'`);
    const stripped = await db.query(`
        UPDATE automation_suggestion_feedback
           SET suggestion_json = CASE
               WHEN jsonb_typeof(suggestion_json) <> 'object' THEN NULL
               ELSE NULLIF(jsonb_strip_nulls(jsonb_build_object(
                    'title', suggestion_json->'title',
                    'kind', suggestion_json->'kind',
                    'signature', suggestion_json->'signature',
                    'apps', suggestion_json->'apps',
                    'template', suggestion_json->'template')), '{}'::jsonb)
           END
         WHERE suggestion_json IS NOT NULL
           AND (jsonb_typeof(suggestion_json) <> 'object' OR (suggestion_json - $1::text[]) <> '{}'::jsonb)
    `, [ALLOWED_KEYS]);
    return { moved: moved.rowCount || 0, dropped: dropped.rowCount || 0, stripped: stripped.rowCount || 0 };
}

/** @param {Db} db */
async function migrateCache(db) {
    const res = await db.query(`DELETE FROM suggestion_scan_cache WHERE scope_key LIKE 'org:%'`);
    return { deleted: res.rowCount || 0 };
}

/** @param {{ db?: Db }} [opts] */
async function up({ db } = {}) {
    const conn = db || { query: (sql, params) => require('../db').run(sql, params) };
    const result = { feedback: null, cache: null };
    if (await tableExists(conn, 'automation_suggestion_feedback')) result.feedback = await migrateFeedback(conn);
    if (await tableExists(conn, 'suggestion_scan_cache')) result.cache = await migrateCache(conn);
    log.info(`[Migration] ${NAME} applied`, JSON.stringify(result));
    return result;
}

module.exports = { up, NAME };
