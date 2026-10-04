// @typecheck
'use strict';
/**
 * Pattern source: the tool calls the user made by hand in chat, from the
 * outbound-call ledger (integration_activity_log).
 *
 * The filtering is the store's job (stores/integrationManualActivity.js):
 * this user's rows only (`user_id`, never the org or a lender), successful,
 * live, not part of an automation, and only the chat sources, which also keeps the
 * scan's own `pattern_scan` reads out. The ledger holds no arguments or
 * results, so an event here is a tool name, an app, a time and the
 * conversation it was part of; the conversation id is what the miner
 * sessionizes on.
 */

const { makeEvent } = require('../events');
const { toMs, inWindow } = require('./common');

const DEFAULT_LIMIT = 5000;

/** The ledger's integration id, or the tool name's prefix when it has none. */
function appOf(row) {
    const integ = typeof row.integration_type === 'string' ? row.integration_type.trim().toLowerCase() : '';
    if (integ) return integ;
    return String(row.tool_name || '').split('_')[0].toLowerCase() || 'unknown';
}

/** @returns {(p: { userId: string, since?: Date|string, limit?: number }) => Promise<any[]>} */
function defaultReader() {
    return (p) => require('../../../stores/integrationActivityStore').getManualToolEvents(p);
}

/**
 * @param {{
 *   userId: string, since: number, now: number,
 *   deps?: { getManualToolEvents?: (p: { userId: string, since?: Date|string, limit?: number }) => Promise<any[]> },
 *   limit?: number,
 * }} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectToolLedger(ctx) {
    if (!ctx?.userId) return [];
    const read = ctx.deps?.getManualToolEvents || defaultReader();
    const rows = await read({ userId: ctx.userId, since: new Date(ctx.since), limit: ctx.limit || DEFAULT_LIMIT });
    const out = [];
    for (const row of rows || []) {
        const ts = toMs(row?.timestamp);
        if (!row?.tool_name || !inWindow(ts, ctx)) continue;
        const ev = makeEvent({
            ts,
            source: 'ledger',
            objectType: 'tool',
            app: appOf(row),
            verb: row.tool_name,
            sessionKey: row.conversation_id || null,
        });
        if (ev) out.push(ev);
    }
    return out;
}

module.exports = { collectToolLedger, appOf };
