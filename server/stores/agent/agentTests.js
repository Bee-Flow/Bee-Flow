// @typecheck
'use strict';

/**
 * Test sets — the questions someone wrote down for an agent, and what happened
 * the last time they were played back.
 *
 * Two tables, both created in `stores/agent/initSchema.js` and both CASCADEd
 * with the agent:
 *
 *   agent_tests      id, agent_id, name, question, expect JSONB,
 *                    from_conversation_id, written_by JSONB, suggested_by,
 *                    created_at, updated_at
 *   agent_test_runs  id, agent_id, version, results JSONB, passed, total, ran_at,
 *                    seq (BIGSERIAL — invoegvolgorde, de tiebreaker onder `ran_at`
 *                    zodra twee runs in dezelfde milliseconde landen; `id` is een
 *                    uuidv4 en dus geen geldige tiebreaker)
 *
 * ── EVERY LOOKUP CARRIES THE AGENT ID ───────────────────────────────
 * `getTest`, `updateTest` and `deleteTest` all take `(agentId, testId)` and put
 * BOTH in the WHERE clause, even though the test id is a primary key. The route
 * has already decided that this caller may edit THIS agent; a test id belonging
 * to a different agent must therefore be unreachable rather than merely
 * unlikely. A store function that took the test id alone would make the route's
 * gate depend on the caller not knowing another id.
 *
 * ── `passed` IS CLAMPED, NOT TRUSTED ────────────────────────────────
 * `passed`/`total` are what the publish dialog renders as "8 of 9 green". A row
 * where `passed > total` — or where either is not a number — would be read as a
 * result rather than as the corruption it is, so both are coerced to integers
 * and `passed` is clamped into `[0, total]` on the way in. The route decides
 * WHICH results count as passes (`testSandbox.verdictFor`: only `status ===
 * 'pass'` does); this only refuses to store an impossible pair.
 *
 * ── A PRUNE THAT FAILS IS NOT A WRITE THAT FAILED ───────────────────
 * `recordTestRun` keeps the last `TEST_RUNS_KEEP` runs per agent. The prune
 * runs after the insert and its failure is logged, never thrown: losing the
 * run somebody just watched, because an old row would not delete, is the wrong
 * way round.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentTests.pg.test.js
 */

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../db');
const { initDB } = require('./initSchema');
const { buildUpdate } = require('../lib/sqlBuilder');
const log = require('../../telemetry/log');

/** Runs kept per agent. Mirrors testSandbox.TEST_RUNS_KEEP; see the note below. */
const TEST_RUNS_KEEP = 20;

/**
 * JSONB comes back as an object from `pg`, but a string from some drivers and
 * from a column that was written as text. Anything this cannot read becomes
 * the empty document — an expectation nobody can parse is not an expectation,
 * and `testSandbox.normaliseExpect` reaches the same answer from the other end.
 */
function _json(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return (parsed && typeof parsed === 'object') ? parsed : fallback;
        } catch (_) { return fallback; }
    }
    return fallback;
}

function _iso(value) {
    if (!value) return null;
    try { return new Date(value).toISOString(); } catch (_) { return null; }
}

function mapTest(row) {
    if (!row) return null;
    return {
        id: row.id,
        agentId: row.agent_id,
        name: row.name || '',
        question: row.question || '',
        expect: _json(row.expect, {}),
        // Herkomst per veld, en het model dat voorstelde. Alleen gezet voor een
        // test die uit "+ Dit gesprek als test" komt; een mens die zelf tikte
        // laat ze NULL, en dat is het eerlijke onderscheid dat de kaart nodig
        // heeft. Een onleesbaar document leest terug als leeg, nooit als junk.
        writtenBy: _json(row.written_by, null),
        suggestedBy: row.suggested_by || null,
        fromConversationId: row.from_conversation_id || null,
        createdAt: _iso(row.created_at),
        updatedAt: _iso(row.updated_at),
    };
}

function mapRun(row) {
    if (!row) return null;
    const total = Number(row.total) || 0;
    const passed = Number(row.passed) || 0;
    return {
        id: row.id,
        agentId: row.agent_id,
        version: Number(row.version) || 0,
        results: _json(row.results, {}),
        // Clamped on the way out as well: a row written before this store
        // existed, or edited by hand, must not render as "12 of 3 green".
        passed: Math.max(0, Math.min(passed, total)),
        total: Math.max(0, total),
        ranAt: _iso(row.ran_at),
    };
}

async function _ready(db) {
    // Only when running against the real pool: with an injected db the schema
    // belongs to whoever built it (same contract as agentStats).
    if (db === pool) await initDB();
}

// ── Tests ────────────────────────────────────────────────────────────

async function listTests(agentId, { db = pool } = {}) {
    if (!agentId) return [];
    await _ready(db);
    const r = await db.query(
        `SELECT * FROM agent_tests WHERE agent_id = $1 ORDER BY created_at ASC, id ASC`,
        [String(agentId)],
    );
    return (r.rows || []).map(mapTest);
}

async function countTests(agentId, { db = pool } = {}) {
    if (!agentId) return 0;
    await _ready(db);
    const r = await db.query(
        `SELECT COUNT(*)::int AS n FROM agent_tests WHERE agent_id = $1`,
        [String(agentId)],
    );
    return Number(r.rows && r.rows[0] && r.rows[0].n) || 0;
}

async function getTest(agentId, testId, { db = pool } = {}) {
    if (!agentId || !testId) return null;
    await _ready(db);
    const r = await db.query(
        `SELECT * FROM agent_tests WHERE id = $1 AND agent_id = $2`,
        [String(testId), String(agentId)],
    );
    return mapTest((r.rows || [])[0]);
}

/**
 * @param {string} agentId
 * @param {{name?: string, question: string, expect?: object,
 *          fromConversationId?: string|null, writtenBy?: object|null,
 *          suggestedBy?: string|null}} test  already normalised by the route
 */
async function createTest(agentId, test, { db = pool } = {}) {
    if (!agentId) throw new Error('createTest: agentId is required');
    const question = typeof test?.question === 'string' ? test.question : '';
    if (!question.trim()) throw new Error('createTest: question is required');
    await _ready(db);
    const id = uuidv4();
    const r = await db.query(
        `INSERT INTO agent_tests (id, agent_id, name, question, expect, from_conversation_id, written_by, suggested_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)
         RETURNING *`,
        [
            id, String(agentId),
            typeof test?.name === 'string' ? test.name : '',
            question,
            JSON.stringify(test?.expect && typeof test.expect === 'object' ? test.expect : {}),
            test?.fromConversationId || null,
            test?.writtenBy && typeof test.writtenBy === 'object' ? JSON.stringify(test.writtenBy) : null,
            typeof test?.suggestedBy === 'string' && test.suggestedBy ? test.suggestedBy : null,
        ],
    );
    return mapTest((r.rows || [])[0]);
}

/**
 * Patch a test. Only the keys present are written; `null` is returned when the
 * pair (agent, test) does not exist — which is also the answer for a test id
 * that belongs to a different agent.
 */
const TEST_PATCH_COLUMNS = {
    name: 'name',
    question: 'question',
    expect: { col: 'expect', cast: 'jsonb', transform: (v) => JSON.stringify(v) },
};

async function updateTest(agentId, testId, patch, { db = pool } = {}) {
    if (!agentId || !testId) return null;
    await _ready(db);
    // The type guards stay here rather than becoming column transforms: they
    // decide WHETHER a column is written, and a wrong-typed value must keep
    // the stored one instead of overwriting it.
    const built = buildUpdate({
        table: 'agent_tests',
        updates: {
            name: typeof patch?.name === 'string' ? patch.name : undefined,
            question: typeof patch?.question === 'string' && patch.question.trim() ? patch.question : undefined,
            expect: patch && patch.expect && typeof patch.expect === 'object' ? patch.expect : undefined,
        },
        columnMap: TEST_PATCH_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [{ col: 'id', value: String(testId) }, { col: 'agent_id', value: String(agentId) }],
        returning: '*',
    });
    if (!built) return getTest(agentId, testId, { db });
    const r = await db.query(built.sql, built.params);
    return mapTest((r.rows || [])[0]);
}

async function deleteTest(agentId, testId, { db = pool } = {}) {
    if (!agentId || !testId) return false;
    await _ready(db);
    const r = await db.query(
        `DELETE FROM agent_tests WHERE id = $1 AND agent_id = $2`,
        [String(testId), String(agentId)],
    );
    return (r.rowCount || 0) > 0;
}

// ── Runs ─────────────────────────────────────────────────────────────

/**
 * @param {{agentId: string, version?: number, results?: object,
 *          passed?: number, total?: number}} run
 */
async function recordTestRun(run, { db = pool } = {}) {
    const agentId = run && run.agentId;
    if (!agentId) throw new Error('recordTestRun: agentId is required');
    await _ready(db);
    const total = Math.max(0, Math.trunc(Number(run.total) || 0));
    const passed = Math.max(0, Math.min(Math.trunc(Number(run.passed) || 0), total));
    const id = uuidv4();
    const r = await db.query(
        `INSERT INTO agent_test_runs (id, agent_id, version, results, passed, total)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING *`,
        [
            id, String(agentId),
            Math.max(0, Math.trunc(Number(run.version) || 0)),
            JSON.stringify(run.results && typeof run.results === 'object' ? run.results : {}),
            passed, total,
        ],
    );
    const stored = mapRun((r.rows || [])[0]);

    try {
        await db.query(
            `DELETE FROM agent_test_runs
              WHERE agent_id = $1
                AND id NOT IN (
                    SELECT id FROM agent_test_runs WHERE agent_id = $1
                     ORDER BY ran_at DESC, seq DESC LIMIT $2)`,
            [String(agentId), TEST_RUNS_KEEP],
        );
    } catch (e) {
        log.warn('[agentTests] pruning old runs failed:', e.message);
    }
    return stored;
}

/**
 * De laatste runs, nieuwste eerst — de run-historie achter "Bekijk".
 *
 * De bovengrens is `TEST_RUNS_KEEP` en niet wat de aanroeper vraagt: meer dan
 * dat staat er niet, want de prune hierboven gooit de rest weg. Een `limit`
 * die daar overheen gaat zou dus een lijst beloven die per definitie korter
 * uitvalt, en het scherm laten denken dat het de hele geschiedenis ziet.
 */
async function listTestRuns(agentId, { limit = TEST_RUNS_KEEP, db = pool } = {}) {
    if (!agentId) return [];
    await _ready(db);
    const asked = Math.trunc(Number(limit));
    const n = Number.isFinite(asked) && asked > 0 ? Math.min(asked, TEST_RUNS_KEEP) : TEST_RUNS_KEEP;
    const r = await db.query(
        `SELECT * FROM agent_test_runs WHERE agent_id = $1 ORDER BY ran_at DESC, seq DESC LIMIT $2`,
        [String(agentId), n],
    );
    return (r.rows || []).map(mapRun);
}

async function getLastTestRun(agentId, { db = pool } = {}) {
    if (!agentId) return null;
    await _ready(db);
    const r = await db.query(
        `SELECT * FROM agent_test_runs WHERE agent_id = $1 ORDER BY ran_at DESC, seq DESC LIMIT 1`,
        [String(agentId)],
    );
    return mapRun((r.rows || [])[0]);
}

module.exports = {
    TEST_RUNS_KEEP,
    listTests, countTests, getTest, createTest, updateTest, deleteTest,
    recordTestRun, getLastTestRun, listTestRuns,
    // Exported for the colocated tests.
    mapTest, mapRun,
};
