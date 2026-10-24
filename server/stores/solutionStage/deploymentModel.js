// @typecheck
'use strict';
/** Constants, row mappers and small SQL helpers of the deployments store (see deployments.js). */

const crypto = require('crypto');
const { storeError } = require('../lib/storeError');

const ACTIVE_STATUSES = Object.freeze(['queued', 'approved', 'preparing', 'committing', 'converging', 'compensating']);
const IN_FLIGHT_STATUSES = Object.freeze(['preparing', 'committing', 'converging', 'compensating']);
const TERMINAL_STATUSES = Object.freeze(['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'rejected']);
const ADMIT_STATUSES = Object.freeze(['awaiting_approval', 'queued']);
const DEFAULT_LEASE_MS = 120_000;
// An awaiting row whose approval was never created is given up after this long.
const APPROVAL_REQUEST_GRACE_S = 60;

// An approval's final status → the deployment status it leads to.
const DECISION_STATUS = Object.freeze({
    approved: 'approved', rejected: 'rejected',
    expired: 'cancelled', cancelled: 'cancelled', withdrawn: 'cancelled',
});

const newDeploymentId = () => `dep_${crypto.randomBytes(8).toString('hex')}`;
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const leaseMsOf = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? Math.floor(Number(ms)) : DEFAULT_LEASE_MS);
// NOW() + a lease of $n milliseconds.
const leaseUntil = (n) => `NOW() + make_interval(secs => $${n}::double precision / 1000.0)`;

/** A solution_deployments row as the API speaks it. */
function mapDeployment(row) {
    if (!row) return null;
    return {
        id: row.id,
        solutionId: row.solution_id,
        stageProjectId: row.stage_project_id,
        stage: row.stage,
        releaseId: row.release_id || null,
        releaseSeq: row.release_seq ?? null,
        fromReleaseId: row.from_release_id || null,
        kind: row.kind,
        status: row.status,
        settingsPatch: row.settings_patch ?? null,
        ...(row.plan !== undefined ? { plan: row.plan } : {}),
        planHash: row.plan_hash,
        stageSettingsVersion: Number(row.stage_settings_version),
        requestKey: row.request_key,
        requestedBy: row.requested_by,
        approvalId: row.approval_id || null,
        acknowledgements: row.acknowledgements || [],
        report: row.report ?? null,
        error: row.error ?? null,
        leaseOwner: row.lease_owner || null,
        leaseExpiresAt: row.lease_expires_at || null,
        createdAt: row.created_at,
        startedAt: row.started_at || null,
        committedAt: row.committed_at || null,
        finishedAt: row.finished_at || null,
    };
}

function mapStep(row) {
    return {
        deploymentId: row.deployment_id,
        seq: Number(row.seq),
        phase: row.phase,
        ref: row.ref || null,
        kind: row.kind || null,
        action: row.action,
        status: row.status,
        entityId: row.entity_id || null,
        before: row.before ?? null,
        afterHash: row.after_hash || null,
        detail: row.detail ?? null,
        updatedAt: row.updated_at,
    };
}

const busyError = (row) => (row.status === 'awaiting_approval'
    ? storeError(409, 'approval_pending', 'A deployment to this stage is awaiting approval.', { deploymentId: row.id })
    : storeError(409, 'stage_busy', 'A deployment to this stage is already running.', { deploymentId: row.id }));

const busyRow = async (q, stageProjectId) => (await q.query(
    `SELECT id, status FROM solution_deployments
      WHERE stage_project_id = $1 AND status = ANY($2::text[])
      ORDER BY CASE status WHEN 'awaiting_approval' THEN 0 ELSE 1 END, created_at LIMIT 1`,
    [stageProjectId, ['awaiting_approval', ...ACTIVE_STATUSES]],
)).rows[0] || null;

const byRequestKey = async (q, stageProjectId, requestKey) => (await q.query(
    'SELECT * FROM solution_deployments WHERE stage_project_id = $1 AND request_key = $2',
    [stageProjectId, requestKey],
)).rows[0] || null;

module.exports = {
    ACTIVE_STATUSES, IN_FLIGHT_STATUSES, TERMINAL_STATUSES, ADMIT_STATUSES, DEFAULT_LEASE_MS, APPROVAL_REQUEST_GRACE_S, DECISION_STATUS, newDeploymentId, json, leaseMsOf, leaseUntil, mapDeployment, mapStep, busyError, busyRow, byRequestKey,
};
