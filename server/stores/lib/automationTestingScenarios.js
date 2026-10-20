// @typecheck
/**
 * Form scenarios: the answers of a finished run, kept under a name so the
 * form pages of a dry run can be answered the same way again.
 *
 * `answers_json` = {v:1, trigger: object|null, pages: {[formPageStepId]:
 * {[fieldName]: value}}, skipped: [{stepId, field, reason}]}. The answers are
 * personal data of whoever filled the form: a list read never carries them
 * (the summary is computed here and the values dropped), and only
 * `getFormScenario` returns them.
 */

'use strict';

const { storeError } = require('./storeError');
const { newId, toIso, fromJson } = require('./automationTestingCases');

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The row without its answers: names, counts and what was left out. */
function rowToScenario(r) {
    const answers = fromJson(r.answers_json, {});
    const pages = isObject(answers.pages) ? answers.pages : {};
    return {
        id: r.id,
        automationId: r.automation_id,
        sourceRunId: r.source_run_id,
        name: r.name,
        createdBy: r.created_by ?? null,
        createdAt: toIso(r.created_at),
        hasTriggerAnswers: isObject(answers.trigger),
        pages: Object.entries(pages).map(([stepId, fields]) => ({ stepId, fieldCount: isObject(fields) ? Object.keys(fields).length : 0 })),
        skipped: (Array.isArray(answers.skipped) ? answers.skipped : [])
            .map((s) => ({ stepId: s?.stepId ?? null, field: s?.field ?? null, reason: s?.reason ?? null })),
    };
}

const isUniqueViolation = (e) => e && (e.code === '23505' || /duplicate key|unique constraint/i.test(String(e.message || '')));
const nameTaken = () => storeError(409, 'scenario_name_taken', 'A scenario with this name already exists.');

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number|null }> }} db
 * @param {() => Promise<void>} ready
 */
function makeScenarios(db, ready) {
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };

    async function createFormScenario({ automationId, sourceRunId, name, answers, createdBy }) {
        try {
            const { rows } = await q(
                `INSERT INTO automation_form_scenarios (id, automation_id, source_run_id, name, answers_json, created_by)
                 VALUES ($1, $2, $3, $4, $5::json, $6) RETURNING *`,
                [newId('fsc_'), automationId, sourceRunId, name, JSON.stringify(answers), createdBy ?? null],
            );
            return rowToScenario(rows[0]);
        } catch (e) {
            if (isUniqueViolation(e)) throw nameTaken();
            throw e;
        }
    }

    async function listFormScenarios(automationId) {
        const { rows } = await q('SELECT * FROM automation_form_scenarios WHERE automation_id = $1 ORDER BY created_at DESC, id', [automationId]);
        return rows.map(rowToScenario);
    }

    async function getFormScenario(automationId, scenarioId) {
        const { rows } = await q('SELECT * FROM automation_form_scenarios WHERE automation_id = $1 AND id = $2', [automationId, scenarioId]);
        if (!rows[0]) return null;
        return { ...rowToScenario(rows[0]), answers: fromJson(rows[0].answers_json, {}) };
    }

    async function renameFormScenario(automationId, scenarioId, name) {
        try {
            const { rows } = await q(
                'UPDATE automation_form_scenarios SET name = $3 WHERE automation_id = $1 AND id = $2 RETURNING *',
                [automationId, scenarioId, name],
            );
            return rows[0] ? rowToScenario(rows[0]) : null;
        } catch (e) {
            if (isUniqueViolation(e)) throw nameTaken();
            throw e;
        }
    }

    async function deleteFormScenario(automationId, scenarioId) {
        const { rows } = await q('DELETE FROM automation_form_scenarios WHERE automation_id = $1 AND id = $2 RETURNING id', [automationId, scenarioId]);
        return rows.length > 0;
    }

    async function countFormScenarios(automationId) {
        const { rows } = await q('SELECT COUNT(*)::int AS n FROM automation_form_scenarios WHERE automation_id = $1', [automationId]);
        return Number(rows[0]?.n || 0);
    }

    return { createFormScenario, listFormScenarios, getFormScenario, renameFormScenario, deleteFormScenario, countFormScenarios };
}

module.exports = { makeScenarios, rowToScenario };
