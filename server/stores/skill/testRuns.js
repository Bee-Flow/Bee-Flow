// @typecheck
'use strict';
/**
 * The Test tab's runs: recorded per skill (the last TEST_RUNS_KEEP), listed,
 * and the latest one per skill for the overview's `lastTest`.
 */

const crypto = require('crypto');
const { run, getAll } = require('../../db');
const log = require('../../telemetry/log');
const { initDB, TEST_RUNS_KEEP } = require('./schema');


const TEST_STATUSES = Object.freeze(['ok', 'warning', 'error']);

/**
 * Persist one Test-tab run and keep the last TEST_RUNS_KEEP per skill.
 *
 * A status this store does not recognise — or none at all — is stored as
 * `error`, NOT as `ok`. The Test tab reads this row back as a verdict about
 * somebody's skill, and `ok` is the reassuring one: coercing an unknown value
 * to it turns a caller's bug into a green tick nobody earned. The grader
 * itself already narrows the same way (skillTest.parseGrading: an unreported
 * step is `warning`, never `ok`), and this is that rule at the last gate.
 *
 * @param {{ skillId:string, agentId?:string|null, question:string, results:Array<{stepId,title,evidence,status}>, status:'ok'|'warning'|'error', advice?:string|null }} p
 */
async function recordTestRun({ skillId, agentId = null, question = '', results = [], status, advice = null }) {
    await initDB();
    if (!skillId) throw new Error('skillId required');
    const id = crypto.randomUUID();
    let st = status;
    if (!TEST_STATUSES.includes(st)) {
        log.warn(`[skillStore] recordTestRun: unknown status ${JSON.stringify(status)} — stored as "error".`);
        st = 'error';
    }
    const res = Array.isArray(results) ? results : [];
    await run(
        `INSERT INTO skill_test_runs (id, skill_id, agent_id, question, results, status, advice)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [id, skillId, agentId || null, String(question || '').slice(0, 4000), JSON.stringify(res), st, advice ? String(advice).slice(0, 4000) : null],
    );
    await run(
        `DELETE FROM skill_test_runs
          WHERE skill_id = $1
            AND id NOT IN (SELECT id FROM skill_test_runs WHERE skill_id = $1 ORDER BY ran_at DESC LIMIT $2)`,
        [skillId, TEST_RUNS_KEEP],
    );
    return { id, skillId, agentId: agentId || null, question, results: res, status: st, advice: advice || null, ranAt: new Date().toISOString() };
}

function _mapTestRun(r) {
    let results = r.results;
    if (typeof results === 'string') { try { results = JSON.parse(results); } catch (_) { results = []; } }
    if (!Array.isArray(results)) results = [];
    return {
        id: r.id,
        skillId: r.skill_id,
        agentId: r.agent_id || null,
        question: r.question || '',
        results,
        status: r.status || 'ok',
        advice: r.advice || null,
        ranAt: r.ran_at ? new Date(r.ran_at).toISOString() : null,
    };
}

/** Newest first, at most TEST_RUNS_KEEP. */
async function listTestRuns(skillId, limit = TEST_RUNS_KEEP) {
    await initDB();
    if (!skillId) return [];
    const n = Math.max(1, Math.min(TEST_RUNS_KEEP, parseInt(limit, 10) || TEST_RUNS_KEEP));
    const rows = await getAll(
        `SELECT * FROM skill_test_runs WHERE skill_id = $1 ORDER BY ran_at DESC LIMIT $2`,
        [skillId, n],
    );
    return (rows || []).map(_mapTestRun);
}

/** `lastTest` per skill: `{ [skillId]: { status, adviceCount, ranAt } }` (skills never tested are absent). */
async function getLastTestBySkillIds(skillIds) {
    await initDB();
    const ids = [...new Set((Array.isArray(skillIds) ? skillIds : []).filter(Boolean))];
    if (ids.length === 0) return {};
    const rows = await getAll(
        `SELECT DISTINCT ON (skill_id) skill_id, status, advice, results, ran_at
           FROM skill_test_runs
          WHERE skill_id = ANY($1::text[])
          ORDER BY skill_id, ran_at DESC`,
        [ids],
    );
    const out = {};
    for (const r of rows || []) {
        const t = _mapTestRun(r);
        const flagged = t.results.filter(x => x && x.status && x.status !== 'ok').length;
        out[r.skill_id] = {
            status: t.status,
            adviceCount: flagged > 0 ? flagged : (t.advice ? 1 : 0),
            ranAt: t.ranAt,
        };
    }
    return out;
}

module.exports = { recordTestRun, listTestRuns, getLastTestBySkillIds, TEST_STATUSES };
