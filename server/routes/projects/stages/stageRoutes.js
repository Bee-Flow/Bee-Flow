'use strict';
/**
 * Stage routes (design 8): the pipeline overview, creating and removing the
 * stages of a Solution, and reading a stage's settings. Also home of the
 * helpers the other stage routers share: `resolveDeps` (the lazily bound
 * collaborators, all replaceable by a test), the per-field licence gate, the
 * allow-listed views and the part listing.
 *
 * The routers hold no logic of their own about deploying: they authorise
 * (projects/stages/stageAuth.js), validate (stageSchemas.js), call the engine
 * (projects/stages/runner.js `admit`, plan.js, release.js) and shape the
 * answer. Every refusal is an HttpError; the terminal handler renders it.
 */

const crypto = require('crypto');
const express = require('express');
const { validate } = require('../../../core/http/validate');
const { HttpError } = require('../../../core/http/errors');
const log = require('../../../telemetry/log');
const S = require('./stageSchemas');
const { stageAuth } = require('../../../projects/stages/stageAuth');

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
const BUSY_STATUSES = Object.freeze(['awaiting_approval', 'queued', 'approved', 'preparing', 'committing', 'converging', 'compensating']);
const STAGE_LABEL = Object.freeze({ uat: 'UAT', prd: 'Production' });

/**
 * The collaborators of the stage routers, bound on first use. A test passes
 * doubles for the ones it exercises; nothing is replaced in `require.cache`.
 *
 * @param {object} [deps]
 * @returns {object}
 */
function resolveDeps(deps = {}) {
    const d = {
        raw: deps,
        get requireFeature() { return dep(deps, 'requireFeature', () => require('../../../license/middleware').requireFeature); },
        get stageStore() { return dep(deps, 'stageStore', () => require('../../../stores/solutionStageStore')); },
        get projectStore() { return dep(deps, 'projectStore', () => require('../../../stores/projectStore')); },
        get blueprintStore() { return dep(deps, 'blueprintStore', () => require('../../../stores/blueprintStore')); },
        get runner() { return dep(deps, 'runner', () => require('../../../projects/stages/runner').getRunner()); },
        get plan() { return dep(deps, 'plan', () => require('../../../projects/stages/plan').plan); },
        get planDeps() { return dep(deps, 'planDeps', () => ({})); },
        get cutRelease() { return dep(deps, 'cutRelease', () => require('../../../projects/stages/release').cutRelease); },
        get cutDeps() { return dep(deps, 'cutDeps', () => ({})); },
        get approvalGate() { return dep(deps, 'approvalGate', () => require('../../../projects/stages/approvalGate')); },
        get approvalService() { return dep(deps, 'approvalService', () => require('../../../automation/approvalService')); },
        get getApproval() { return dep(deps, 'getApproval', () => (id) => require('../../../stores/automationStore').getApproval(id)); },
        get bindingDeps() { return dep(deps, 'bindingDeps', () => ({})); },
        get validateBinding() { return dep(deps, 'validateBinding', () => require('../../../projects/stages/applyBindings').validateBinding); },
        get refusedContent() { return dep(deps, 'refusedContent', () => require('../../../projects/kindChange').refusedContent); },
        get getProjectRole() { return dep(deps, 'getProjectRole', () => require('../../../auth/projectAccess').getProjectRole); },
        get isOrgAdminForOrg() { return dep(deps, 'isOrgAdminForOrg', () => require('../../../auth/permissions').isOrgAdminForOrg); },
        get logActivity() { return dep(deps, 'logActivity', () => (p, a, act, det) => d.projectStore.logActivity(p, a, act, det)); },
        get notify() {
            return dep(deps, 'notify', () => (n) => require('../../../stores/notificationStore').createNotification({
                userId: n.userId, category: 'heads_up', title: n.title, message: n.message || '', link: n.link || null,
            }));
        },
        get readStageShape() { return dep(deps, 'readStageShape', () => require('../../../projects/stages/stagePayload').readStageShape); },
        get canonicalHash() {
            return dep(deps, 'canonicalHash', () => {
                const { canonicalOf, hashPayload } = require('../../../projects/stages/stagePayload');
                return (kind, shape) => hashPayload(canonicalOf(kind, shape));
            });
        },
        get automationStore() { return dep(deps, 'automationStore', () => require('../../../stores/automationStore')); },
        get goLive() { return dep(deps, 'goLive', () => require('../../../automation/goLive')); },
        get studioAppStore() { return dep(deps, 'studioAppStore', () => require('../../../stores/studioAppStore')); },
        get setAppAudience() { return dep(deps, 'setAppAudience', () => require('../../../appStudio/appAudience').setAppAudience); },
        get appAudienceDeps() {
            return dep(deps, 'appAudienceDeps', () => ({
                store: require('../../../stores/studioAppStore'),
                userStore: require('../../../stores/userStore'),
                validateSharedGroupsForOrg: require('../../../auth').validateSharedGroupsForOrg,
                audit: { auditPublishChange: (entry) => require('../../../appStudio/publicationAudit').auditPublishChange(entry) },
                notifyMenuChange: (orgId, meta) => require('../../../appStudio/nextcloudMenuSync').notifyMenuChange(orgId, meta),
            }));
        },
        get webpageStore() { return dep(deps, 'webpageStore', () => require('../../../stores/webpageStore')); },
        get agentStore() { return dep(deps, 'agentStore', () => require('../../../stores/agentStore')); },
        get userStore() { return dep(deps, 'userStore', () => require('../../../stores/userStore')); },
        get validateSharedGroupsForOrg() { return dep(deps, 'validateSharedGroupsForOrg', () => require('../../../auth').validateSharedGroupsForOrg); },
        get releaseGate() { return dep(deps, 'releaseGate', () => require('../../../projects/packaging/publication').releaseGate); },
        get readCutState() { return dep(deps, 'readCutState', () => require('../../../projects/stages/release').defaultReadCutState); },
        get readSourceCut() {
            return dep(deps, 'readSourceCut', () => async (releaseId) => {
                const db = require('../../../db');
                const res = await db.run('SELECT source_cut FROM project_releases WHERE id = $1', [releaseId]);
                const row = (res && res.rows ? res.rows : res || [])[0];
                return row ? row.source_cut : null;
            });
        },
        get publicBaseUrl() { return dep(deps, 'publicBaseUrl', () => require('../../../automation/publicUrl').resolvePublicBaseUrl); },
        get webhookUrl() { return dep(deps, 'webhookUrl', () => require('../../../automation/publicUrl').webhookUrlForSlug); },
        get emitAgentPublished() {
            return dep(deps, 'emitAgentPublished', () => (agent) => {
                const events = require('../../../compliance/events');
                events.emit(events.EVENTS.AGENT_PUBLISHED, { orgId: agent.organization_id || agent.organizationId || 'default', agentId: agent.id });
            });
        },
        get now() { return dep(deps, 'now', () => () => new Date()); },
        get defer() {
            return dep(deps, 'defer', () => (fn) => {
                const t = setTimeout(fn, 20);
                if (t && typeof t.unref === 'function') t.unref();
            });
        },
    };
    return d;
}

// ── Small shared helpers ───────────────────────────────────────────────────────

/** Run a gate middleware by hand: true when it let the request through. */
function passes(gate, req, res) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const next = (err) => { if (settled) return; settled = true; if (err) reject(err); else resolve(true); };
        Promise.resolve(gate(req, res, next)).then(() => {
            if (!settled) { settled = true; resolve(false); }
        }, (err) => { if (!settled) { settled = true; reject(err); } });
    });
}

/**
 * A per-route licence gate that applies only when `when(req)` says the request
 * needs it (the PATCH of a stage settings needs `blueprint_packaging` and
 * `approvals` only when a gate field is in the body). `when` null: always.
 */
function gate(d, feature, when = null) {
    let mw = null;
    return async function stageFeatureGate(req, res, next) {
        if (when && !when(req)) return next();
        if (!mw) mw = d.requireFeature(feature);
        if (await passes(mw, req, res)) next();
    };
}

function authMw(d, opts) {
    return async function stageAuthMw(req, _res, next) {
        await stageAuth(req, opts, d);
        next();
    };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What a deployment looks like to a caller: an allow-list, never the request key or the lease. */
function deploymentView(row) {
    if (!row) return null;
    return {
        id: row.id,
        solutionId: row.solutionId,
        stageProjectId: row.stageProjectId,
        stage: row.stage,
        kind: row.kind,
        status: row.status,
        releaseId: row.releaseId ?? null,
        releaseSeq: row.releaseSeq ?? null,
        fromReleaseId: row.fromReleaseId ?? null,
        requestedBy: row.requestedBy ?? null,
        approvalId: row.approvalId ?? null,
        acknowledgements: Array.isArray(row.acknowledgements) ? row.acknowledgements : [],
        settingsPatch: row.settingsPatch ?? null,
        planHash: row.planHash ?? null,
        report: row.report ?? null,
        error: row.error ?? null,
        createdAt: row.createdAt ?? null,
        startedAt: row.startedAt ?? null,
        committedAt: row.committedAt ?? null,
        finishedAt: row.finishedAt ?? null,
    };
}

function roleName(ctx, stageName) {
    if (stageName) return ctx.stageRoles[stageName] || null;
    return ctx.stageRole || (ctx.viaOrgAdmin ? 'org_admin' : null);
}

/** Best-effort audit row on a project; it never fails the request. */
async function logOn(d, projectId, actorId, action, details = {}) {
    try { await d.logActivity(projectId, actorId, action, details); } catch (err) {
        log.warn(`[stages] activity ${action} not logged: ${err && err.message}`);
    }
}

/** An org admin acted on a Solution they do not own: its owner hears about it. */
async function notifyOwnerOfAdmin(d, ctx, what) {
    if (!ctx.viaOrgAdmin || !ctx.dev || !ctx.dev.ownerId || ctx.dev.ownerId === ctx.userId) return;
    const label = ctx.stage ? STAGE_LABEL[ctx.stage.stage] || ctx.stage.stage : '';
    try {
        await d.notify({
            userId: ctx.dev.ownerId,
            title: `An organisation admin ${what} ${ctx.dev.name || 'your Solution'}${label ? ` (${label})` : ''}`,
            message: 'This stage is run by you. The change is in the Solution activity.',
        });
    } catch (err) {
        log.warn(`[stages] owner not notified: ${err && err.message}`);
    }
}

async function mapLimited(items, width, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, worker));
    return out;
}

// ── Parts and addresses of a stage ─────────────────────────────────────────────

/** Is the stored part on? null for a kind that has no switch. */
function activeOf(kind, shape) {
    if (!shape) return null;
    if (kind === 'automation') return shape.isActive === true;
    if (kind === 'app' || kind === 'webpage') return shape.isPublished === true || shape.is_published === true;
    if (kind === 'agent') return shape.isPublished === true || shape.is_published === true;
    return null;
}

const nameOfShape = (shape) => {
    if (!shape) return null;
    const raw = [shape.title, shape.name, shape.key].find(v => typeof v === 'string' && v.trim());
    return raw ? raw.trim().slice(0, 200) : null;
};

/**
 * Every part of a stage: `{ ref, kind, name, entityId, active, retired, drift }`.
 * Drift = the stored part no longer hashes to what the last deploy stamped.
 */
async function listParts(d, stage) {
    const stamps = [...(await d.blueprintStore.listStamps(stage.projectId)).values()];
    const rows = await mapLimited(stamps, 6, async (stamp) => {
        const retired = !!stamp.retiredAt;
        let shape = null;
        if (!retired) {
            try { shape = await d.readStageShape(stamp.kind, stamp.entityId, {}, {}); } catch (err) {
                log.warn(`[stages] part ${stamp.ref} not read: ${err && err.message}`);
            }
        }
        let drift = false;
        if (shape && stamp.installHash) {
            try { drift = d.canonicalHash(stamp.kind, shape) !== stamp.installHash; } catch { drift = false; }
        }
        return {
            row: {
                ref: stamp.ref, kind: stamp.kind, name: nameOfShape(shape), entityId: stamp.entityId,
                active: activeOf(stamp.kind, shape), retired, drift,
            },
            shape,
        };
    });
    return rows;
}

/** The addresses that reach a stage from outside; a webhook slug is a credential, so only for the owner. */
async function inboundFor(d, req, parts, { includeWebhooks }) {
    const out = [];
    const base = d.publicBaseUrl(req);
    for (const { row, shape } of parts) {
        if (row.retired || !shape) continue;
        if (row.kind === 'webpage' && typeof shape.slug === 'string' && shape.slug) {
            out.push({ kind: 'webpage', label: row.name || row.ref, url: `${base}/w/${shape.slug}` });
        }
        if (includeWebhooks && row.kind === 'automation') {
            try {
                for (const wh of await d.automationStore.getWebhooksForAutomation(row.entityId)) {
                    out.push({ kind: 'webhook', label: row.name || row.ref, url: d.webhookUrl(wh.id, req) });
                }
            } catch (err) {
                log.warn(`[stages] webhooks of ${row.ref} not listed: ${err && err.message}`);
            }
        }
    }
    return out;
}

async function lastDeploymentOf(d, stageProjectId) {
    const [last] = await d.stageStore.listDeployments(stageProjectId, { limit: 1 });
    return last || null;
}

/** One stage as the pipeline overview lists it. */
async function pipelineStageView(d, row, role) {
    const last = await lastDeploymentOf(d, row.projectId);
    const busy = last && BUSY_STATUSES.includes(last.status);
    return {
        stage: row.stage,
        projectId: row.projectId,
        currentRelease: row.currentReleaseId ? { id: row.currentReleaseId, seq: row.currentReleaseSeq } : null,
        previousRelease: row.previousReleaseId ? { id: row.previousReleaseId, seq: null } : null,
        lastDeployment: deploymentView(last),
        pending: busy ? deploymentView(last) : null,
        bindingsPending: row.bindingsPending === true,
        enabled: row.enabled === true,
        paused: !!row.pausedState,
        requiresApproval: row.requiresApproval === true,
        role,
    };
}

/** A pipeline release for the list: counts, never content. */
function releaseView(release, stages) {
    const notes = isObject(release.notes) ? release.notes : {};
    const changes = Array.isArray(notes.changes) ? notes.changes : [];
    const count = (kind) => changes.filter(c => c && c.change === kind).length;
    return {
        id: release.id,
        seq: release.seq,
        createdAt: release.publishedAt ?? null,
        notes: {
            summary: typeof notes.text === 'string' ? notes.text : null,
            changed: count('changed'),
            added: count('added'),
            ...(Number.isInteger(notes.removed) ? { removed: notes.removed } : {}),
        },
        gate: release.gate ? { blocked: release.gate.blocked === true } : null,
        contentHash: release.contentHash ?? null,
        deployedTo: stages.filter(s => s.currentReleaseId === release.id).map(s => s.stage),
    };
}

// ── Dev side of the pipeline ───────────────────────────────────────────────────

/** How far Dev has moved since the latest release: tokens of the cut against Dev now. */
async function devAheadOf(d, dev) {
    const [latest] = await d.blueprintStore.listPipelineReleases(dev.id, { limit: 1 });
    if (!latest) return null;
    const cut = await d.readSourceCut(latest.id);
    const before = cut && isObject(cut.tokens) ? cut.tokens : null;
    if (!before) return { seq: latest.seq, changed: null, added: null, removed: null };
    const { stableStringify } = require('../../../projects/stages/model');
    const now = (await d.readCutState(dev)).tokens || {};
    let changed = 0;
    let added = 0;
    let removed = 0;
    for (const key of Object.keys(now)) {
        if (!(key in before)) added += 1;
        else if (stableStringify(now[key]) !== stableStringify(before[key])) changed += 1;
    }
    for (const key of Object.keys(before)) if (!(key in now)) removed += 1;
    return { seq: latest.seq, changed, added, removed };
}

async function devChecks(d, dev) {
    const verdict = await d.releaseGate(dev);
    return { blocked: !verdict || verdict.blocked !== false, count: Array.isArray(verdict && verdict.findings) ? verdict.findings.length : 0 };
}

const settled = async (fn, what) => {
    try { return await fn(); } catch (err) {
        log.warn(`[stages] pipeline: ${what} not read: ${err && err.message}`);
        return null;
    }
};

// ── Handlers ───────────────────────────────────────────────────────────────────

function makeStageHandlers(d) {
    /** GET /:id/pipeline */
    async function pipeline(req, res) {
        const ctx = req.stageCtx;
        const hasDev = !!ctx.devRole;
        const rows = await d.stageStore.listStages(ctx.dev.id);
        const visible = hasDev ? rows : rows.filter(r => ctx.stageRoles[r.stage]);
        const stages = await mapLimited(visible, 2, (row) => pipelineStageView(d, row, ctx.stageRoles[row.stage] || null));
        let dev = null;
        let releases = null;
        if (hasDev) {
            const [ahead, checks, list] = await Promise.all([
                settled(() => devAheadOf(d, ctx.dev), 'what Dev changed'),
                settled(() => devChecks(d, ctx.dev), 'the release checks'),
                settled(() => d.blueprintStore.listPipelineReleases(ctx.dev.id, { limit: 20 }), 'the releases'),
            ]);
            dev = { aheadOf: ahead, checks };
            releases = (list || []).map(r => releaseView(r, rows));
        }
        res.json({ dev, stages, releases });
    }

    /** POST /:id/stages */
    async function createStages(req, res) {
        const ctx = req.stageCtx;
        const { dev, userId } = ctx;
        if (dev.kind == null || dev.kindGuessed === true) {
            // A legacy Dev holds more than chats: documents, meeting notes and project files.
            const held = await d.refusedContent(dev, 'solution');
            if (held && Object.keys(held).length > 0) {
                throw new HttpError(409, 'KIND_HOLDS_OTHER_CONTENT',
                    'This project still holds items a Solution cannot hold. Take them out first, then create the stages.',
                    { kind: 'solution', held });
            }
        }
        const created = await d.stageStore.createStages({ devProject: dev, stages: req.body.stages, actorId: userId });
        const out = [];
        for (const row of created) {
            if (row.created) await logOn(d, dev.id, userId, 'stage_created', { targetType: 'project', targetId: row.projectId, stage: row.stage });
            out.push({ ...(await pipelineStageView(d, row, 'owner')), created: row.created === true });
        }
        res.status(201).json({ stages: out });
    }

    /** DELETE /:id/stages/:stage and POST /api/solution-stages/:stageProjectId/detach */
    async function removeStage(req, res) {
        const ctx = req.stageCtx;
        const { dev, stage, userId } = ctx;
        const stageProject = await d.projectStore.getProject(stage.projectId);
        const accepted = [stageProject && stageProject.name, dev.name].filter(Boolean);
        if (!accepted.includes(req.body.confirm)) {
            throw new HttpError(400, 'confirm_mismatch', 'The name you typed is not the name of this stage.');
        }
        const mode = req.body.mode || 'detach';

        if (mode === 'detach') {
            const out = await d.stageStore.detachStage(stage.projectId, userId);
            await logOn(d, dev.id, userId, 'stage_detached', { targetType: 'project', targetId: stage.projectId, stage: stage.stage });
            await notifyOwnerOfAdmin(d, ctx, 'detached');
            return res.json({ detached: true, stage: out.stage || stage.stage, projectId: stage.projectId, solutionId: dev.id });
        }

        const deleteData = req.body.deleteData === true;
        const planned = await d.plan({ stageProjectId: stage.projectId, kind: 'remove', deleteData }, d.planDeps);
        // Typing the name is the acknowledgement of everything the plan asks for.
        const acknowledgements = (planned.acknowledgementsRequired || []).map(a => (typeof a === 'string' ? { code: a } : a));
        const { deployment } = await d.runner.admit({
            solutionId: dev.id, stage: stage.stage, releaseId: null, kind: 'remove', planHash: planned.planHash,
            requestKey: req.body.requestKey || `remove:${crypto.randomUUID()}`,
            acknowledgements, actor: { id: userId }, settingsPatch: deleteData ? { deleteData: true } : null,
        });
        await logOn(d, stage.projectId, userId, 'stage_remove_requested', { targetType: 'deployment', targetId: deployment.id, deleteData });
        await notifyOwnerOfAdmin(d, ctx, 'asked to remove');
        res.status(202).json({ deployment: deploymentView(deployment) });
    }

    /** GET /:id/stages/:stage and GET /api/solution-stages/:stageProjectId */
    async function getStage(req, res) {
        const ctx = req.stageCtx;
        const { stage, dev } = ctx;
        const parts = await listParts(d, stage);
        const isOwner = ctx.stageRole === 'owner' || ctx.isSolutionOwner;
        const inbound = await inboundFor(d, req, parts, { includeWebhooks: isOwner });
        let runAs = { userId: stage.runAsUserId, name: null };
        try {
            const user = await d.userStore.getUser(stage.runAsUserId);
            if (user) runAs = { userId: stage.runAsUserId, name: user.name || user.displayName || user.email || null };
        } catch { /* the id is enough */ }
        res.json({
            stage: stage.stage,
            projectId: stage.projectId,
            solutionId: dev.id,
            settingsVersion: stage.settingsVersion,
            enabled: stage.enabled === true,
            paused: !!stage.pausedState,
            newPartsActive: stage.newPartsActive === true,
            runAs,
            requiresApproval: stage.requiresApproval === true,
            approvalPolicy: stage.approvalPolicy ?? null,
            rollbackNeedsApproval: stage.rollbackNeedsApproval === true,
            bindingsPending: stage.bindingsPending === true,
            currentRelease: stage.currentReleaseId ? { id: stage.currentReleaseId, seq: stage.currentReleaseSeq } : null,
            role: roleName(ctx),
            parts: parts.map(p => p.row),
            inbound,
        });
    }

    return { pipeline, createStages, removeStage, getStage };
}

/** The router of this file: pipeline, create, remove, read. PATCH of a stage lives in settingsRoutes. */
function makeStageRouter(d) {
    const router = express.Router({ mergeParams: true });
    const h = makeStageHandlers(d);

    router.get('/:id/pipeline', gate(d, 'projects'), authMw(d, { dev: 'viewer', anyStage: 'viewer' }), h.pipeline);
    router.post('/:id/stages', gate(d, 'blueprint_packaging'), authMw(d, { dev: 'owner' }), validate({ body: S.CreateStagesBody }), h.createStages);
    // Detaching is the escape hatch and stays free; removing (a deployment) is the licensed half.
    router.delete('/:id/stages/:stage', authMw(d, { stage: 'owner', orgAdmin: true }), validate({ body: S.DeleteStageBody }),
        gate(d, 'blueprint_packaging', (req) => req.body && req.body.mode === 'delete'), h.removeStage);
    router.get('/:id/stages/:stage', gate(d, 'projects'), authMw(d, { stage: 'viewer', orgAdmin: true }), h.getStage);
    return router;
}

module.exports = {
    resolveDeps, makeStageHandlers, makeStageRouter,
    gate, authMw, passes, deploymentView, releaseView, listParts, activeOf, logOn, notifyOwnerOfAdmin, mapLimited,
    pipelineStageView, lastDeploymentOf, roleName, BUSY_STATUSES, STAGE_LABEL, isObject,
};
