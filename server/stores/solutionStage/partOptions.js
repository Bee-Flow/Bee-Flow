// @typecheck strict
/**
 * Part options of a Solution (`solution_part_options`): what travels for a
 * table or a knowledge base (reference rows, shell or carried content),
 * decided in Dev. Composed into the variables store (stores/solutionStage/variables.js).
 */

'use strict';

const { storeError } = require('../lib/storeError');

/** @typedef {import('./deploymentModel').Queryable} Queryable */

/** @param {import('pg').QueryResultRow} row */
function mapPartOption(row) {
    return { ref: row.ref, kind: row.kind, options: row.options || {}, updatedBy: row.updated_by, updatedAt: row.updated_at };
}

/**
 * @param {Queryable} db
 * @param {() => Promise<unknown>} ready  the schema init the store waits for
 */
function makePartOptionsStore(db, ready) {
    /**
     * With `ref`: that part's options or null; without: every part option of the Solution.
     * @param {string} solutionId
     * @param {{ ref?: string | null, client?: Queryable | null }} [opts]
     */
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
     * @param {{ client?: Queryable | null }} [opts]
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

    return { getPartOptions, setPartOption };
}

module.exports = { makePartOptionsStore };
