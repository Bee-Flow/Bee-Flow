// @typecheck
/**
 * solution_stages: one row per UAT / PRD stage of a Solution (design 1.1 C).
 *
 * A factory over `{ query, tx }` (see ../solutionStageStore.js for the DDL and
 * the facade). `ctx.projectStore()` gives createStageProject and detachStage,
 * which projectStore owns because they are the only writers of
 * `projects.stage` / `projects.stage_of`; both run on this file's transaction.
 */

'use strict';

const { storeError } = require('../lib/managedParts');

const STAGES = Object.freeze(['uat', 'prd']);

// The statuses that keep a stage busy: the active set plus an open approval request.
const BUSY_STATUSES = Object.freeze(['awaiting_approval', 'queued', 'approved', 'preparing',
    'committing', 'converging', 'compensating']);

/** The advisory-lock key every admission and detach of one stage takes. */
const stageLockSql = `SELECT pg_advisory_xact_lock(hashtext('solution_stage:' || $1::text))`;

/** A solution_stages row as the API speaks it. */
function mapStage(row) {
    if (!row) return null;
    return {
        projectId: row.project_id,
        solutionId: row.solution_id,
        stage: row.stage,
        organizationId: row.organization_id,
        runAsUserId: row.run_as_user_id,
        enabled: row.enabled === true,
        pausedState: row.paused_state ?? null,
        requiresApproval: row.requires_approval === true,
        approvalPolicy: row.approval_policy ?? null,
        rollbackNeedsApproval: row.rollback_needs_approval === true,
        newPartsActive: row.new_parts_active === true,
        currentReleaseId: row.current_release_id || null,
        currentReleaseSeq: row.current_release_seq ?? null,
        previousReleaseId: row.previous_release_id || null,
        settingsVersion: Number(row.settings_version),
        bindingsPending: row.bindings_pending === true,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// What updateStageSettings may write: key → [column, is JSON].
const SETTINGS_COLUMNS = Object.freeze({
    enabled: ['enabled', false],
    requiresApproval: ['requires_approval', false],
    approvalPolicy: ['approval_policy', true],
    rollbackNeedsApproval: ['rollback_needs_approval', false],
    newPartsActive: ['new_parts_active', false],
});

const jsonOrNull = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

// A project whose kind is unset or only guessed holds no content check yet.
const kindUnsettled = (row) => row.kind == null || row.kind_guessed === true;

/**
 * @param {{ query: Function, tx: Function }} db
 * @param {{ ready: () => Promise<unknown>, projectStore: () => any, valuesMemo?: Map<string, unknown> }} ctx
 */
function makeStagesStore(db, { ready, projectStore, valuesMemo = new Map() }) {
    /**
     * A legacy Dev (kind unset or guessed) becomes a Solution here. A Solution
     * holds no chats (kindChange SOLUTION_HOLDS_NO_CHATS), so one that holds
     * conversations or team chats is refused, as PUT /:id/kind refuses it. The
     * registry kinds and project files (projects/kindChange.refusedContent) are
     * the route's check: a store may not require projects/.
     */
    async function assertNoChatHoldings(devId) {
        const row = (await db.query('SELECT kind, kind_guessed FROM projects WHERE id = $1', [devId])).rows[0];
        if (!row || !kindUnsettled(row)) return;
        const held = await projectStore().countChatHoldings(devId);
        if ((Number(held?.conversations) || 0) > 0 || (Number(held?.teamChats) || 0) > 0) {
            throw storeError(409, 'kind_holds_other_content',
                'This project holds conversations or team chats, which a Solution cannot hold. Move them out first.',
                { conversations: Number(held?.conversations) || 0, teamChats: Number(held?.teamChats) || 0 });
        }
    }

    /**
     * Create the stages of a Solution, idempotently per stage, in one
     * transaction. The Dev project must belong to an organisation (409
     * stages_need_org), may not be a stage itself and may not be a workspace
     * (a GUESSED workspace may: the guess is what this corrects). Fixes the Dev
     * kind ('solution', no longer a guess), so it cannot be reclassified under
     * its stages; a legacy Dev that holds chats is refused (409
     * kind_holds_other_content). The run-as user is the Dev owner; new parts
     * start active on UAT and inactive on PRD.
     *
     * @param {{ devProject: { id: string }|string, stages: Array<'uat'|'prd'>, actorId: string }} args
     * @returns {Promise<Array<ReturnType<typeof mapStage> & { created: boolean }>>}
     */
    async function createStages({ devProject, stages, actorId }) {
        await ready();
        const devId = typeof devProject === 'string' ? devProject : devProject?.id;
        if (!devId) throw new TypeError('createStages: devProject is required.');
        /** @type {string[]} */
        const wanted = [...new Set(Array.isArray(stages) ? stages : [])];
        if (!wanted.length || wanted.some((s) => !STAGES.includes(s))) {
            throw storeError(400, 'stage_invalid', "A stage is 'uat' or 'prd'.");
        }
        if (typeof actorId !== 'string' || !actorId) throw new TypeError('createStages: actorId is required.');
        // Outside the transaction: the counts read other stores' tables, and a
        // missing one (42P01) would abort the transaction.
        await assertNoChatHoldings(devId);
        return db.tx(async (client) => {
            const dev = (await client.query('SELECT * FROM projects WHERE id = $1 FOR UPDATE', [devId])).rows[0];
            if (!dev) throw storeError(404, 'project_not_found', 'This Solution does not exist.');
            if (dev.stage_of) throw storeError(409, 'stage_project', 'A stage cannot have stages of its own.');
            if (dev.kind === 'workspace' && dev.kind_guessed !== true) {
                throw storeError(409, 'not_a_solution', 'Only a Solution has stages.');
            }
            if (!dev.organization_id) {
                throw storeError(409, 'stages_need_org', 'Stages need the Solution to belong to an organisation.');
            }
            await client.query(
                `UPDATE projects SET kind = 'solution', kind_guessed = FALSE, updated_at = NOW()
                  WHERE id = $1 AND (kind IS DISTINCT FROM 'solution' OR kind_guessed)`,
                [devId],
            );
            const out = [];
            for (const stage of STAGES.filter((s) => wanted.includes(s))) {
                const existing = (await client.query(
                    'SELECT * FROM solution_stages WHERE solution_id = $1 AND stage = $2', [devId, stage],
                )).rows[0];
                if (existing) { out.push({ ...mapStage(existing), created: false }); continue; }
                const project = await projectStore().createStageProject(client, {
                    devProject: { id: dev.id, name: dev.name, organizationId: dev.organization_id, color: dev.color, icon: dev.icon },
                    stage: /** @type {'uat'|'prd'} */ (stage),
                    ownerId: dev.owner_id,
                });
                const row = (await client.query(
                    `INSERT INTO solution_stages (project_id, solution_id, stage, organization_id, run_as_user_id,
                                                  new_parts_active, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                    [project.id, devId, stage, dev.organization_id, dev.owner_id, stage === 'uat', actorId],
                )).rows[0];
                out.push({ ...mapStage(row), created: true });
            }
            return out;
        });
    }

    /** One stage by its stage project id, or null. */
    async function getStage(stageProjectId, { client = null } = {}) {
        await ready();
        const q = client || db;
        return mapStage((await q.query('SELECT * FROM solution_stages WHERE project_id = $1', [stageProjectId])).rows[0]);
    }

    /** The UAT or PRD stage of a Solution, or null. */
    async function getStageFor(solutionId, stage) {
        await ready();
        return mapStage((await db.query(
            'SELECT * FROM solution_stages WHERE solution_id = $1 AND stage = $2', [solutionId, stage],
        )).rows[0]);
    }

    /** Every stage of a Solution, UAT first. */
    async function listStages(solutionId) {
        await ready();
        const r = await db.query(
            `SELECT * FROM solution_stages WHERE solution_id = $1
              ORDER BY CASE stage WHEN 'uat' THEN 0 ELSE 1 END`,
            [solutionId],
        );
        return r.rows.map(mapStage);
    }

    /**
     * A settings write, as a compare-and-swap on settings_version: 409
     * settings_stale when the stage moved on, 404 when it is gone. Bumps the
     * version, so a deployment admitted on the old settings fails its commit CAS.
     *
     * @param {string} stageProjectId
     * @param {number} expectedVersion
     * @param {Partial<Record<keyof typeof SETTINGS_COLUMNS, any>>} patch
     * @param {{ client?: any }} [opts]
     */
    async function updateStageSettings(stageProjectId, expectedVersion, patch = {}, { client = null } = {}) {
        await ready();
        const q = client || db;
        const set = [];
        /** @type {any[]} */
        const params = [stageProjectId, Number(expectedVersion)];
        for (const [key, value] of Object.entries(patch || {})) {
            if (value === undefined) continue;
            if (!Object.prototype.hasOwnProperty.call(SETTINGS_COLUMNS, key)) {
                throw storeError(400, 'unknown_field', `"${key}" is not a stage setting.`);
            }
            const [col, isJson] = SETTINGS_COLUMNS[key];
            params.push(isJson ? jsonOrNull(value) : !!value);
            set.push(`${col} = $${params.length}${isJson ? '::jsonb' : ''}`);
        }
        const r = await q.query(
            `UPDATE solution_stages SET ${[...set, 'settings_version = settings_version + 1', 'updated_at = NOW()'].join(', ')}
              WHERE project_id = $1 AND settings_version = $2 RETURNING *`,
            params,
        );
        if (r.rows[0]) return mapStage(r.rows[0]);
        const current = await getStage(stageProjectId, { client });
        if (!current) throw storeError(404, 'stage_not_found', 'This stage does not exist.');
        throw storeError(409, 'settings_stale', 'The stage settings changed in the meantime. Reload and try again.',
            { settingsVersion: current.settingsVersion });
    }

    /**
     * The commit's pointer move: the stage now runs `releaseId`. The release it
     * ran before becomes previous_release_id (unless it is the same release, a
     * redeploy), and pending bindings are applied by this deploy. With
     * `expectedReleaseId` / `expectedSettingsVersion` it is a CAS and answers
     * null when the stage moved on.
     *
     * @param {{ query: Function }|null} client  the commit's transaction
     * @param {{ stageProjectId: string, releaseId: string, releaseSeq?: number|null,
     *           expectedReleaseId?: string|null, expectedSettingsVersion?: number }} args
     */
    async function setCurrentRelease(client, { stageProjectId, releaseId, releaseSeq = null, expectedReleaseId, expectedSettingsVersion }) {
        await ready();
        const q = client || db;
        const params = [stageProjectId, releaseId, Number.isInteger(releaseSeq) ? releaseSeq : null];
        const where = ['project_id = $1'];
        if (expectedReleaseId !== undefined) {
            params.push(expectedReleaseId);
            where.push(`current_release_id IS NOT DISTINCT FROM $${params.length}`);
        }
        if (expectedSettingsVersion !== undefined) {
            params.push(Number(expectedSettingsVersion));
            where.push(`settings_version = $${params.length}`);
        }
        const r = await q.query(
            `UPDATE solution_stages
                SET previous_release_id = CASE WHEN current_release_id IS DISTINCT FROM $2
                                               THEN current_release_id ELSE previous_release_id END,
                    current_release_id = $2, current_release_seq = $3,
                    bindings_pending = FALSE, updated_at = NOW()
              WHERE ${where.join(' AND ')} RETURNING *`,
            params,
        );
        // The release carries the variable declarations a stage run reads.
        valuesMemo.delete(stageProjectId);
        return mapStage(r.rows[0]);
    }

    /**
     * Pause (a `pausedState` object: which parts were on) or resume (null).
     * Pausing switches `enabled` off, resuming on. A settings write: it bumps
     * settings_version, conditionally on `expectedVersion` when given.
     *
     * @param {string} stageProjectId
     * @param {object|null} pausedState
     * @param {{ client?: any, expectedVersion?: number }} [opts]
     */
    async function setPausedState(stageProjectId, pausedState, { client = null, expectedVersion } = {}) {
        await ready();
        const q = client || db;
        /** @type {any[]} */
        const params = [stageProjectId, jsonOrNull(pausedState), pausedState == null];
        let cas = '';
        if (expectedVersion !== undefined) { params.push(Number(expectedVersion)); cas = ` AND settings_version = $${params.length}`; }
        const r = await q.query(
            `UPDATE solution_stages SET paused_state = $2::jsonb, enabled = $3,
                    settings_version = settings_version + 1, updated_at = NOW()
              WHERE project_id = $1${cas} RETURNING *`,
            params,
        );
        if (r.rows[0]) return mapStage(r.rows[0]);
        if (expectedVersion !== undefined && await getStage(stageProjectId, { client })) {
            throw storeError(409, 'settings_stale', 'The stage settings changed in the meantime. Reload and try again.');
        }
        return null;
    }

    /**
     * The escape hatch (design 5.4): the stage stops being a stage. Refused
     * with 409 stage_busy while a deployment is active or awaiting approval.
     * Otherwise, in one transaction: the solution_stages row, its bindings,
     * variable values and stamps go, and projectStore.detachStage clears the
     * project's stage columns. Deployment history stays. The parts become
     * ordinary unmanaged parts; the stage can be created again (a new project).
     *
     * @param {string} stageProjectId
     * @param {string} actorId
     * @returns {Promise<{ projectId: string, solutionId: string, stage: string }>}
     */
    async function detachStage(stageProjectId, actorId) {
        await ready();
        return db.tx(async (client) => {
            await client.query(stageLockSql, [stageProjectId]);
            const busy = (await client.query(
                `SELECT id FROM solution_deployments WHERE stage_project_id = $1 AND status = ANY($2::text[])
                  ORDER BY created_at LIMIT 1`,
                [stageProjectId, BUSY_STATUSES],
            )).rows[0];
            if (busy) {
                throw storeError(409, 'stage_busy', 'A deployment to this stage is running or awaiting approval.',
                    { deploymentId: busy.id });
            }
            const gone = (await client.query(
                'DELETE FROM solution_stages WHERE project_id = $1 RETURNING solution_id, stage', [stageProjectId],
            )).rows[0];
            const wasStage = await projectStore().detachStage(stageProjectId, { client, actorId });
            if (!gone && !wasStage) throw storeError(404, 'stage_not_found', 'This stage does not exist.');
            await client.query('DELETE FROM solution_bindings WHERE project_id = $1', [stageProjectId]);
            await client.query('DELETE FROM solution_variable_values WHERE project_id = $1', [stageProjectId]);
            valuesMemo.delete(stageProjectId);
            const stamps = (await client.query(`SELECT to_regclass('project_solution_entities') IS NOT NULL AS ok`)).rows[0];
            if (stamps?.ok) await client.query('DELETE FROM project_solution_entities WHERE project_id = $1', [stageProjectId]);
            return { projectId: stageProjectId, solutionId: gone?.solution_id ?? null, stage: gone?.stage ?? null };
        });
    }

    /**
     * The rows of a stage that is being REMOVED (not detached), on the caller's
     * transaction: its bindings, variable values, stamps and the solution_stages
     * row. Deployments stay (the removal's own row is among them). The caller
     * holds the stage lock and has moved the parts; no busy check happens here,
     * because the removal deployment itself is the active one.
     *
     * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
     * @param {string} stageProjectId
     * @returns {Promise<boolean>} whether a solution_stages row was deleted
     */
    async function removeStageRows(client, stageProjectId) {
        await client.query('DELETE FROM solution_bindings WHERE project_id = $1', [stageProjectId]);
        await client.query('DELETE FROM solution_variable_values WHERE project_id = $1', [stageProjectId]);
        valuesMemo.delete(stageProjectId);
        const stamps = (await client.query(`SELECT to_regclass('project_solution_entities') IS NOT NULL AS ok`)).rows[0];
        if (stamps?.ok) await client.query('DELETE FROM project_solution_entities WHERE project_id = $1', [stageProjectId]);
        const gone = await client.query('DELETE FROM solution_stages WHERE project_id = $1 RETURNING project_id', [stageProjectId]);
        return gone.rows.length > 0;
    }

    /**
     * The stages a user holds up: they are its run-as user or own its project.
     * Their account may not be deleted or moved out of the organisation while
     * these exist.
     *
     * @param {string} userId
     */
    async function runAsStagesFor(userId) {
        await ready();
        if (typeof userId !== 'string' || !userId) return [];
        const r = await db.query(
            `SELECT s.* FROM solution_stages s
               LEFT JOIN projects p ON p.id = s.project_id
              WHERE s.run_as_user_id = $1 OR p.owner_id = $1
              ORDER BY s.solution_id, s.stage`,
            [userId],
        );
        return r.rows.map(mapStage);
    }

    return {
        createStages, getStage, getStageFor, listStages, updateStageSettings,
        setCurrentRelease, setPausedState, detachStage, removeStageRows, runAsStagesFor,
    };
}

module.exports = { makeStagesStore, mapStage, STAGES, BUSY_STATUSES, stageLockSql };
