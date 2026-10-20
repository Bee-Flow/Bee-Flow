// @typecheck
/**
 * Fixtures and test cases (stores/automationTestingStore.js is their union with
 * the golden and form-scenario factories).
 *
 * A fixture is the input of one code step, copied from a finished run. It is
 * the only table here that holds run VALUES, so a row object NEVER carries
 * them: `input_json` is read by exactly one function, `getTestCaseInput`,
 * which the test runner calls. Listing and reading a case reports only whether
 * its fixture still exists (`available`): when the run's retention deletes the
 * run, the fixture goes with it (ON DELETE CASCADE), the case stays, and its
 * input reads as unavailable.
 */

'use strict';

const crypto = require('crypto');

const newId = (prefix) => `${prefix}${crypto.randomUUID().replace(/-/g, '')}`;
const toIso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
/** A json column arrives parsed from pg and PGlite; text is parsed defensively. */
const fromJson = (v, fallback) => {
    if (v == null) return fallback;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return fallback; }
};

/** Columns of a case plus whether its fixture exists. input_json is NOT selected. */
const CASE_SELECT = `
    SELECT c.id, c.automation_id, c.step_id, c.name, c.input_kind, c.typed_input_json, c.fixture_id,
           c.expect, c.assertions_json, c.last_status, c.last_run_at, c.created_by, c.created_at, c.updated_at,
           f.id AS fx_id, f.run_id AS fx_run_id
      FROM automation_test_cases c
      LEFT JOIN automation_test_fixtures f ON f.id = c.fixture_id`;

/** The public shape of a case row. Fixture values are never in it. */
function rowToTestCase(r) {
    const input = r.input_kind === 'typed'
        ? { kind: 'typed', values: fromJson(r.typed_input_json, {}) }
        : { kind: 'run', fixtureId: r.fx_id ?? null, runId: r.fx_run_id ?? null, available: !!r.fx_id };
    return {
        id: r.id,
        automationId: r.automation_id,
        stepId: r.step_id,
        name: r.name,
        input,
        expect: r.expect,
        assertions: fromJson(r.assertions_json, []),
        lastStatus: r.last_status ?? null,
        lastRunAt: toIso(r.last_run_at),
        createdBy: r.created_by ?? null,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number|null }> }} db
 * @param {() => Promise<void>} ready
 */
function makeTestCases(db, ready) {
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };

    /** Remove a fixture no case points at any more. */
    async function dropFixture(fixtureId) {
        if (!fixtureId) return;
        await q(`DELETE FROM automation_test_fixtures f
                  WHERE f.id = $1 AND NOT EXISTS (SELECT 1 FROM automation_test_cases c WHERE c.fixture_id = f.id)`, [fixtureId]);
    }

    async function createFixture({ automationId, runId, stepId, input }) {
        const id = newId('tfx_');
        await q(
            `INSERT INTO automation_test_fixtures (id, automation_id, run_id, step_id, input_json)
             VALUES ($1, $2, $3, $4, $5::json)`,
            [id, automationId, runId, stepId, JSON.stringify(input ?? {})],
        );
        return { id };
    }

    async function getTestCase(automationId, caseId) {
        const { rows } = await q(`${CASE_SELECT} WHERE c.automation_id = $1 AND c.id = $2`, [automationId, caseId]);
        return rows[0] ? rowToTestCase(rows[0]) : null;
    }

    async function createTestCase({ automationId, stepId, name, inputKind, typedInput, fixtureId, expect, assertions, createdBy }) {
        const id = newId('tc_');
        const kind = inputKind === 'run' ? 'run' : 'typed';
        await q(
            `INSERT INTO automation_test_cases
                (id, automation_id, step_id, name, input_kind, typed_input_json, fixture_id, expect, assertions_json, created_by)
             VALUES ($1, $2, $3, $4, $5, $6::json, $7, $8, $9::json, $10)`,
            [id, automationId, stepId, name, kind,
                kind === 'typed' ? JSON.stringify(typedInput ?? {}) : null,
                kind === 'run' ? fixtureId ?? null : null,
                expect === 'error' ? 'error' : 'success',
                JSON.stringify(assertions ?? []), createdBy ?? null],
        );
        return getTestCase(automationId, id);
    }

    async function updateTestCase(automationId, caseId, patch = {}) {
        const { rows } = await q('SELECT fixture_id FROM automation_test_cases WHERE automation_id = $1 AND id = $2', [automationId, caseId]);
        if (!rows[0]) return null;
        const oldFixtureId = rows[0].fixture_id;
        const sets = [];
        const params = [automationId, caseId];
        const add = (sql, value) => { params.push(value); sets.push(sql.replace('?', `$${params.length}`)); };
        if (patch.name !== undefined) add('name = ?', patch.name);
        if (patch.expect !== undefined) add('expect = ?', patch.expect === 'error' ? 'error' : 'success');
        if (patch.assertions !== undefined) add('assertions_json = ?::json', JSON.stringify(patch.assertions));
        if (patch.inputKind !== undefined) {
            const kind = patch.inputKind === 'run' ? 'run' : 'typed';
            add('input_kind = ?', kind);
            if (kind === 'typed') {
                add('typed_input_json = ?::json', JSON.stringify(patch.typedInput ?? {}));
                sets.push('fixture_id = NULL');
            } else {
                sets.push('typed_input_json = NULL');
                add('fixture_id = ?', patch.fixtureId ?? null);
            }
        }
        if (sets.length) {
            await q(`UPDATE automation_test_cases SET ${sets.join(', ')}, updated_at = NOW() WHERE automation_id = $1 AND id = $2`, params);
        }
        // The replaced fixture goes with the swap, whichever way the input changed.
        if (patch.inputKind !== undefined && oldFixtureId) await dropFixture(oldFixtureId);
        return getTestCase(automationId, caseId);
    }

    async function deleteTestCase(automationId, caseId) {
        const { rows } = await q(
            'DELETE FROM automation_test_cases WHERE automation_id = $1 AND id = $2 RETURNING fixture_id',
            [automationId, caseId],
        );
        if (!rows[0]) return false;
        await dropFixture(rows[0].fixture_id);
        return true;
    }

    async function listTestCases(automationId, stepId) {
        const { rows } = stepId
            ? await q(`${CASE_SELECT} WHERE c.automation_id = $1 AND c.step_id = $2 ORDER BY c.created_at, c.id`, [automationId, stepId])
            : await q(`${CASE_SELECT} WHERE c.automation_id = $1 ORDER BY c.created_at, c.id`, [automationId]);
        return rows.map(rowToTestCase);
    }

    /**
     * What the runner feeds the code. The ONLY reader of a fixture's values.
     *
     * @returns {Promise<null | {kind:'typed', values:any} | {kind:'run', available:true, values:any, runId:string, fixtureId:string} | {kind:'run', available:false}>}
     */
    async function getTestCaseInput(automationId, caseId) {
        const { rows } = await q(
            `SELECT c.input_kind, c.typed_input_json, f.id AS fx_id, f.run_id AS fx_run_id, f.input_json AS fx_input
               FROM automation_test_cases c
               LEFT JOIN automation_test_fixtures f ON f.id = c.fixture_id
              WHERE c.automation_id = $1 AND c.id = $2`,
            [automationId, caseId],
        );
        const r = rows[0];
        if (!r) return null;
        if (r.input_kind === 'typed') return { kind: 'typed', values: fromJson(r.typed_input_json, {}) };
        if (!r.fx_id) return { kind: 'run', available: false };
        return { kind: 'run', available: true, values: fromJson(r.fx_input, {}), runId: r.fx_run_id, fixtureId: r.fx_id };
    }

    async function recordTestCaseResult(automationId, caseId, { status }) {
        await q('UPDATE automation_test_cases SET last_status = $3, last_run_at = NOW() WHERE automation_id = $1 AND id = $2',
            [automationId, caseId, status]);
    }

    async function countTestCases(automationId, stepId) {
        const { rows } = await q('SELECT COUNT(*)::int AS n FROM automation_test_cases WHERE automation_id = $1 AND step_id = $2',
            [automationId, stepId]);
        return Number(rows[0]?.n || 0);
    }

    return {
        createFixture, createTestCase, updateTestCase, deleteTestCase, listTestCases, getTestCase,
        getTestCaseInput, recordTestCaseResult, countTestCases,
    };
}

module.exports = { makeTestCases, rowToTestCase, newId, toIso, fromJson };
