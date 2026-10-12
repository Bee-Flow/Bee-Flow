// @typecheck
/**
 * The two reads "Find repeating work" makes on the outbound-call ledger
 * (integration_activity_log), split out of integrationActivityStore.js, which
 * re-exports them.
 *
 *   getManualToolEvents     the tool calls ONE user made by hand in chat: the
 *                           raw material of the pattern miner
 *   getAutomatedToolNames   the tools that user's automations already run: what
 *                           the suppression step leaves out
 *
 * PRIVACY, and why each filter is there:
 *   - `user_id` only. Never `organization_id` (a colleague's work is not
 *     yours) and never `acting_user_id` (that is the lender or viewer of a
 *     borrowed connection, not the person who did the work).
 *   - `source` is an ALLOW-LIST of the chat paths. A deny-list would let every
 *     future writer in, including the scan's own reads (`pattern_scan`), which
 *     would then inflate the next scan's counts.
 *   - No arguments, summaries or PII columns are selected: the ledger stores
 *     none of the call's content, and these reads do not reach for what it has.
 */

'use strict';

const { run } = require('../db');

/** Ledger `source` values that mean "a person asked for this in a chat". */
const MANUAL_SOURCES = Object.freeze(['agent_chat', 'agent_stream', 'direct_chat']);
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 20000;

function sinceOf(since) {
    const t = since instanceof Date ? since.getTime() : (since == null ? NaN : Date.parse(String(since)));
    return new Date(Number.isFinite(t) ? t : Date.now() - DEFAULT_WINDOW_DAYS * 86400_000).toISOString();
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} db
 * @param {{ ready?: () => Promise<unknown> }} [opts]
 */
function makeManualActivityReader(db, { ready = async () => {} } = {}) {
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };

    /**
     * The user's own successful, live, chat-initiated tool calls since `since`
     * (default 90 days), oldest first. When there are more than `limit`, the
     * most recent `limit` are returned.
     * @param {{ userId: string, since?: Date|string, limit?: number }} p
     * @returns {Promise<Array<{tool_name: string, integration_type: string|null, timestamp: Date, conversation_id: string|null}>>}
     */
    async function getManualToolEvents({ userId, since, limit = DEFAULT_LIMIT } = /** @type {any} */ ({})) {
        if (!userId) return [];
        const cap = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(Number(limit) || DEFAULT_LIMIT)));
        const { rows } = await q(`
            SELECT tool_name, integration_type, timestamp, conversation_id
              FROM integration_activity_log
             WHERE user_id = $1
               AND timestamp >= $2
               AND status = 'success'
               AND automation_id IS NULL
               AND COALESCE(is_dry_run, false) = false
               AND source = ANY($3::text[])
             ORDER BY timestamp DESC, id DESC
             LIMIT $4
        `, [String(userId), sinceOf(since), [...MANUAL_SOURCES], cap]);
        return rows.reverse();
    }

    /**
     * Distinct tool names the user's automations ran since `since` (default 90
     * days): a pattern made of these is already automated.
     * @param {{ userId: string, since?: Date|string }} p
     * @returns {Promise<string[]>}
     */
    async function getAutomatedToolNames({ userId, since } = /** @type {any} */ ({})) {
        if (!userId) return [];
        const { rows } = await q(`
            SELECT DISTINCT tool_name
              FROM integration_activity_log
             WHERE user_id = $1
               AND timestamp >= $2
               AND automation_id IS NOT NULL
             ORDER BY tool_name
        `, [String(userId), sinceOf(since)]);
        return rows.map(r => r.tool_name).filter(Boolean);
    }

    return { getManualToolEvents, getAutomatedToolNames };
}

/** Default reader on the real pool; `ready` is the ledger store's initDB. */
function defaultReader(ready) {
    return makeManualActivityReader({ query: (sql, params) => run(sql, params) }, { ready });
}

module.exports = { MANUAL_SOURCES, makeManualActivityReader, defaultReader };
