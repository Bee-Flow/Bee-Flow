// @typecheck
/**
 * stores/project/stageLink.js — Solution stages (UAT / PRD) on the projects
 * row: the cached stage lookup, the stage-bound refusal, and the only
 * writers of `stage`/`stage_of` (createStageProject, detachStage). The
 * stage write guard itself is stores/lib/managedParts.js. Split out of
 * stores/projectStore.js; built per store by makeProjectStore, so each
 * store keeps its own stage cache.
 */

const crypto = require('crypto');
const { storeError } = require('../lib/storeError');
const { mapProjectRow } = require('./rows');

// How long a POSITIVE stageOfProject answer is trusted. A negative one for an
// existing row is kept for the process lifetime: a project never becomes a
// stage later (only createStageProject sets the columns, on a new row). A
// positive one can end through detachStage on another replica, so it expires,
// and a refusal re-reads uncached anyway (stores/lib/managedParts.js).
const STAGE_POSITIVE_TTL_MS = 10_000;
// A bound on the negative entries, so a long-lived process does not keep one
// per project it ever looked at. Overflow clears the map; it refills on demand.
const STAGE_CACHE_MAX = 50_000;

const STAGE_LABEL = Object.freeze({ uat: 'UAT', prd: 'Production' });

/**
 * @param {{
 *   run: (sql: string, params?: any[]) => Promise<any>,
 *   getOne: (sql: string, params?: any[]) => Promise<any>,
 *   getAll: (sql: string, params?: any[]) => Promise<any[]>,
 *   getClient: () => Promise<any>,
 *   initDB: () => Promise<unknown>,
 * }} ctx  the store's db facade and schema init (built by makeProjectStore)
 */
function makeStageLinkFns({ run, getOne, initDB }) {
    // ── Solution stages ──────────────────────────────────────────────────

    // projectId → { value: null|StageOf, expiresAt: number } (Infinity for a negative).
    const stageCache = new Map();

    function mapStageOf(row) {
        return row && row.stage_of && (row.stage === 'uat' || row.stage === 'prd')
            ? { solutionId: row.stage_of, stage: row.stage, projectId: row.id }
            : null;
    }

    /**
     * The stage a project is, read uncached: null for every project that is
     * not a stage (and for one that does not exist).
     *
     * @param {string} projectId
     * @returns {Promise<{ solutionId: string, stage: 'uat'|'prd', projectId: string }|null>}
     */
    async function stageOfProjectFresh(projectId) {
        await initDB();
        if (typeof projectId !== 'string' || !projectId) return null;
        const row = await getOne('SELECT id, stage, stage_of FROM projects WHERE id = $1', [projectId]);
        const value = mapStageOf(row);
        if (row) {
            if (stageCache.size >= STAGE_CACHE_MAX) stageCache.clear();
            stageCache.set(projectId, { value, expiresAt: value ? Date.now() + STAGE_POSITIVE_TTL_MS : Infinity });
        } else {
            stageCache.delete(projectId);
        }
        return value;
    }

    /**
     * `stageOfProjectFresh` behind the cache (a negative for an existing row
     * for good, a positive for 10 s). A guard that would REFUSE re-reads with
     * the fresh variant first, so a detach elsewhere is never refused on.
     *
     * @param {string} projectId
     */
    async function stageOfProject(projectId) {
        const hit = typeof projectId === 'string' ? stageCache.get(projectId) : undefined;
        if (hit && hit.expiresAt > Date.now()) return hit.value;
        return stageOfProjectFresh(projectId);
    }

    /**
     * Refuse a whole-project change (kind, owner) on a stage project and on a
     * Dev project that has stages: 409 stage_project / solution_has_stages.
     * @param {string} projectId
     */
    async function refuseStageBound(projectId) {
        const row = await getOne(
            `SELECT p.stage_of,
                    EXISTS (SELECT 1 FROM projects s WHERE s.stage_of = p.id) AS has_stages
               FROM projects p WHERE p.id = $1`,
            [projectId]
        );
        if (!row) return;
        if (row.stage_of) {
            throw storeError(409, 'stage_project', 'This project is a stage of a Solution. Change the Solution in Dev.',
                { solutionId: row.stage_of });
        }
        let hasStages = row.has_stages === true;
        if (!hasStages) {
            try {
                hasStages = !!(await getOne('SELECT 1 AS x FROM solution_stages WHERE solution_id = $1 LIMIT 1', [projectId]));
            } catch (err) {
                if (err?.code !== '42P01') throw err;
            }
        }
        if (hasStages) {
            throw storeError(409, 'solution_has_stages', 'This Solution has stages. Detach or remove them first.',
                { solutionId: projectId });
        }
    }

    /**
     * Create the projects row of a stage: the ONLY writer of `stage` and
     * `stage_of`. Runs on the caller's transaction (solutionStageStore.createStages).
     * Kind 'solution', named "<Dev> (UAT)" / "<Dev> (Production)", in the Dev
     * project's organisation, owned by `ownerId` (the run-as user).
     *
     * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }|null} client
     * @param {{ devProject: { id: string, name: string, organizationId?: string, organization_id?: string, color?: string, icon?: string },
     *           stage: 'uat'|'prd', ownerId: string }} args
     */
    async function createStageProject(client, { devProject, stage, ownerId }) {
        await initDB();
        if (stage !== 'uat' && stage !== 'prd') throw new TypeError(`createStageProject: stage is 'uat' or 'prd', not ${JSON.stringify(stage)}.`);
        if (!devProject || !devProject.id) throw new TypeError('createStageProject: devProject is required.');
        if (typeof ownerId !== 'string' || !ownerId) throw new TypeError('createStageProject: ownerId is required.');
        const orgId = devProject.organizationId ?? devProject.organization_id ?? '';
        const id = crypto.randomUUID();
        const q = client ? (sql, params) => client.query(sql, params) : run;
        const { rows } = await q(
            `INSERT INTO projects (id, name, description, color, icon, owner_id, organization_id, kind, stage, stage_of)
             VALUES ($1, $2, '', $3, $4, $5, $6, 'solution', $7, $8)
             RETURNING *`,
            [id, `${devProject.name} (${STAGE_LABEL[stage]})`, devProject.color || '#6366f1', devProject.icon || '📁',
                ownerId, orgId || '', stage, devProject.id]
        );
        return mapProjectRow(rows[0]);
    }

    /**
     * The escape hatch: make a stage project an ordinary Solution again. The
     * only writer that clears `stage`/`stage_of`. Logs `stage_detached` on the
     * project, on the same client, so the audit row commits with it.
     *
     * @param {string} projectId
     * @param {{ client?: { query: Function }|null, actorId?: string|null }} [opts]
     * @returns {Promise<boolean>} true when the project was a stage
     */
    async function detachStage(projectId, { client = null, actorId = null } = {}) {
        await initDB();
        const q = client ? (sql, params) => client.query(sql, params) : run;
        const { rows } = await q(
            `WITH old AS (
                 SELECT id, stage, stage_of FROM projects WHERE id = $1 AND stage_of IS NOT NULL FOR UPDATE
             )
             UPDATE projects p SET stage = NULL, stage_of = NULL, updated_at = NOW()
               FROM old WHERE p.id = old.id
             RETURNING old.stage, old.stage_of`,
            [projectId]
        );
        stageCache.delete(projectId);
        if (!rows || !rows.length) return false;
        if (actorId) {
            await q(
                `INSERT INTO project_activity (id, project_id, actor_id, action, target_type, target_id, details)
                 VALUES ($1, $2, $3, 'stage_detached', 'project', $4, $5)`,
                [crypto.randomUUID(), projectId, actorId, rows[0].stage_of,
                    JSON.stringify({ stage: rows[0].stage, solutionId: rows[0].stage_of })]
            );
        }
        return true;
    }

    return {
        stageOfProject,
        stageOfProjectFresh,
        refuseStageBound,
        createStageProject,
        detachStage,
    };
}

module.exports = { makeStageLinkFns };
