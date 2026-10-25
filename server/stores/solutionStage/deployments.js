// @typecheck
/**
 * solution_deployments and solution_deployment_steps: one attempt to make a
 * stage run a release (or apply settings, or remove the stage), its lease and
 * its journal (design 1.1 C, 6.5-6.8).
 *
 * Status machine:
 *   awaiting_approval → approved | rejected | cancelled
 *   queued | approved → preparing → committing → converging → succeeded(_with_warnings)
 *   any in-flight     → compensating → failed
 *
 * Admission is EXCLUSIVE per stage: no row is admitted while an active or an
 * awaiting-approval row exists (one advisory-locked insert), so an approval
 * can never collide with the active index. The indexes stay as a backstop.
 */

'use strict';

const log = require('../../telemetry/log');
const { storeError } = require('../lib/storeError');
const { stageLockSql } = require('./stages');
const {
    ACTIVE_STATUSES, IN_FLIGHT_STATUSES, TERMINAL_STATUSES, ADMIT_STATUSES, DEFAULT_LEASE_MS, APPROVAL_REQUEST_GRACE_S, DECISION_STATUS, newDeploymentId, json, leaseMsOf, leaseUntil, mapDeployment, mapStep, busyError,
    busyRow, byRequestKey,
} = require('./deploymentModel');

/** Admission (exclusive insert) and plain row / history reads. */
function makeAdmissionReads(db, ready) {
    /**
     * A plain read of the (stage, request_key) row, or null: what the runner
     * uses to answer a repeated request without paging through the history.
     * @param {string} stageProjectId
     * @param {string} requestKey
     */
    async function getDeploymentByRequestKey(stageProjectId, requestKey) {
        await ready();
        return mapDeployment(await byRequestKey(db, stageProjectId, requestKey));
    }

    /**
     * Admit a deployment. One transaction under the stage's advisory lock:
     * the same (stage, request_key) answers the existing row `{replayed:true}`;
     * a stage that no longer exists (detached) refuses with 404
     * stage_not_found; an awaiting-approval row refuses with 409
     * approval_pending and an active row with 409 stage_busy {deploymentId},
     * whatever status the new row would get. A unique violation maps the same way (backstop).
     *
     * @param {{ solutionId: string, stageProjectId: string, stage: 'uat'|'prd', releaseId?: string|null,
     *   releaseSeq?: number|null, fromReleaseId?: string|null, kind: string, status: 'awaiting_approval'|'queued',
     *   settingsPatch?: object|null, plan: object, planHash: string, stageSettingsVersion: number,
     *   requestKey: string, requestedBy: string, approvalId?: string|null, acknowledgements?: any[] }} row
     */
    async function insertDeployment(row) {
        await ready();
        if (!ADMIT_STATUSES.includes(row?.status)) {
            throw new TypeError(`insertDeployment: a deployment is admitted as awaiting_approval or queued, not ${JSON.stringify(row?.status)}.`);
        }
        if (typeof row.requestKey !== 'string' || !row.requestKey) throw new TypeError('insertDeployment: requestKey is required.');
        try {
            return await db.tx(async (client) => {
                await client.query(stageLockSql, [row.stageProjectId]);
                const replay = await byRequestKey(client, row.stageProjectId, row.requestKey);
                if (replay) return { ...mapDeployment(replay), replayed: true };
                // Under the lock detachStage also takes: a stage detached since the
                // caller read it admits nothing (its project is an ordinary one now).
                const stage = (await client.query(
                    'SELECT 1 AS ok FROM solution_stages WHERE project_id = $1 AND solution_id = $2 AND stage = $3',
                    [row.stageProjectId, row.solutionId, row.stage],
                )).rows[0];
                if (!stage) throw storeError(404, 'stage_not_found', 'This stage does not exist.');
                const busy = await busyRow(client, row.stageProjectId);
                if (busy) throw busyError(busy);
                const r = await client.query(
                    `INSERT INTO solution_deployments (id, solution_id, stage_project_id, stage, release_id, release_seq,
                        from_release_id, kind, status, settings_patch, plan, plan_hash, stage_settings_version,
                        request_key, requested_by, approval_id, acknowledgements)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17::jsonb)
                     RETURNING *`,
                    [newDeploymentId(), row.solutionId, row.stageProjectId, row.stage, row.releaseId ?? null,
                        Number.isInteger(row.releaseSeq) ? row.releaseSeq : null, row.fromReleaseId ?? null,
                        row.kind, row.status, json(row.settingsPatch), JSON.stringify(row.plan ?? {}), row.planHash,
                        Number(row.stageSettingsVersion), row.requestKey, row.requestedBy, row.approvalId ?? null,
                        JSON.stringify(row.acknowledgements || [])],
                );
                return { ...mapDeployment(r.rows[0]), replayed: false };
            });
        } catch (err) {
            if (err?.code !== '23505') throw err;
            const replay = await byRequestKey(db, row.stageProjectId, row.requestKey);
            if (replay) return { ...mapDeployment(replay), replayed: true };
            const busy = await busyRow(db, row.stageProjectId);
            if (busy) throw busyError(busy);
            throw err;
        }
    }

    async function getDeployment(id, { client = null } = {}) {
        await ready();
        return mapDeployment((await (client || db).query('SELECT * FROM solution_deployments WHERE id = $1', [id])).rows[0]);
    }

    /**
     * A stage's history, newest first, without the plan. `before` is the id
     * of the last row of the previous page.
     *
     * @param {string} stageProjectId
     * @param {{ limit?: number, before?: string|null }} [opts]
     */
    async function listDeployments(stageProjectId, { limit = 20, before = null } = {}) {
        await ready();
        const cap = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const params = [stageProjectId, cap];
        let cursor = '';
        if (typeof before === 'string' && before) {
            params.push(before);
            cursor = `AND (d.created_at, d.id) < (SELECT created_at, id FROM solution_deployments WHERE id = $3)`;
        }
        const r = await db.query(
            `SELECT d.id, d.solution_id, d.stage_project_id, d.stage, d.release_id, d.release_seq, d.from_release_id,
                    d.kind, d.status, d.settings_patch, d.plan_hash, d.stage_settings_version, d.request_key,
                    d.requested_by, d.approval_id, d.acknowledgements, d.report, d.error, d.lease_owner,
                    d.lease_expires_at, d.created_at, d.started_at, d.committed_at, d.finished_at
               FROM solution_deployments d
              WHERE d.stage_project_id = $1 ${cursor}
              ORDER BY d.created_at DESC, d.id DESC LIMIT $2`,
            params,
        );
        return r.rows.map(mapDeployment);
    }

    return { insertDeployment, getDeployment, getDeploymentByRequestKey, listDeployments };
}

/** Claim, lease, heartbeat and status transitions. */
function makeLeases(db, ready) {
    /**
     * Take a queued or approved row: it moves to preparing under this worker's lease. One claimer wins.
     * @param {number} [leaseMs]
     */
    async function claimDeployment(id, workerId, leaseMs = DEFAULT_LEASE_MS) {
        await ready();
        const r = await db.query(
            `UPDATE solution_deployments
                SET status = 'preparing', lease_owner = $2, lease_expires_at = ${leaseUntil(3)},
                    started_at = COALESCE(started_at, NOW())
              WHERE id = $1 AND status IN ('queued', 'approved') RETURNING *`,
            [id, workerId, leaseMsOf(leaseMs)],
        );
        return mapDeployment(r.rows[0]);
    }

    /**
     * Re-lease a finished-with-warnings row into `converging`: the retry of the
     * convergence that left warnings (the runner's resumeStale converges
     * `converging` rows). Only `succeeded_with_warnings` moves; the finish
     * stamp and the old error go, the report stays. The stage's one-active
     * index refuses it with 409 stage_busy when another deployment has taken
     * the stage since. Null when the row is not in that status.
     * @param {number} [leaseMs]
     */
    async function retryConverge(id, workerId, leaseMs = DEFAULT_LEASE_MS) {
        await ready();
        try {
            const r = await db.query(
                `UPDATE solution_deployments
                    SET status = 'converging', lease_owner = $2, lease_expires_at = ${leaseUntil(3)},
                        finished_at = NULL, error = NULL
                  WHERE id = $1 AND status = 'succeeded_with_warnings' RETURNING *`,
                [id, workerId, leaseMsOf(leaseMs)],
            );
            return mapDeployment(r.rows[0]);
        } catch (err) {
            if (err?.code !== '23505') throw err;
            const row = (await db.query('SELECT stage_project_id FROM solution_deployments WHERE id = $1', [id])).rows[0];
            const busy = row ? await busyRow(db, row.stage_project_id) : null;
            if (busy) throw busyError(busy);
            throw err;
        }
    }

    /**
     * Take over an in-flight row whose lease ran out (a crashed worker). One
     * replica wins. A row without a lease is not taken: the store never puts
     * one in flight without a lease (claimDeployment, transitionDeployment).
     * @param {number} [leaseMs]
     */
    async function reclaimExpired(id, workerId, leaseMs = DEFAULT_LEASE_MS) {
        await ready();
        const r = await db.query(
            `UPDATE solution_deployments SET lease_owner = $2, lease_expires_at = ${leaseUntil(3)}
              WHERE id = $1 AND status = ANY($4::text[])
                AND lease_expires_at < NOW()
             RETURNING *`,
            [id, workerId, leaseMsOf(leaseMs), IN_FLIGHT_STATUSES],
        );
        return mapDeployment(r.rows[0]);
    }

    /**
     * Extend this worker's lease; false when it no longer holds the row.
     * @param {number} [leaseMs]
     */
    async function heartbeat(id, workerId, leaseMs = DEFAULT_LEASE_MS) {
        await ready();
        const r = await db.query(
            `UPDATE solution_deployments SET lease_expires_at = ${leaseUntil(3)}
              WHERE id = $1 AND lease_owner = $2 AND status = ANY($4::text[]) RETURNING id`,
            [id, workerId, leaseMsOf(leaseMs), IN_FLIGHT_STATUSES],
        );
        return r.rows.length > 0;
    }

    /**
     * Move a row from one of `fromStatuses` to `toStatus`, conditionally.
     * A terminal status sets finished_at and drops the lease. Patch:
     * `report`, `error` (JSON), `committed: true` (committed_at = NOW()),
     * `approvalId`, `plan` + `planHash`, `stageSettingsVersion`.
     * A move INTO an in-flight status needs a row that holds a lease (it was
     * claimed): an in-flight row without one could be reclaimed by nobody, or
     * by a second worker while the first still runs it.
     *
     * @returns {Promise<ReturnType<typeof mapDeployment>>} the row, or null when it was not in a from-status
     * @param {string} toStatus
     */
    async function transitionDeployment(id, fromStatuses, toStatus, patch = {}, { client = null } = {}) {
        await ready();
        const from = Array.isArray(fromStatuses) ? fromStatuses : [fromStatuses];
        const params = [id, from, toStatus];
        const set = ['status = $3'];
        /**
         * @param {string} expr
         * @param {string | number | null} value
         */
        const add = (expr, value) => { params.push(value); set.push(expr.replace('?', `$${params.length}`)); };
        if (patch.report !== undefined) add('report = ?::jsonb', json(patch.report));
        if (patch.error !== undefined) add('error = ?::jsonb', json(patch.error));
        if (patch.approvalId !== undefined) add('approval_id = ?', patch.approvalId);
        if (patch.plan !== undefined) add('plan = ?::jsonb', JSON.stringify(patch.plan));
        if (patch.planHash !== undefined) add('plan_hash = ?', patch.planHash);
        if (patch.stageSettingsVersion !== undefined) add('stage_settings_version = ?', Number(patch.stageSettingsVersion));
        if (patch.committed === true) set.push('committed_at = COALESCE(committed_at, NOW())');
        if (TERMINAL_STATUSES.includes(toStatus)) set.push('finished_at = NOW()', 'lease_owner = NULL', 'lease_expires_at = NULL');
        const leased = IN_FLIGHT_STATUSES.includes(toStatus) ? ' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL' : '';
        const r = await (client || db).query(
            `UPDATE solution_deployments SET ${set.join(', ')}
              WHERE id = $1 AND status = ANY($2::text[])${leased} RETURNING *`,
            params,
        );
        return mapDeployment(r.rows[0]);
    }

    /**
     * Rows a worker may claim (queued or approved), oldest first.
     * @param {Date} [now]
     */
    async function listClaimable(now = new Date(), { limit = 20 } = {}) {
        await ready();
        const r = await db.query(
            `SELECT * FROM solution_deployments WHERE status IN ('queued', 'approved') AND created_at <= $1
              ORDER BY created_at, id LIMIT $2`,
            [now, Math.min(Math.max(Number(limit) || 20, 1), 100)],
        );
        return r.rows.map(mapDeployment);
    }

    /**
     * In-flight rows whose lease ran out by `now`.
     * @param {Date} [now]
     */
    async function listExpiredLeases(now = new Date(), { limit = 20 } = {}) {
        await ready();
        const r = await db.query(
            `SELECT * FROM solution_deployments
              WHERE status = ANY($3::text[]) AND lease_expires_at < $1
              ORDER BY lease_expires_at, id LIMIT $2`,
            [now, Math.min(Math.max(Number(limit) || 20, 1), 100), IN_FLIGHT_STATUSES],
        );
        return r.rows.map(mapDeployment);
    }

    /**
     * Is `deploymentId` an active deployment of exactly this stage project?
     * The test behind every `managedWrite` capability.
     */
    async function isActiveDeployment(deploymentId, stageProjectId, client = null) {
        await ready();
        if (typeof deploymentId !== 'string' || !deploymentId || !stageProjectId) return false;
        const r = await (client || db).query(
            `SELECT 1 AS ok FROM solution_deployments
              WHERE id = $1 AND stage_project_id = $2 AND status = ANY($3::text[])`,
            [deploymentId, stageProjectId, ACTIVE_STATUSES],
        );
        return r.rows.length > 0;
    }

    return { claimDeployment, reclaimExpired, retryConverge, heartbeat, transitionDeployment, listClaimable, listExpiredLeases, isActiveDeployment };
}

/** Approval decisions applied to awaiting rows. */
function makeApprovals(db, ready) {
    /**
     * Apply an approval's final decision to its deployment, only out of
     * awaiting_approval: approved → approved, rejected → rejected, expired /
     * cancelled / withdrawn → cancelled. A pending approval changes nothing.
     * Only the approval LINKED to the row (approval_id, set by setApprovalId)
     * decides it: an approval without an id, or one that is not the row's own
     * (a stale or duplicate one, or any one before the link), moves nothing. A
     * decision that arrives before the link is applied by
     * reconcileAwaitingApprovals once the link exists; a link that never comes
     * cancels the row after 60 s.
     * Approving into a busy stage (a 23505 on the active index, unreachable
     * with exclusive admission) cancels the row with stage_busy_at_approval,
     * so it never stays open.
     *
     * @param {{ id?: string, status: string, deploymentId?: string|null, context?: { deploymentId?: string } }} approval
     * @returns {Promise<ReturnType<typeof mapDeployment>>} the row, or null when there was nothing to move
     */
    async function recordDeploymentDecision(approval) {
        await ready();
        const to = DECISION_STATUS[approval?.status];
        if (!to) return null;
        if (typeof approval.id !== 'string' || !approval.id) return null;
        const depId = approval.deploymentId || approval.context?.deploymentId || null;
        const params = [depId, approval.id, to, json(to === 'cancelled' ? { code: `approval_${approval.status}` } : null)];
        const match = 'approval_id = $2 AND ($1::text IS NULL OR id = $1)';
        const terminal = to === 'approved' ? '' : ', finished_at = NOW()';
        try {
            const r = await db.query(
                `UPDATE solution_deployments SET status = $3, error = COALESCE($4::jsonb, error)${terminal}
                  WHERE ${match} AND status = 'awaiting_approval' RETURNING *`,
                params,
            );
            return mapDeployment(r.rows[0]);
        } catch (err) {
            if (err?.code !== '23505') throw err;
            log.warn(`[solutionStageStore] approval for ${depId || approval.id} landed on a busy stage; cancelling`);
            const r = await db.query(
                `UPDATE solution_deployments SET status = 'cancelled', finished_at = NOW(),
                        error = '{"code":"stage_busy_at_approval"}'::jsonb
                  WHERE ${match} AND status = 'awaiting_approval' RETURNING *`,
                params.slice(0, 2),
            );
            return mapDeployment(r.rows[0]);
        }
    }

    /**
     * The runner's backstop for every awaiting_approval row: an approval no
     * longer pending has its outcome applied; a row whose approval was never
     * created (approval_id NULL) and that is older than 60 s is cancelled
     * (approval_request_failed). `getApproval(id)` is injected (automation/
     * owns approvals; a store may not require it).
     *
     * @param {{ getApproval: (approvalId: string) => Promise<{ id: string, status: string }|null> }} deps
     * @returns {Promise<{ checked: number, applied: number, cancelled: number }>}
     */
    async function reconcileAwaitingApprovals({ getApproval }) {
        await ready();
        const rows = (await db.query(
            `SELECT id, approval_id, created_at < NOW() - make_interval(secs => $1) AS stale
               FROM solution_deployments WHERE status = 'awaiting_approval' ORDER BY created_at LIMIT 200`,
            [APPROVAL_REQUEST_GRACE_S],
        )).rows;
        const out = { checked: rows.length, applied: 0, cancelled: 0 };
        for (const row of rows) {
            try {
                if (!row.approval_id) {
                    if (!row.stale) continue;
                    const r = await db.query(
                        `UPDATE solution_deployments SET status = 'cancelled', finished_at = NOW(),
                                error = '{"code":"approval_request_failed"}'::jsonb
                          WHERE id = $1 AND status = 'awaiting_approval' AND approval_id IS NULL RETURNING id`,
                        [row.id],
                    );
                    if (r.rows.length) out.cancelled++;
                    continue;
                }
                const approval = await getApproval(row.approval_id);
                const status = approval ? approval.status : 'cancelled';
                if (status === 'pending') continue;
                const moved = await recordDeploymentDecision({ id: row.approval_id, status, deploymentId: row.id });
                if (moved) out.applied++;
            } catch (err) {
                log.warn(`[solutionStageStore] reconcile of ${row.id} failed: ${/** @type {Error} */ (err)?.message}`);
            }
        }
        return out;
    }

    /** Cancel an awaiting_approval row directly (its approval is no longer pending). */
    async function closeAwaiting(id, actorId) {
        await ready();
        const r = await db.query(
            `UPDATE solution_deployments SET status = 'cancelled', finished_at = NOW(), error = $2::jsonb
              WHERE id = $1 AND status = 'awaiting_approval' RETURNING *`,
            [id, JSON.stringify({ code: 'cancelled', by: actorId || null })],
        );
        return mapDeployment(r.rows[0]);
    }

    /** Link the approval created for an awaiting row; once only. */
    async function setApprovalId(id, approvalId, { client = null } = {}) {
        await ready();
        const r = await (client || db).query(
            `UPDATE solution_deployments SET approval_id = $2
              WHERE id = $1 AND status = 'awaiting_approval' AND approval_id IS NULL RETURNING id`,
            [id, approvalId],
        );
        return r.rows.length > 0;
    }

    return { recordDeploymentDecision, reconcileAwaitingApprovals, closeAwaiting, setApprovalId };
}

/** The step journal of a deployment. */
function makeJournal(db, ready) {
    // ── Journal ─────────────────────────────────────────────────────────────
    // Ids, versions, hashes and counts only: never content.

    /**
     * Append a step; its seq is the next one of the deployment.
     * @param {string} deploymentId
     * @param {{ phase: 'prepare'|'commit'|'converge'|'compensate', action: string, ref?: string|null, kind?: string|null,
     *           status?: 'pending'|'done'|'skipped'|'failed', entityId?: string|null, before?: any, afterHash?: string|null, detail?: any }} step
     */
    async function appendStep(deploymentId, step, { client = null } = {}) {
        await ready();
        const r = await (client || db).query(
            `INSERT INTO solution_deployment_steps (deployment_id, seq, phase, ref, kind, action, status, entity_id,
                                                    before, after_hash, detail)
             SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb
               FROM solution_deployment_steps WHERE deployment_id = $1
             RETURNING *`,
            [deploymentId, step.phase, step.ref ?? null, step.kind ?? null, step.action, step.status || 'pending',
                step.entityId ?? null, json(step.before), step.afterHash ?? null, json(step.detail)],
        );
        return mapStep(r.rows[0]);
    }

    /** Update one step's status / entity / before / hash / detail. */
    async function updateStep(deploymentId, seq, patch = {}, { client = null } = {}) {
        await ready();
        const params = [deploymentId, Number(seq)];
        const set = ['updated_at = NOW()'];
        /**
         * @param {string} expr
         * @param {string | null} value
         */
        const add = (expr, value) => { params.push(value); set.push(expr.replace('?', `$${params.length}`)); };
        if (patch.status !== undefined) add('status = ?', patch.status);
        if (patch.entityId !== undefined) add('entity_id = ?', patch.entityId);
        if (patch.before !== undefined) add('before = ?::jsonb', json(patch.before));
        if (patch.afterHash !== undefined) add('after_hash = ?', patch.afterHash);
        if (patch.detail !== undefined) add('detail = ?::jsonb', json(patch.detail));
        const r = await (client || db).query(
            `UPDATE solution_deployment_steps SET ${set.join(', ')} WHERE deployment_id = $1 AND seq = $2 RETURNING *`,
            params,
        );
        return r.rows[0] ? mapStep(r.rows[0]) : null;
    }

    /** A deployment's journal in order, optionally one phase. */
    async function listSteps(deploymentId, { phase = null, client = null } = {}) {
        await ready();
        const r = await (client || db).query(
            `SELECT * FROM solution_deployment_steps WHERE deployment_id = $1 AND ($2::text IS NULL OR phase = $2)
              ORDER BY seq`,
            [deploymentId, phase],
        );
        return r.rows.map(mapStep);
    }

    return { appendStep, updateStep, listSteps };
}

/**
 * @param {{ query: Function, tx: Function }} db
 * @param {{ ready: () => Promise<unknown> }} ctx
 */
function makeDeploymentsStore(db, { ready }) {
    return {
        ...makeAdmissionReads(db, ready),
        ...makeLeases(db, ready),
        ...makeApprovals(db, ready),
        ...makeJournal(db, ready),
    };
}

module.exports = {
    makeDeploymentsStore, mapDeployment, ACTIVE_STATUSES, IN_FLIGHT_STATUSES, TERMINAL_STATUSES, DEFAULT_LEASE_MS,
};

/** @typedef {import('./deploymentModel').Queryable} Queryable */

/** @typedef {import('./deploymentModel').StageDb} StageDb */
