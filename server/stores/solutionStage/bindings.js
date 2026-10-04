// @typecheck
/**
 * solution_bindings: a project's answer to a hole a release leaves (design
 * 4.1): a connection, approver seats, an out-of-bundle table or KB, a page
 * slug, a mirror source, an integration grant or a document. Per target
 * project (a stage project, or a gallery-installed project).
 *
 * A binding is written INTO a locked definition at prepare, so changing one
 * after a deploy marks the stage `bindings_pending`; the next redeploy applies
 * it (setCurrentRelease clears the mark).
 *
 * This store writes what it is given: the slot grammar and the value checks
 * (another stage's part, a connection the run-as may not use, seat validity)
 * belong to the binding validator of the caller.
 */

'use strict';

const { storeError } = require('../lib/managedParts');

const BINDING_KINDS = Object.freeze(['connection', 'approver_seats', 'table', 'knowledge_base',
    'webpage_slug', 'mirror_source', 'integration_grant', 'document']);
const MAX_SLOT_LENGTH = 300;

function mapBinding(row) {
    return {
        slot: row.slot,
        kind: row.kind,
        value: row.value,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
    };
}

/**
 * @param {{ query: Function, tx: Function }} db
 * @param {{ ready: () => Promise<unknown> }} ctx
 */
function makeBindingsStore(db, { ready }) {
    /** Every binding of a project, by slot. */
    async function listBindings(projectId, { client = null } = {}) {
        await ready();
        const r = await (client || db).query(
            'SELECT * FROM solution_bindings WHERE project_id = $1 ORDER BY slot', [projectId],
        );
        return r.rows.map(mapBinding);
    }

    /**
     * Write bindings in one transaction; a row with `value: null` deletes its
     * slot. Answers the project's bindings afterwards.
     *
     * @param {string} projectId
     * @param {Array<{ slot: string, kind?: string, value: any }>} rows
     * @param {string} actorId
     * @param {{ client?: any }} [opts]  run on the caller's transaction instead
     */
    async function upsertBindings(projectId, rows, actorId, { client = null } = {}) {
        await ready();
        const list = Array.isArray(rows) ? rows : [];
        for (const row of list) {
            if (typeof row?.slot !== 'string' || !row.slot || row.slot.length > MAX_SLOT_LENGTH) {
                throw storeError(400, 'binding_invalid', 'A binding needs a slot.', { slot: row?.slot ?? null, why: 'slot' });
            }
            if (row.value !== null && row.value !== undefined && !BINDING_KINDS.includes(/** @type {string} */ (row.kind))) {
                throw storeError(400, 'binding_invalid', `"${row.kind}" is not a binding kind.`, { slot: row.slot, why: 'kind' });
            }
        }
        if (typeof actorId !== 'string' || !actorId) throw new TypeError('upsertBindings: actorId is required.');
        const write = async (q) => {
            for (const row of list) {
                if (row.value === null || row.value === undefined) {
                    await q.query('DELETE FROM solution_bindings WHERE project_id = $1 AND slot = $2', [projectId, row.slot]);
                    continue;
                }
                await q.query(
                    `INSERT INTO solution_bindings (project_id, slot, kind, value, updated_by)
                     VALUES ($1, $2, $3, $4::jsonb, $5)
                     ON CONFLICT (project_id, slot) DO UPDATE
                        SET kind = EXCLUDED.kind, value = EXCLUDED.value,
                            updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
                    [projectId, row.slot, row.kind, JSON.stringify(row.value), actorId],
                );
            }
            return listBindings(projectId, { client: q });
        };
        return client ? write(client) : db.tx(write);
    }

    /** Mark (or clear) that a stage's bindings or steering values changed since its last deploy. */
    async function setBindingsPending(stageProjectId, pending = true, { client = null } = {}) {
        await ready();
        const r = await (client || db).query(
            `UPDATE solution_stages SET bindings_pending = $2, updated_at = NOW()
              WHERE project_id = $1 RETURNING project_id`,
            [stageProjectId, !!pending],
        );
        return r.rows.length > 0;
    }

    return { listBindings, upsertBindings, setBindingsPending };
}

module.exports = { makeBindingsStore, BINDING_KINDS };
