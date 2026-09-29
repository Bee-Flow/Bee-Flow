// @typecheck
'use strict';

/**
 * "What breaks if I delete this agent?"
 *
 * ── WHY IT IS A SCAN AND NOT A JOIN TABLE ───────────────────────────
 * Every consumer stores the agent id INSIDE its own row: a scheduled task in
 * `ai_tasks.agent_id`, a Cowork schedule in `cowork_schedules.agent_id`, a
 * support inbox in `support_inboxes.default_agent_id`, and — once R2/P/W3
 * land — a routine step, an app block and a webpage bridge grant somewhere
 * inside their own JSON documents. There is no join table, and adding one
 * would mean a write path in six places that all have to stay in step with
 * the documents they mirror; the copy that falls behind is the one that
 * answers "nothing uses this" about an agent two routines run every night.
 *
 * So this reads the rows themselves. A handful of queries run when somebody
 * opens the Used-by tab or presses delete, never on a chat turn.
 *
 * ── A CONSUMER TABLE THAT IS NOT THERE IS NOT "NO USAGE" ────────────
 * Not every deployment has every feature, and not every query succeeds. A
 * missing table or a failing scan makes that kind come back in `partial`,
 * NEVER as zero — because zero is what the delete guard reads as "safe to
 * remove", and "the apps table is not on this install" is a different
 * statement from "no app uses this agent". Callers must treat a non-empty
 * `partial` as "I do not know", which on a delete means refuse.
 *
 * ── ONE QUERY SHAPE, TWO CALLERS ────────────────────────────────────
 * `usageForAgent` (the Used-by tab and the delete guard) and
 * `usageCountsForAgents` (the list pills) run the SAME SQL over an id ARRAY;
 * the second only groups what the first returns. Two query shapes would
 * eventually disagree, and the disagreement people notice is a list saying
 * "used by nothing" beside a delete that refuses.
 *
 * ── THE FORWARD-LOOKING HALF IS DELIBERATE ──────────────────────────
 * `ai_step.agentId` (R2), the app AI block's `agentId` (P) and the webpage
 * bridge grant (W3) do not exist yet. Their scans are written now and find
 * nothing today, because the alternative — shipping the delete guard without
 * them — is a guard that goes quietly wrong on the day the feature lands.
 * The JSON scans look for the KEY `agentId` at ANY depth, so a step, a block
 * or a grant is found wherever its author nests it; `agentUsage.pg.test.js`
 * pins the shapes.
 *
 * ── NO ID EVER ENTERS A JSONPATH ────────────────────────────────────
 * The jsonpath here is a constant (`$.**.agentId`); the ids are compared in
 * SQL against a bound `text[]`. There is nothing to escape, which is a
 * stronger property than binding an id into `jsonb_build_object` — an agent
 * id arrives from a route parameter.
 *
 * ── WHAT IS DELIBERATELY NOT A CONSUMER ─────────────────────────────
 * `usage_logs`, `memories`, `feedback`, `guardrail_events`, `dpia_*`,
 * `skill_test_runs`, `agent_versions`, `integration_activity` all carry an
 * `agent_id`. They are HISTORY: they record that the agent ran, they do not
 * stop working when it goes. Counting them would make every agent that ever
 * answered a question undeletable. `agent_tests` / `agent_test_runs` (A1c)
 * are not history, but they are not consumers either: a test set belongs TO
 * this agent, cascades with it, and has nothing left to break. Conversations are handled separately (see
 * agentStats.getAgentChatStats) because they cascade — the question there is
 * whose content is destroyed, not what breaks.
 */

const { pool } = require('../../db');
const log = require('../../telemetry/log');

/** Every kind this can find, in the order the Used-by tab lists them. */
const KINDS = Object.freeze(['task', 'cowork', 'support', 'automation', 'app', 'webpage']);

/** Ids per round trip. A scan is one pass per kind; the ids ride along. */
const ID_CHUNK = 200;

/**
 * One query per consumer kind, each returning `(agent_id, id, title,
 * owner_id, last_at)` for EVERY id in `$1`. `agent_id` is which of the asked
 * agents this row uses — that is what lets one query serve both callers.
 */
const SCANS = Object.freeze({
    // A scheduled AI task bound to an agent. `aiTaskRunner` resolves it with
    // getForRuntime and throws "Linked agent no longer exists" when it is
    // gone — the exact breakage this guard exists to announce first.
    task: {
        table: 'ai_tasks',
        role: 'routine',
        sql: `SELECT t.agent_id AS agent_id, t.id AS id, t.title AS title,
                     t.user_id AS owner_id, COALESCE(t.last_run_at, t.created_at) AS last_at
                FROM ai_tasks t
               WHERE t.agent_id = ANY($1::text[])`,
    },
    // The same relationship on the Cowork side.
    cowork: {
        table: 'cowork_schedules',
        role: 'routine',
        sql: `SELECT c.agent_id AS agent_id, c.id AS id, c.title AS title,
                     c.user_id AS owner_id, COALESCE(c.last_run_at, c.created_at) AS last_at
                FROM cowork_schedules c
               WHERE c.agent_id = ANY($1::text[])`,
    },
    // The inbox's auto-responder drafts replies with this agent. `id` is a
    // UUID here, so it is cast — a client comparing ids across kinds must get
    // text from all of them.
    support: {
        table: 'support_inboxes',
        role: 'auto_reply',
        sql: `SELECT i.default_agent_id AS agent_id, i.id::text AS id, i.display_name AS title,
                     i.created_by AS owner_id, i.updated_at AS last_at
                FROM support_inboxes i
               WHERE i.default_agent_id = ANY($1::text[])`,
    },
    // R2's ai_step. The id sits at an unknown depth inside a definition that
    // also encodes a canvas, so the recursive accessor is the only form that
    // finds it wherever the editor put it. DISTINCT because a routine that
    // names the same agent in two steps is ONE routine that breaks.
    automation: {
        table: 'automations',
        role: 'ai_step',
        sql: `SELECT DISTINCT v.val #>> '{}' AS agent_id, a.id AS id, a.title AS title,
                     a.user_id AS owner_id, a.updated_at AS last_at
                FROM automations a,
                     LATERAL jsonb_path_query(COALESCE(a.definition_json, '{}'::jsonb), '$.**.agentId') AS v(val)
               WHERE jsonb_typeof(v.val) = 'string'
                 AND (v.val #>> '{}') = ANY($1::text[])`,
    },
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

/**
 * Which consumer tables exist, in ONE round trip.
 *
 * Deliberately not cached: a table can appear at any time (its store creates
 * it on first use), and a cached "absent" would keep a whole feature invisible
 * to the delete guard until the process restarts. If the probe itself fails
 * every kind is reported absent, which lands in `partial` — the narrow answer.
 */
async function probeTables(kinds, db) {
    const tables = kinds.map(k => SCANS[k].table);
    const cols = tables.map((_, i) => `to_regclass($${i + 1}) IS NOT NULL AS t${i}`).join(', ');
    try {
        const r = await db.query(`SELECT ${cols}`, tables);
        const row = r.rows[0] || {};
        return new Map(kinds.map((k, i) => [k, row[`t${i}`] === true]));
    } catch (e) {
        log.warn('[AgentUsage] table probe failed:', e.message);
        return new Map(kinds.map(k => [k, false]));
    }
}

function chunk(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) out.push(ids.slice(i, i + ID_CHUNK));
    return out;
}

/**
 * Raw scan rows for a set of agent ids.
 *
 * @returns {Promise<{ rows: Array<{agentId,kind,id,title,role,ownerId,lastAt}>, partial: string[] }>}
 */
async function _scan(agentIds, db) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean).map(String))];
    if (ids.length === 0) return { rows: [], partial: [] };

    const present = await probeTables(KINDS, db);
    const rows = [];
    const partial = [];

    for (const kind of KINDS) {
        const scan = SCANS[kind];
        if (!present.get(kind)) {
            // Absent because the feature is not installed. Not an error, and
            // not "no usage" either — `partial` carries the difference.
            partial.push(kind);
            continue;
        }
        try {
            for (const batch of chunk(ids)) {
                const r = await db.query(scan.sql, [batch]);
                for (const row of r.rows || []) {
                    if (!row.agent_id) continue;
                    rows.push({
                        agentId: String(row.agent_id),
                        kind,
                        id: row.id != null ? String(row.id) : null,
                        title: row.title || null,
                        role: scan.role,
                        ownerId: row.owner_id || null,
                        lastAt: row.last_at || null,
                    });
                }
            }
        } catch (e) {
            // One kind failing must not abandon the other five — but it must
            // not read as zero either.
            log.warn(`[AgentUsage] ${kind} scan failed:`, e.message);
            partial.push(kind);
        }
    }
    return { rows, partial };
}

/**
 * Who uses this agent?
 *
 * @param {string} agentId
 * @param {object} [opts]
 * @param {object} [opts.db]  injection seam for the tests
 * @returns {Promise<{ rows: Array, partial: string[] }>} `partial` names the
 *   kinds that could NOT be answered. Never treat it as "nothing".
 */
async function usageForAgent(agentId, { db = pool } = {}) {
    if (!agentId) return { rows: [], partial: [] };
    const { rows, partial } = await _scan([agentId], db);
    // `agentId` is dropped here: with one agent asked it says nothing the
    // caller does not already know, and the Used-by row contract is the same
    // `{kind, id, title, role, ownerId, lastAt}` the KB tab renders.
    return { rows: rows.map(({ agentId: _drop, ...rest }) => rest), partial };
}

/**
 * Counts per kind for many agents at once — the list pills.
 *
 * Every requested id gets an entry, so a caller iterating the result never
 * has to decide what a missing key means.
 *
 * @returns {Promise<Record<string, {counts: Record<string, number>, partial: string[]}>>}
 */
async function usageCountsForAgents(agentIds, { db = pool } = {}) {
    const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter(Boolean).map(String))];
    /** @type {Record<string, {counts: Record<string, number>, partial: string[]}>} */
    const out = {};
    for (const id of ids) out[id] = { counts: {}, partial: [] };
    if (ids.length === 0) return out;

    const { rows, partial } = await _scan(ids, db);
    for (const row of rows) {
        const entry = out[row.agentId];
        if (!entry) continue;  // an id the caller did not ask about
        entry.counts[row.kind] = (entry.counts[row.kind] || 0) + 1;
    }
    // A kind nobody could answer is unknown for EVERY agent in the batch,
    // not for none of them.
    if (partial.length) for (const id of ids) out[id].partial = [...partial];
    return out;
}

/**
 * Everything nobody could check, for a caller that has no rows to show.
 *
 * A `/agents/all` whose whole usage pass threw must still say "I do not know"
 * per agent rather than shipping an empty `counts` that renders as zero.
 */
function unknownUsage() {
    return { counts: {}, partial: [...KINDS] };
}

/**
 * Narrow usage rows to what this person may know about.
 *
 * Seeing what depends on an agent means seeing the NAMES of routines, apps
 * and pages. Anything the asker does not own is COUNTED but not named, so the
 * tab stays honest about how much breaks without becoming a way to enumerate
 * an organisation. Same `foreign` flag as the knowledge-base Used-by tab; it
 * lives here rather than in a route so the tab and the delete refusal cannot
 * drift apart.
 *
 * STRICTER than that tab in one way, on purpose: the id and the owner go too,
 * not only the title. A routine id the asker cannot open is of no use to
 * them, and `ownerId` names the colleague who built it — "who in this
 * organisation automates against this agent" is a question this endpoint was
 * never asked. The row keeps its shape so the client renders one row type,
 * and `counts` (taken before this runs) keeps the number honest.
 *
 * If A2 decides an org admin should see these names, that is a widening to
 * make deliberately, against whatever rule governs who may list an
 * organisation's routines — not something to inherit by accident from here.
 */
function redactForeign(rows, userId) {
    return (rows || []).map((r) => {
        if (r.ownerId && userId && String(r.ownerId) === String(userId)) return r;
        return { ...r, id: null, title: null, ownerId: null, lastAt: null, foreign: true };
    });
}

module.exports = {
    usageForAgent,
    usageCountsForAgents,
    unknownUsage,
    redactForeign,
    KINDS,
    SCANS,
};
