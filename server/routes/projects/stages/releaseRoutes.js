'use strict';
/**
 * Release routes (design 8, 6.1): cut a release in Dev, list and read the
 * pipeline releases, plan a deployment, and the one-click "release and deploy
 * to UAT". Dev-side and Solution-owner work, so every route is licensed with
 * `blueprint_packaging`.
 *
 * What a release reads back as: the manifest of the parts and slots, the gate
 * verdict, and COUNTS for the payloads that never leave the instance (reference
 * rows, the document listing of a carried knowledge base). Never a row.
 */

const express = require('express');
const { validate } = require('../../../core/http/validate');
const { HttpError, notFound } = require('../../../core/http/errors');
const S = require('./stageSchemas');
const { gate, authMw, releaseView, deploymentView, logOn, isObject } = require('./stageRoutes');

/** Reference rows and KB listings, summarised: counts and flags, no content. */
function payloadSummary(payloads) {
    return (Array.isArray(payloads) ? payloads : []).map((p) => {
        const body = isObject(p.payload) ? p.payload : {};
        if (p.kind === 'reference_rows') return { ref: p.ref, kind: p.kind, rows: Array.isArray(body.rows) ? body.rows.length : 0 };
        if (p.kind === 'knowledge_listing') {
            const docs = Array.isArray(body.docs) ? body.docs : [];
            return {
                ref: p.ref, kind: p.kind, documents: docs.length,
                personalDataFlagged: docs.filter(x => x && ['found', 'unscanned'].includes(x.piiStatus)).length,
            };
        }
        return { ref: p.ref, kind: p.kind };
    });
}

function makeReleaseRouter(d) {
    const router = express.Router({ mergeParams: true });
    const packaging = gate(d, 'blueprint_packaging');

    /** POST /:id/releases */
    router.post('/:id/releases', packaging, authMw(d, { dev: 'owner' }), validate({ body: S.CutReleaseBody }), async (req, res) => {
        const { dev, userId } = req.stageCtx;
        const out = await d.cutRelease({ devProject: dev, actorId: userId, requestKey: req.body.requestKey || null, notes: req.body.notes || null }, d.cutDeps);
        const stages = await d.stageStore.listStages(dev.id);
        const fresh = !out.reused && !out.replayed;
        if (fresh) await logOn(d, dev.id, userId, 'release_cut', { targetType: 'release', targetId: out.release.id, seq: out.release.seq });
        res.status(fresh ? 201 : 200).json({
            release: releaseView(out.release, stages), reused: out.reused === true, replayed: out.replayed === true,
            findings: Array.isArray(out.findings) ? out.findings : [],
        });
    });

    /** GET /:id/releases */
    router.get('/:id/releases', packaging, authMw(d, { dev: 'editor' }), async (req, res) => {
        const { dev } = req.stageCtx;
        const [list, stages] = await Promise.all([d.blueprintStore.listPipelineReleases(dev.id, { limit: 50 }), d.stageStore.listStages(dev.id)]);
        res.json({ releases: list.map(r => releaseView(r, stages)) });
    });

    /** GET /:id/releases/:releaseId */
    router.get('/:id/releases/:releaseId', packaging, authMw(d, { dev: 'editor' }), async (req, res) => {
        const { dev } = req.stageCtx;
        const release = await d.blueprintStore.getRelease(dev.id, req.params.releaseId);
        if (!release || release.channel !== 'pipeline') throw notFound('release_not_found', 'That release does not exist.');
        const [payloads, stages] = await Promise.all([d.blueprintStore.getReleasePayloads(release.id), d.stageStore.listStages(dev.id)]);
        res.json({
            release: {
                ...releaseView(release, stages), gate: release.gate ?? null, notes: release.notes ?? {},
                manifest: release.manifest, payloads: payloadSummary(payloads),
            },
        });
    });

    /** POST /:id/stages/:stage/plan */
    router.post('/:id/stages/:stage/plan', packaging, authMw(d, { stage: 'owner' }), validate({ body: S.PlanBody }), async (req, res) => {
        const { stage } = req.stageCtx;
        const kind = req.body.kind || 'deploy';
        if (kind !== 'redeploy' && !req.body.releaseId) throw new HttpError(400, 'release_required', 'Choose the release to plan.');
        res.json(await d.plan({ stageProjectId: stage.projectId, releaseId: req.body.releaseId || null, kind }, d.planDeps));
    });

    /** POST /:id/release-and-deploy: cut, plan, and deploy to UAT when nothing blocks. */
    router.post('/:id/release-and-deploy', packaging, authMw(d, { dev: 'owner' }), validate({ body: S.ReleaseAndDeployBody }), async (req, res) => {
        const { dev, userId } = req.stageCtx;
        const uat = await d.stageStore.getStageFor(dev.id, 'uat');
        if (!uat) throw notFound('stage_not_found', 'This Solution has no UAT stage yet.');
        const cut = await d.cutRelease({ devProject: dev, actorId: userId, requestKey: req.body.requestKey, notes: req.body.notes || null }, d.cutDeps);
        const stages = await d.stageStore.listStages(dev.id);
        const release = releaseView(cut.release, stages);
        if (!cut.reused && !cut.replayed) await logOn(d, dev.id, userId, 'release_cut', { targetType: 'release', targetId: cut.release.id, seq: cut.release.seq });

        const planned = await d.plan({ stageProjectId: uat.projectId, releaseId: cut.release.id, kind: 'deploy' }, d.planDeps);
        if (Array.isArray(planned.blocking) && planned.blocking.length) {
            throw new HttpError(409, 'plan_blocked', 'Something blocks this deployment.', { release, plan: planned, findings: planned.blocking });
        }
        let admitted;
        try {
            admitted = await d.runner.admit({
                solutionId: dev.id, stage: 'uat', releaseId: cut.release.id, kind: 'deploy', planHash: planned.planHash,
                requestKey: `${req.body.requestKey}:uat`, acknowledgements: req.body.acknowledgements, actor: { id: userId },
            });
        } catch (err) {
            // The release is cut; what is missing is the user's word on the plan.
            if (err && err.code === 'acknowledgement_missing') {
                throw new HttpError(409, 'acknowledgement_missing', err.message, { ...(err.details || {}), release, plan: planned });
            }
            throw err;
        }
        await logOn(d, uat.projectId, userId, 'deployment_requested', { targetType: 'deployment', targetId: admitted.deployment.id, kind: 'deploy', releaseSeq: cut.release.seq });
        res.status(202).json({ release, deployment: deploymentView(admitted.deployment), replayed: admitted.replayed === true });
    });

    return router;
}

module.exports = { makeReleaseRouter, payloadSummary };
