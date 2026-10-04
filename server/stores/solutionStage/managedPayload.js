// @typecheck
/**
 * What a part GET says about the stage that manages it (design 5.3): every
 * builder route adds `managed: null | {solutionId, solutionName, stage,
 * releaseSeq, devRef}` from here, so the client never derives it and no part
 * route needs to require projects/.
 *
 * The identity path: the stage's stamp (project_solution_entities, owned by
 * blueprintStore) gives the part's ref, and the Solution's ref ledger
 * (solution_part_refs, blueprintStore) gives the Dev part behind that ref.
 * Either table may not exist yet on an install (42P01): `devRef` is then null.
 */

'use strict';

const UNDEFINED_TABLE = '42P01';

/** Run a read that may hit a table another store has not created yet. */
async function tolerant(fn) {
    try {
        return await fn();
    } catch (err) {
        if (err?.code === UNDEFINED_TABLE) return null;
        throw err;
    }
}

/**
 * @param {{ query: Function }} db
 * @param {{ ready: () => Promise<unknown> }} ctx
 */
function makeManagedPayloadStore(db, { ready }) {
    /**
     * @param {{ projectId?: string|null, kind: string, entityId?: string|null }} part
     *        `kind` as the stamps name it ('automation', 'app', 'webpage', 'datatable', 'agent', 'knowledge_base', ...)
     * @returns {Promise<null|{ solutionId: string, solutionName: string|null, stage: 'uat'|'prd',
     *           releaseSeq: number|null, devRef: { kind: string, id: string }|null }>}
     */
    async function managedPayloadFor({ projectId, kind, entityId }) {
        await ready();
        if (typeof projectId !== 'string' || !projectId) return null;
        const stage = await tolerant(async () => (await db.query(
            `SELECT s.solution_id, s.stage, s.current_release_seq, p.name AS solution_name
               FROM solution_stages s LEFT JOIN projects p ON p.id = s.solution_id
              WHERE s.project_id = $1`,
            [projectId],
        )).rows[0] || null);
        if (!stage) return null;
        let devRef = null;
        if (typeof entityId === 'string' && entityId && kind) {
            const stamp = await tolerant(async () => (await db.query(
                'SELECT ref FROM project_solution_entities WHERE project_id = $1 AND kind = $2 AND entity_id = $3 LIMIT 1',
                [projectId, kind, entityId],
            )).rows[0] || null);
            if (stamp?.ref) {
                const ledger = await tolerant(async () => (await db.query(
                    'SELECT entity_id FROM solution_part_refs WHERE solution_id = $1 AND ref = $2 LIMIT 1',
                    [stage.solution_id, stamp.ref],
                )).rows[0] || null);
                if (ledger?.entity_id) devRef = { kind, id: ledger.entity_id };
            }
        }
        return {
            solutionId: stage.solution_id,
            solutionName: stage.solution_name ?? null,
            stage: stage.stage,
            releaseSeq: stage.current_release_seq ?? null,
            devRef,
        };
    }

    /**
     * The stage project a knowledge base belongs to: stamped into a stage, or
     * listed on a stage project's knowledge_base_ids. With its ref and the
     * content mode the Solution chose for it (solution_part_options; default
     * 'shell'). Null when no stage holds it. The managed-write guard reads it
     * (stores/lib/managedParts.js managedInfoForKb).
     *
     * @param {string} kbId
     * @returns {Promise<null|{ stageProjectId: string, solutionId: string, ref: string|null, contentMode: 'shell'|'carry' }>}
     */
    async function kbStageInfo(kbId) {
        await ready();
        if (typeof kbId !== 'string' || !kbId) return null;
        const stamped = await tolerant(async () => (await db.query(
            `SELECT pse.project_id, pse.ref, p.stage_of
               FROM project_solution_entities pse JOIN projects p ON p.id = pse.project_id
              WHERE pse.kind = 'knowledge_base' AND pse.entity_id = $1 AND p.stage_of IS NOT NULL
              ORDER BY pse.created_at LIMIT 1`,
            [kbId],
        )).rows[0] || null);
        const hit = stamped || (await db.query(
            `SELECT id AS project_id, NULL::text AS ref, stage_of FROM projects
              WHERE stage_of IS NOT NULL AND knowledge_base_ids @> jsonb_build_array($1::text)
              ORDER BY created_at LIMIT 1`,
            [kbId],
        )).rows[0];
        if (!hit) return null;
        /** @type {'shell'|'carry'} */
        let contentMode = 'shell';
        if (hit.ref) {
            const opt = await tolerant(async () => (await db.query(
                'SELECT options FROM solution_part_options WHERE solution_id = $1 AND ref = $2', [hit.stage_of, hit.ref],
            )).rows[0] || null);
            if (opt?.options?.contentMode === 'carry') contentMode = 'carry';
        }
        return { stageProjectId: hit.project_id, solutionId: hit.stage_of, ref: hit.ref || null, contentMode };
    }

    return { managedPayloadFor, kbStageInfo };
}

module.exports = { makeManagedPayloadStore };
