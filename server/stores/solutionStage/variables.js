// @typecheck
/**
 * Solution variables (design 4.2) and part options.
 *
 * - solution_variables: the declarations, per Solution (the Dev project id);
 *   a release carries them.
 * - solution_variable_values: the value per project (Dev, UAT, PRD). `value`
 *   is what the operator last entered, `applied_value` what runs. A
 *   non-steering value is written to both at once; a STEERING value (D18: it
 *   steers where credentials or mail go) is written to `value` only, marks the
 *   stage `bindings_pending`, and goes live through a redeploy, whose commit
 *   calls applySteeringValues (and in PRD with the gate on, passes approval).
 * - solution_part_options: what travels for a table or KB (reference rows,
 *   shell or carried content), decided in Dev.
 *
 * `variableValuesFor` is what a run reads: the typed applied values of the
 * declared names, memoised 30 s per project and dropped in-process on a write
 * (a resumed run may read values up to 30 s old; a variable is not a lock).
 *
 * Declarations: Dev (and any project that is not a stage) reads its own
 * solution_variables. A STAGE reads the declarations of the release it runs
 * (manifest.solution.variables of solution_stages.current_release_id), never
 * the Dev table, so a Dev edit (a removed name, a changed type or choice)
 * reaches a stage only through a deploy. Deviation from design 1.1 C, which
 * has no per-stage declarations: the release is that copy.
 *
 * Steering (D18): a stage write treats a name as steering when the caller says
 * so, OR the Dev declaration or the current release marks it steering, OR its
 * type there is url/email. The caller's list can only add to that.
 */

'use strict';

const { storeError } = require('../lib/managedParts');

const VARIABLE_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const VARIABLE_TYPES = Object.freeze(['text', 'number', 'boolean', 'url', 'email', 'choice']);
const VALUES_MEMO_MS = 30_000;
const VALUES_MEMO_MAX = 5_000;
const STEERING_TYPES = Object.freeze(['url', 'email']);

// The declarations of the release a stage runs, as rows (name, type, choices,
// steering, ord). $1 is the stage project id. Only for a stage, and only once
// project_releases exists (blueprintStore owns it).
const RELEASE_DECLS_SQL = `
    SELECT e.d->>'name' AS name, COALESCE(e.d->>'type', 'text') AS type, e.d->'choices' AS choices,
           (e.d->'steering') = 'true'::jsonb AS steering, e.ord
      FROM solution_stages s
      JOIN project_releases r ON r.id = s.current_release_id
     CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(r.manifest->'solution'->'variables') = 'array'
                THEN r.manifest->'solution'->'variables' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(d, ord)
     WHERE s.project_id = $1 AND jsonb_typeof(e.d) = 'object' AND jsonb_typeof(e.d->'name') = 'string'`;

const hasReleases = async (q) => (await q.query(`SELECT to_regclass('project_releases') IS NOT NULL AS ok`)).rows[0]?.ok === true;
const stageOfRow = async (q, projectId) => (await q.query('SELECT stage_of FROM projects WHERE id = $1', [projectId])).rows[0]?.stage_of || null;

function mapVariable(row) {
    return {
        name: row.name,
        type: row.type,
        choices: row.choices ?? null,
        description: row.description || '',
        required: row.required === true,
        steering: row.steering === true,
        position: Number(row.position) || 0,
    };
}

function mapPartOption(row) {
    return { ref: row.ref, kind: row.kind, options: row.options || {}, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

const nameError = (name) => storeError(400, 'variable_name_invalid',
    'A variable name starts with a lowercase letter and holds lowercase letters, digits and underscores (at most 63).',
    { name: typeof name === 'string' ? name.slice(0, 80) : null });

/**
 * A stored value as its declared type, or undefined when it does not fit.
 * @param {string} type
 * @param {any} value
 * @param {any} choices
 */
function coerceValue(type, value, choices) {
    if (value === null || value === undefined) return undefined;
    if (type === 'number') {
        const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
        return Number.isFinite(n) ? n : undefined;
    }
    if (type === 'boolean') {
        if (value === true || value === 'true' || value === 1) return true;
        if (value === false || value === 'false' || value === 0) return false;
        return undefined;
    }
    if (typeof value === 'object') return undefined;
    const s = String(value);
    if (type === 'choice' && Array.isArray(choices) && choices.length) {
        const allowed = choices.map((c) => (c && typeof c === 'object' ? String(c.value) : String(c)));
        return allowed.includes(s) ? s : undefined;
    }
    return s;
}

/** `{name: value}` or `[{name, value}]` → `[{name, value}]`. */
function entriesOf(values) {
    if (Array.isArray(values)) return values.map((v) => ({ name: v?.name, value: v?.value }));
    return Object.entries(values || {}).map(([name, value]) => ({ name, value }));
}

/**
 * @param {{ query: Function, tx: Function }} db
 * @param {{ ready: () => Promise<unknown>, valuesMemo?: Map<string, any> }} ctx
 */
function makeVariablesStore(db, { ready, valuesMemo = new Map() }) {
    /** projectId → { at, values }; shared with stages.js, which drops it when the release pointer moves. */
    const memo = valuesMemo;

    /**
     * The names that are steering for a write to `projectId`, beyond the
     * caller's: for a stage, those the Dev declarations or the current release
     * mark steering or type url/email. Empty for a project that is not a stage
     * (Dev values are not gated).
     * @returns {Promise<Set<string>>}
     */
    async function declaredSteering(q, projectId) {
        const solutionId = await stageOfRow(q, projectId);
        if (!solutionId) return new Set();
        const names = (await q.query(
            `SELECT name FROM solution_variables
              WHERE solution_id = $1 AND (steering OR type = ANY($2::text[]))`,
            [solutionId, STEERING_TYPES],
        )).rows.map((r) => r.name);
        if (await hasReleases(q)) {
            const rel = (await q.query(`SELECT name, type, steering FROM (${RELEASE_DECLS_SQL}) d`, [projectId])).rows;
            for (const r of rel) if (r.steering === true || STEERING_TYPES.includes(r.type)) names.push(r.name);
        }
        return new Set(names);
    }

    /** A Solution's declarations, in order. */
    async function listVariables(solutionId, { client = null } = {}) {
        await ready();
        const r = await (client || db).query(
            'SELECT * FROM solution_variables WHERE solution_id = $1 ORDER BY position, name', [solutionId],
        );
        return r.rows.map(mapVariable);
    }

    /**
     * Replace a Solution's declarations with `decls` (in that order). Only the
     * name is checked here; type, choices and the rules of 4.2 belong to the caller.
     *
     * @param {string} solutionId
     * @param {Array<{ name: string, type?: string, choices?: any, description?: string, required?: boolean, steering?: boolean }>} decls
     */
    async function replaceVariables(solutionId, decls, { client = null } = {}) {
        await ready();
        const list = Array.isArray(decls) ? decls : [];
        for (const d of list) if (typeof d?.name !== 'string' || !VARIABLE_NAME_RE.test(d.name)) throw nameError(d?.name);
        const write = async (q) => {
            await q.query(
                'DELETE FROM solution_variables WHERE solution_id = $1 AND NOT (name = ANY($2::text[]))',
                [solutionId, list.map((d) => d.name)],
            );
            for (const [i, d] of list.entries()) {
                await q.query(
                    `INSERT INTO solution_variables (solution_id, name, type, choices, description, required, steering, position)
                     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
                     ON CONFLICT (solution_id, name) DO UPDATE
                        SET type = EXCLUDED.type, choices = EXCLUDED.choices, description = EXCLUDED.description,
                            required = EXCLUDED.required, steering = EXCLUDED.steering, position = EXCLUDED.position`,
                    [solutionId, d.name, d.type || 'text', d.choices == null ? null : JSON.stringify(d.choices),
                        d.description || '', d.required !== false, d.steering === true, i],
                );
            }
            return listVariables(solutionId, { client: q });
        };
        const out = client ? await write(client) : await db.tx(write);
        memo.clear();
        return out;
    }

    /**
     * Write a project's values. A non-steering name writes `value` and
     * `applied_value` (live at once); a steering name (in `steeringNames`, or
     * declared steering for a stage: see declaredSteering) writes `value` only
     * and marks the stage bindings_pending. `null` deletes a non-steering
     * value; for a steering name it is a draft too: `value` becomes JSON null,
     * the applied value keeps running, and applySteeringValues removes the row
     * at the next commit. A steering draft that never went live just goes.
     *
     * @param {string} projectId
     * @param {Record<string, any>|Array<{ name: string, value: any }>} values
     * @param {string} actorId
     * @param {{ steeringNames?: string[], client?: any }} [opts]
     * @returns {Promise<{ written: number, pending: boolean }>}
     */
    async function setVariableValues(projectId, values, actorId, { steeringNames = [], client = null } = {}) {
        await ready();
        if (typeof actorId !== 'string' || !actorId) throw new TypeError('setVariableValues: actorId is required.');
        const list = entriesOf(values);
        for (const { name } of list) if (typeof name !== 'string' || !VARIABLE_NAME_RE.test(name)) throw nameError(name);
        const write = async (q) => {
            const steering = new Set([...(steeringNames || []), ...(await declaredSteering(q, projectId))]);
            let pending = false;
            for (const { name, value } of list) {
                const isSteering = steering.has(name);
                if (value === null || value === undefined) {
                    if (isSteering) {
                        const cleared = await q.query(
                            `UPDATE solution_variable_values SET value = 'null'::jsonb, updated_by = $3, updated_at = NOW()
                              WHERE project_id = $1 AND name = $2 AND applied_value IS NOT NULL RETURNING name`,
                            [projectId, name, actorId],
                        );
                        if (cleared.rows.length) { pending = true; continue; }
                        // Nothing live: the draft alone goes.
                        await q.query(
                            'DELETE FROM solution_variable_values WHERE project_id = $1 AND name = $2 AND applied_value IS NULL',
                            [projectId, name],
                        );
                        continue;
                    }
                    await q.query('DELETE FROM solution_variable_values WHERE project_id = $1 AND name = $2', [projectId, name]);
                    continue;
                }
                await q.query(
                    `INSERT INTO solution_variable_values (project_id, name, value, applied_value, updated_by)
                     VALUES ($1, $2, $3::jsonb, CASE WHEN $4 THEN NULL ELSE $3::jsonb END, $5)
                     ON CONFLICT (project_id, name) DO UPDATE
                        SET value = EXCLUDED.value,
                            applied_value = CASE WHEN $4 THEN solution_variable_values.applied_value
                                                 ELSE EXCLUDED.value END,
                            updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
                    [projectId, name, JSON.stringify(value), isSteering, actorId],
                );
                if (isSteering) pending = true;
            }
            if (pending) {
                await q.query(
                    'UPDATE solution_stages SET bindings_pending = TRUE, updated_at = NOW() WHERE project_id = $1', [projectId],
                );
            }
            return { written: list.length, pending };
        };
        const out = client ? await write(client) : await db.tx(write);
        memo.delete(projectId);
        return out;
    }

    /**
     * The commit's step for steering values: every entered value goes live,
     * and a cleared one (value JSON null) goes.
     * @param {{ query: Function }} client  the commit's transaction
     * @param {string} projectId
     * @returns {Promise<number>} how many values changed
     */
    async function applySteeringValues(client, projectId) {
        await ready();
        const q = client || db;
        const removed = await q.query(
            `DELETE FROM solution_variable_values WHERE project_id = $1 AND jsonb_typeof(value) = 'null' RETURNING name`,
            [projectId],
        );
        const r = await q.query(
            `UPDATE solution_variable_values SET applied_value = value, updated_at = NOW()
              WHERE project_id = $1 AND applied_value IS DISTINCT FROM value RETURNING name`,
            [projectId],
        );
        memo.delete(projectId);
        return removed.rows.length + r.rows.length;
    }

    /**
     * The values a run of this project sees: `{ name: typed applied value }`
     * for each name declared and applied. The declarations are the project's
     * own for Dev, and those of the release it runs for a stage (a stage that
     * runs no release yet answers `{}`). A project with no declarations
     * (most) answers `{}`.
     *
     * @param {string} projectId
     * @returns {Promise<Record<string, string|number|boolean>>}
     */
    async function variableValuesFor(projectId) {
        await ready();
        if (typeof projectId !== 'string' || !projectId) return {};
        const hit = memo.get(projectId);
        if (hit && Date.now() - hit.at < VALUES_MEMO_MS) return { ...hit.values };
        let rows;
        try {
            const stageOf = await stageOfRow(db, projectId);
            if (!stageOf) {
                rows = (await db.query(
                    `SELECT v.name, v.type, v.choices, val.applied_value
                       FROM solution_variables v
                       JOIN solution_variable_values val ON val.project_id = $1 AND val.name = v.name
                      WHERE v.solution_id = $1 AND val.applied_value IS NOT NULL
                      ORDER BY v.position, v.name`,
                    [projectId],
                )).rows;
            } else {
                rows = (await db.query(
                    `SELECT DISTINCT ON (d.name) d.name, d.type, d.choices, d.ord, val.applied_value
                       FROM (${RELEASE_DECLS_SQL}) d
                       JOIN solution_variable_values val ON val.project_id = $1 AND val.name = d.name
                      WHERE val.applied_value IS NOT NULL
                      ORDER BY d.name, d.ord`,
                    [projectId],
                )).rows.sort((a, b) => Number(a.ord) - Number(b.ord));
            }
        } catch (err) {
            if (err?.code === '42P01') return {};
            throw err;
        }
        /** @type {Record<string, any>} */
        const values = {};
        for (const row of rows) {
            const v = coerceValue(row.type, row.applied_value, row.choices);
            if (v !== undefined) values[row.name] = v;
        }
        if (memo.size >= VALUES_MEMO_MAX) memo.clear();
        memo.set(projectId, { at: Date.now(), values });
        return { ...values };
    }

    /** A project's entered values as stored, with what runs next to them (the settings screen). */
    async function listVariableValues(projectId) {
        await ready();
        const r = await db.query(
            'SELECT name, value, applied_value, updated_by, updated_at FROM solution_variable_values WHERE project_id = $1 ORDER BY name',
            [projectId],
        );
        return r.rows.map((row) => ({
            name: row.name, value: row.value, appliedValue: row.applied_value ?? null,
            updatedBy: row.updated_by, updatedAt: row.updated_at,
        }));
    }

    // ── Part options ────────────────────────────────────────────────────────

    /** With `ref`: that part's options or null; without: every part option of the Solution. */
    async function getPartOptions(solutionId, { ref = null, client = null } = {}) {
        await ready();
        const q = client || db;
        if (ref) {
            const r = await q.query('SELECT * FROM solution_part_options WHERE solution_id = $1 AND ref = $2', [solutionId, ref]);
            return r.rows[0] ? mapPartOption(r.rows[0]) : null;
        }
        const r = await q.query('SELECT * FROM solution_part_options WHERE solution_id = $1 ORDER BY ref', [solutionId]);
        return r.rows.map(mapPartOption);
    }

    /**
     * Set one part's options (a whole replace): datatable `{reference, acks}`,
     * KB `{contentMode: 'shell'|'carry', acks}`.
     * @param {string} solutionId
     * @param {{ ref: string, kind: string, options: object }} part
     * @param {string} actorId
     */
    async function setPartOption(solutionId, { ref, kind, options }, actorId, { client = null } = {}) {
        await ready();
        if (typeof ref !== 'string' || !ref || typeof kind !== 'string' || !kind) {
            throw storeError(400, 'part_option_invalid', 'A part option needs a ref and a kind.');
        }
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
            throw storeError(400, 'part_option_invalid', 'Part options are an object.');
        }
        const r = await (client || db).query(
            `INSERT INTO solution_part_options (solution_id, ref, kind, options, updated_by)
             VALUES ($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT (solution_id, ref) DO UPDATE
                SET kind = EXCLUDED.kind, options = EXCLUDED.options, updated_by = EXCLUDED.updated_by, updated_at = NOW()
             RETURNING *`,
            [solutionId, ref, kind, JSON.stringify(options), actorId],
        );
        return mapPartOption(r.rows[0]);
    }

    return {
        listVariables, replaceVariables, setVariableValues, applySteeringValues, variableValuesFor,
        listVariableValues, getPartOptions, setPartOption,
    };
}

module.exports = { makeVariablesStore, coerceValue, VARIABLE_NAME_RE, VARIABLE_TYPES };
