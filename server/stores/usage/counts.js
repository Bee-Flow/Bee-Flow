// @typecheck
/**
 * Per-id counts read from ai_usage_log: test chats per agent and App Studio
 * action runs per app, each under its own literal source name.
 */

const { getAll } = require('../../db');
const { initDB } = require('./schema');

// The source under which a TEST CHAT (A4) writes its usage. Repeated literally instead of
// imported, so that a store does not have to pull anything out of the runtime;
// `usageStore.testChats.test.js` pins the two to each other, so that renaming on one side
// turns red instead of silently setting the count to zero.
const TEST_CHAT_SOURCE = 'agent_test_chat';

/**
 * How many TEST CONVERSATIONS has each agent had? (A4)
 *
 * A test conversation deliberately writes no row to `agent_conversations` — that is exactly
 * what keeps it out of the history, out of the footer card (A5) and out of every export.
 * But it DOES cost something, so it IS in `ai_usage_log`, under its own source. One
 * ephemeral conversation gets one id, so `COUNT(DISTINCT conversation_id)` is exactly
 * "n test conversations" — not turns and not model calls, of which there are more per
 * conversation.
 *
 * That "one id" is a property of `testChat.ephemeralConversationId`, not of this query: it
 * hashes the client's session key together with the user and the agent, so that all turns
 * of one test conversation carry the same id. If a test turn ever runs WITHOUT a session
 * key, it gets a fresh id and counts as a conversation of its own — too high, never too low.
 *
 * Rows without `conversation_id` do not count: they cannot be assigned to a conversation,
 * and counting one of them as "a conversation" would round the count up on an assumption.
 *
 * @param {string[]} agentIds
 * @param {object} [opts]
 * @param {any} [opts.db] injection point for the tests
 * @returns {Promise<Map<string, number>>} one entry per requested id; zero is here an
 *   established fact, not a missing answer.
 */
async function getTestChatCounts(agentIds, { db = null } = {}) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean).map(String))];
    const out = new Map(ids.map(id => [id, 0]));
    if (ids.length === 0) return out;
    const sql = `SELECT agent_id, COUNT(DISTINCT conversation_id)::int AS test_chats
                   FROM ai_usage_log
                  WHERE agent_id = ANY($1::text[])
                    AND source = $2
                    AND conversation_id IS NOT NULL
                  GROUP BY agent_id`;
    let rows;
    if (db && typeof db.query === 'function') {
        rows = (await db.query(sql, [ids, TEST_CHAT_SOURCE])).rows || [];
    } else {
        await initDB();
        rows = await getAll(sql, [ids, TEST_CHAT_SOURCE]);
    }
    for (const row of rows) {
        if (out.has(String(row.agent_id))) out.set(String(row.agent_id), Number(row.test_chats) || 0);
    }
    return out;
}

// The source under which an ACTION RUN of an App Studio app writes its row
// (routes/studioAppsRun.js, both /run and /step). Repeated literally instead of
// imported — same consideration as TEST_CHAT_SOURCE at the top of this file: a store should
// not pull anything out of the runtime, and `usageStore.studioAppRuns.test.js` pins the two
// to each other, so that renaming on one side turns red instead of silently setting the
// count to zero.
const STUDIO_APP_ACTION_SOURCE = 'studio_app_action';

// Windows for getStudioAppRunCounts. CLOSED list, because the value is an SQL fragment:
// the key may come from a query parameter, the value never does.
// 'month' is the calendar month (from the 1st), not the last 30 days, because the label
// that carries this number says "this month".
const RUN_COUNT_WINDOWS = {
    month: "date_trunc('month', NOW())",
};

/**
 * How many ACTION RUNS has each App Studio app had in this window? (APPS-08)
 *
 * What this counts is exactly one thing: runs of an app action via the run_automation bridge
 * — `routes/studioAppsRun.js` writes one `ai_usage_log` row there per run, with
 * `agent_type='studio_app'`, `agent_id = app.id` and this source. It is NOT an opening
 * counter: an app that only creates records via another path stands at 0 here while it runs
 * daily. Whoever shows the number must therefore say WHAT it counts ("N actions this month")
 * and never "N x", which reads as "opened N times" — a different number that this source does
 * not have.
 *
 * The trap is in user_id. Every row is on the OWNER of the app (the run acts as the owner,
 * even when a colleague presses the button), so filtering on the viewer would yield zero for
 * everyone except the builder. This query therefore never filters on user_id. The org scope
 * sits in the ID LIST the caller passes: the route fills that with `getAccessibleStudioApps`,
 * the same visibility predicate as the directory itself. Filtering on organization_id on top
 * of that would zero out the owner's own unpublished app, whose rows carry
 * `organization_id` NULL.
 *
 * @param {string[]} appIds
 * @param {object} [opts]
 * @param {string} [opts.window='month'] key from RUN_COUNT_WINDOWS
 * @param {any} [opts.db] injection point for the tests
 * @returns {Promise<Map<string, number>>} one entry per requested id; zero is here an
 *   established fact, not a missing answer.
 */
async function getStudioAppRunCounts(appIds, { window = 'month', db = null } = {}) {
    const since = RUN_COUNT_WINDOWS[window];
    if (!since) throw new Error(`getStudioAppRunCounts: unknown window '${window}'`);
    const ids = [...new Set((Array.isArray(appIds) ? appIds : []).filter(Boolean).map(String))];
    const out = new Map(ids.map(id => [id, 0]));
    if (ids.length === 0) return out;
    const sql = `SELECT agent_id, COUNT(*)::int AS runs
                   FROM ai_usage_log
                  WHERE agent_id = ANY($1::text[])
                    AND source = $2
                    AND timestamp >= ${since}
                  GROUP BY agent_id`;
    let rows;
    if (db && typeof db.query === 'function') {
        rows = (await db.query(sql, [ids, STUDIO_APP_ACTION_SOURCE])).rows || [];
    } else {
        await initDB();
        rows = await getAll(sql, [ids, STUDIO_APP_ACTION_SOURCE]);
    }
    for (const row of rows) {
        if (out.has(String(row.agent_id))) out.set(String(row.agent_id), Number(row.runs) || 0);
    }
    return out;
}

module.exports = { TEST_CHAT_SOURCE, STUDIO_APP_ACTION_SOURCE, RUN_COUNT_WINDOWS, getTestChatCounts, getStudioAppRunCounts };
