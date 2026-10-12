'use strict';
/**
 * Deployment routes (design 8, 6): ask for a deployment (202, the runner does
 * the work), read the history, read one deployment, cancel one that has not
 * started, retry one that did not finish.
 *
 * Reading is scoped to the stages the caller holds a role on: a stage editor
 * or viewer sees the history of THEIR stage, the Solution owner sees both.
 * A deployment is shown through an allow-list (no request key, no lease), and
 * `plan.differsFromUat` (PRD's own settings next to UAT's) only to someone who
 * holds a role on both stages.
 */

const crypto = require('crypto');
const express = require('express');
const { validate } = require('../../../core/http/validate');
const { HttpError, notFound } = require('../../../core/http/errors');
const log = require('../../../telemetry/log');
const S = require('./stageSchemas');
const { gate, authMw, deploymentView, logOn, isObject } = require('./stageRoutes');

/** Steps as a caller reads them: the journal's ids and statuses, not the pre-state. */
function stepView(step) {
    return {
        seq: step.seq, phase: step.phase, ref: step.ref ?? null, kind: step.kind ?? null, action: step.action,
        status: step.status, entityId: step.entityId ?? null, detail: step.detail ?? null, updatedAt: step.updatedAt ?? null,
    };
}

const encodeCursor = (map) => Buffer.from(JSON.stringify(map), 'utf8').toString('base64url');
function decodeCursor(text) {
    if (!text) return {};
    try {
        const v = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
        if (!isObject(v)) throw new Error('shape');
        return v;
    } catch {
        throw new HttpError(400, 'cursor_invalid', 'cursor is the nextCursor of the previous page.');
    }
}

const byNewest = (a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

function makeDeploymentRouter(d) {
    const router = express.Router({ mergeParams: true });
    const packaging = gate(d, 'blueprint_packaging');

    /** The deployment a request names, inside this Solution, or 404. */
    async function deploymentOf(ctx, id) {
        const row = await d.stageStore.getDeployment(id);
        if (!row || row.solutionId !== ctx.dev.id) throw notFound('deployment_not_found', 'That deployment does not exist.');
        return row;
    }

    /** Requester, or the Solution owner: the only people who steer a deployment that exists. */
    function assertSteersDeployment(ctx, row) {
        if (row.requestedBy === ctx.userId || ctx.isSolutionOwner) return;
        // A Dev role (or none) holds nothing on the stage: for them the deployment does not exist.
        if (!ctx.stageRoles[row.stage]) throw notFound('deployment_not_found', 'That deployment does not exist.');
        throw new HttpError(403, 'insufficient_permissions', 'Only the person who asked for this deployment, or the Solution owner, can do that.');
    }

    /** POST /:id/stages/:stage/deployments */
    router.post('/:id/stages/:stage/deployments', packaging, authMw(d, { stage: 'owner' }), validate({ body: S.DeployBody }), async (req, res) => {
        const { dev, stage, userId } = req.stageCtx;
        const b = req.body;
        if (b.kind !== 'redeploy' && !b.releaseId) throw new HttpError(400, 'release_required', 'Choose the release to deploy.');
        const out = await d.runner.admit({
            solutionId: dev.id, stage: stage.stage, releaseId: b.releaseId || null, kind: b.kind, planHash: b.planHash,
            requestKey: b.requestKey, acknowledgements: b.acknowledgements, actor: { id: userId },
        });
        if (!out.replayed) {
            await logOn(d, stage.projectId, userId, 'deployment_requested', {
                targetType: 'deployment', targetId: out.deployment.id, kind: b.kind, releaseSeq: out.deployment.releaseSeq ?? null,
                ...(b.note ? { note: b.note.slice(0, 500) } : {}),
            });
        }
        res.status(202).json({ deployment: deploymentView(out.deployment), replayed: out.replayed === true });
    });

    /** GET /:id/deployments?stage=&cursor=&limit= */
    router.get('/:id/deployments', gate(d, 'projects'), authMw(d, { dev: 'viewer', anyStage: 'viewer' }), validate({ query: S.DeploymentsQuery }), async (req, res) => {
        const ctx = req.stageCtx;
        const limit = req.query.limit || 20;
        const rows = (await d.stageStore.listStages(ctx.dev.id)).filter(r => ctx.stageRoles[r.stage]);
        const wanted = req.query.stage ? rows.filter(r => r.stage === req.query.stage) : rows;
        if (req.query.stage && !wanted.length) throw notFound();
        const cursor = decodeCursor(req.query.cursor);

        const fetched = await Promise.all(wanted.map(async (row) => ({
            row,
            list: await d.stageStore.listDeployments(row.projectId, { limit: Math.min(limit + 1, 100), before: typeof cursor[row.stage] === 'string' ? cursor[row.stage] : null }),
        })));
        const merged = fetched.flatMap(f => f.list).sort(byNewest);
        const page = merged.slice(0, limit);
        const more = merged.length > limit || fetched.some(f => f.list.length >= 100);
        let nextCursor = null;
        if (more && page.length) {
            const next = { ...cursor };
            for (const { row } of fetched) {
                const last = [...page].reverse().find(p => p.stageProjectId === row.projectId);
                if (last) next[row.stage] = last.id;
            }
            nextCursor = encodeCursor(next);
        }
        res.json({ deployments: page.map(deploymentView), nextCursor });
    });

    /** GET /:id/deployments/:depId */
    router.get('/:id/deployments/:depId', gate(d, 'projects'), authMw(d, { dev: 'viewer', anyStage: 'viewer' }), async (req, res) => {
        const ctx = req.stageCtx;
        const row = await deploymentOf(ctx, req.params.depId);
        // Their stage, or no such deployment.
        if (!ctx.stageRoles[row.stage]) throw notFound('deployment_not_found', 'That deployment does not exist.');
        const [steps, state] = await Promise.all([
            d.stageStore.listSteps(row.id),
            d.approvalGate.approvalStateFor(row, {}).catch((err) => {
                log.warn(`[stages] approval state of ${row.id} not read: ${err && err.message}`);
                return { state: 'unknown', approvalId: row.approvalId || null };
            }),
        ]);
        let plan = isObject(row.plan) ? { ...row.plan } : null;
        if (plan && !(ctx.stageRoles.uat && ctx.stageRoles.prd)) delete plan.differsFromUat;
        res.json({
            deployment: { ...deploymentView(row), plan },
            steps: steps.map(stepView),
            approval: state.approvalId ? { id: state.approvalId, status: state.state, decidedAt: state.decidedAt ?? null } : null,
        });
    });

    /** POST /:id/deployments/:depId/cancel: withdraw the approval, then close the row. */
    router.post('/:id/deployments/:depId/cancel', packaging, authMw(d, { dev: 'viewer', anyStage: 'viewer', orgAdmin: true }), validate({ body: S.EmptyBody }), async (req, res) => {
        const ctx = req.stageCtx;
        const row = await deploymentOf(ctx, req.params.depId);
        assertSteersDeployment(ctx, row);
        const notCancellable = () => new HttpError(409, 'deployment_not_cancellable', 'This deployment can no longer be cancelled.', { status: row.status });

        if (row.status === 'awaiting_approval') {
            if (row.approvalId) {
                const approval = await d.getApproval(row.approvalId);
                if (approval && approval.status === 'pending') {
                    // Hands the deployment its outcome through the store (recordDeploymentDecision).
                    await d.approvalService.withdraw({ approval, deciderId: ctx.userId, reason: 'The deployment was cancelled.' });
                }
            }
            await d.stageStore.closeAwaiting(row.id, ctx.userId);
        } else if (row.status === 'queued' || row.status === 'approved') {
            const moved = await d.stageStore.transitionDeployment(row.id, ['queued', 'approved'], 'cancelled', { error: { code: 'cancelled', by: ctx.userId } });
            if (!moved) throw notCancellable();
        } else {
            throw notCancellable();
        }
        const fresh = await d.stageStore.getDeployment(row.id);
        if (!fresh || fresh.status !== 'cancelled') throw notCancellable();
        await logOn(d, fresh.stageProjectId, ctx.userId, 'deployment_cancelled', { targetType: 'deployment', targetId: fresh.id });
        res.json({ deployment: deploymentView(fresh) });
    });

    /** POST /:id/deployments/:depId/retry: converge again, or plan the same thing again. */
    router.post('/:id/deployments/:depId/retry', packaging, authMw(d, { dev: 'viewer', anyStage: 'viewer', orgAdmin: true }), validate({ body: S.EmptyBody }), async (req, res) => {
        const ctx = req.stageCtx;
        const row = await deploymentOf(ctx, req.params.depId);
        assertSteersDeployment(ctx, row);

        if (row.status === 'succeeded_with_warnings') {
            // A lease that is already over: the runner's resume picks the row up and converges it again.
            const moved = await d.stageStore.retryConverge(row.id, d.runner.workerId, 1);
            if (!moved) throw new HttpError(409, 'deployment_not_retryable', 'This deployment can no longer be retried.');
            d.defer(() => {
                Promise.resolve(d.runner.resumeStale()).catch(err => log.warn(`[stages] converge retry of ${row.id}: ${err && err.message}`));
            });
            await logOn(d, moved.stageProjectId, ctx.userId, 'deployment_retried', { targetType: 'deployment', targetId: moved.id, how: 'converge' });
            return res.status(202).json({ deployment: deploymentView(moved) });
        }
        if (row.status !== 'failed') {
            throw new HttpError(409, 'deployment_not_retryable', 'Only a failed deployment, or one that finished with warnings, can be retried.', { status: row.status });
        }

        const stage = await d.stageStore.getStageFor(ctx.dev.id, row.stage);
        if (!stage) throw notFound('stage_not_found', 'This stage does not exist any more.');
        const patch = isObject(row.settingsPatch) ? row.settingsPatch : null;
        const planned = await d.plan({
            stageProjectId: stage.projectId, releaseId: row.releaseId, kind: row.kind,
            ...(row.kind === 'settings' ? { settingsPatch: patch } : {}),
            ...(row.kind === 'remove' ? { deleteData: !!(patch && patch.deleteData === true) } : {}),
        }, d.planDeps);
        const out = await d.runner.admit({
            solutionId: ctx.dev.id, stage: stage.stage, releaseId: row.releaseId, kind: row.kind, planHash: planned.planHash,
            requestKey: `retry:${row.id}:${crypto.randomUUID()}`, acknowledgements: row.acknowledgements || [],
            actor: { id: ctx.userId }, settingsPatch: ['settings', 'remove'].includes(row.kind) ? patch : null,
        });
        await logOn(d, stage.projectId, ctx.userId, 'deployment_retried', { targetType: 'deployment', targetId: out.deployment.id, how: 'replan', of: row.id });
        res.status(202).json({ deployment: deploymentView(out.deployment) });
    });

    return router;
}

module.exports = { makeDeploymentRouter, stepView, encodeCursor, decodeCursor };
