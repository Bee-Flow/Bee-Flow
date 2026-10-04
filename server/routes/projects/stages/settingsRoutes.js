'use strict';
/**
 * Stage settings routes (design 4 and 8): the stage's own settings and approval
 * gate, requirements and bindings, Solution variables and their values per
 * stage, on/off and audience of a part, pause and resume, and part options.
 *
 * The handlers that the drain router (routes/solutionStages.js) offers too
 * (`patchPart`, `pause`, `resume`, `putValues`) are built here once by
 * `makeSettingsHandlers(d)`, so a licence lapse never turns them into a second,
 * different implementation.
 *
 * Roles: SO = owner of the stage project, SE = editor of it. A steering
 * variable (D18) and a binding are SO-only: they decide where credentials and
 * mail go. Everything else a stage editor may do is switching parts and the
 * stage on and off, non-steering values and audience.
 */

const crypto = require('crypto');
const express = require('express');
const { validate } = require('../../../core/http/validate');
const { HttpError, notFound } = require('../../../core/http/errors');
const log = require('../../../telemetry/log');
const S = require('./stageSchemas');
const { stableStringify } = require('../../../projects/stages/model');
const {
    gate, authMw, logOn, notifyOwnerOfAdmin, deploymentView, isObject,
} = require('./stageRoutes');

const STEERING_TYPES = Object.freeze(['url', 'email']);
const VARIABLE_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const iso = (d) => d.now().toISOString();

const steeringOf = (decl) => !!decl && (decl.steering === true || STEERING_TYPES.includes(decl.type));

// ── Variable declarations, as a stage sees them ───────────────────────────────

/**
 * The declarations a write to `target` is checked against: the release the
 * stage runs now wins (that is what is applied), Dev's declarations fill in
 * the names it does not have yet (a value may be entered before the deploy
 * that needs it).
 *
 * @returns {Promise<Map<string, object>>}
 */
async function declarationsFor(d, ctx) {
    const out = new Map();
    const stage = ctx.stageName === 'dev' ? null : ctx.stage;
    if (stage && stage.currentReleaseId) {
        const release = await d.blueprintStore.getRelease(ctx.dev.id, stage.currentReleaseId);
        const list = release && release.manifest && release.manifest.solution && release.manifest.solution.variables;
        for (const decl of Array.isArray(list) ? list : []) if (decl && typeof decl.name === 'string') out.set(decl.name, decl);
    }
    for (const decl of await d.stageStore.listVariables(ctx.dev.id)) if (!out.has(decl.name)) out.set(decl.name, decl);
    return out;
}

const publicDecl = (decl) => ({
    name: decl.name, type: decl.type || 'text', choices: decl.choices ?? null, description: decl.description || '',
    required: decl.required !== false, steering: steeringOf(decl),
});

// ── Part switches ──────────────────────────────────────────────────────────────

const notDeployed = () => new HttpError(409, 'managed_part_not_deployed',
    'This part has not been deployed to this stage yet, so there is nothing to switch on.');

/** An activateCore refusal is a value; the route answers it as the activate route would. */
function refusalToError(r) {
    return new HttpError(r.status || 409, r.code || 'go_live_refused', r.message || 'This part cannot go live.', r.details);
}

async function cleanGroups(d, orgId, groups) {
    try {
        return await d.validateSharedGroupsForOrg(orgId, groups);
    } catch (err) {
        const status = Number(err && err.status);
        if (status >= 400 && status < 500) throw new HttpError(status, 'invalid_groups', err.message);
        throw err;
    }
}

function makeSettingsHandlers(d) {
    /** A part of the stage by its ref, with its stored shape; 404 when it is retired or gone. */
    async function partOf(stage, ref) {
        const stamp = (await d.blueprintStore.listStamps(stage.projectId)).get(ref);
        if (!stamp || stamp.retiredAt) throw notFound('part_not_found', 'This part is not in the stage.');
        const shape = await d.readStageShape(stamp.kind, stamp.entityId, {}, {});
        if (!shape) throw notFound('part_not_found', 'This part is not in the stage.');
        return { stamp, shape };
    }

    async function switchAutomation(ctx, shape, active) {
        const { userId, stage } = ctx;
        if (active) {
            if (shape.liveVersion == null) throw notDeployed();
            const r = await d.goLive.activateCore({ automation: shape, actorId: userId, organizationId: stage.organizationId || null });
            if (!r.ok) throw refusalToError(r);
        } else {
            await d.goLive.deactivateCore({ automation: shape, actorId: userId });
        }
        return { isActive: active };
    }

    async function switchApp(ctx, shape, { publishing, sharedGroups }) {
        if (publishing && !shape.publishedDefinition) throw notDeployed();
        const out = await d.setAppAudience({
            app: shape, publishing, sharedGroups, organizationId: ctx.stage.organizationId || null, actorId: ctx.userId,
            deps: d.appAudienceDeps,
        });
        if (!out.ok) throw new HttpError(out.status, (out.body && out.body.code) || 'audience_refused', (out.body && out.body.error) || 'The audience could not be changed.', out.body);
        return { isPublished: out.isPublished, sharedGroups: out.sharedGroups };
    }

    async function switchWebpage(ctx, shape, { publishing, sharedGroups }) {
        if (publishing && !shape.publishedVersionId) throw notDeployed();
        const groups = await cleanGroups(d, ctx.stage.organizationId || null, sharedGroups);
        const ok = await d.webpageStore.setWebpagePublished(shape.id, publishing, shape.userId, groups, ctx.stage.organizationId || null);
        if (!ok) throw new HttpError(500, 'audience_failed', 'The audience could not be changed.');
        return { isPublished: publishing, ...(groups !== undefined ? { sharedGroups: groups } : {}) };
    }

    async function switchAgent(ctx, shape, { publishing, sharedGroups }) {
        if (publishing && !(Number(shape.published_version) > 0)) throw notDeployed();
        const groups = await cleanGroups(d, ctx.stage.organizationId || shape.organization_id || null, sharedGroups);
        const ok = await d.agentStore.setAgentPublished(shape.id, publishing, shape.owner_id, groups);
        if (!ok) throw new HttpError(500, 'audience_failed', 'The audience could not be changed.');
        if (publishing) { try { d.emitAgentPublished(shape); } catch { /* the compliance bus is best effort */ } }
        return { isPublished: publishing, ...(groups !== undefined ? { sharedGroups: groups } : {}) };
    }

    /** PATCH /:id/stages/:stage/parts/:ref (and the drain router's, `active` only). */
    async function patchPart(req, res) {
        const ctx = req.stageCtx;
        const { stage, userId } = ctx;
        const { stamp, shape } = await partOf(stage, req.params.ref);
        const { active, audience } = req.body;
        let result;
        if (stamp.kind === 'automation') {
            if (audience) throw new HttpError(400, 'audience_not_supported', 'An automation has no audience; switch it on or off.');
            result = await switchAutomation(ctx, shape, active === true);
        } else if (['app', 'webpage', 'agent'].includes(stamp.kind)) {
            const publishing = audience ? audience.published === true : active === true;
            const spec = { publishing, sharedGroups: audience ? audience.sharedGroups : undefined };
            if (stamp.kind === 'app') result = await switchApp(ctx, shape, spec);
            else if (stamp.kind === 'webpage') result = await switchWebpage(ctx, shape, spec);
            else result = await switchAgent(ctx, shape, spec);
        } else {
            throw new HttpError(400, 'part_not_switchable', 'This kind of part has no switch.');
        }
        await logOn(d, stage.projectId, userId, 'stage_part_switched', {
            targetType: stamp.kind, targetId: stamp.entityId, ref: stamp.ref, active: active ?? null, audience: !!audience,
        });
        res.json({ ref: stamp.ref, kind: stamp.kind, ...result });
    }

    /** Pause (stage-wide automation switch off) or resume (exactly that set back on). */
    async function setPaused(ctx, pause, { expectedVersion } = {}) {
        const { stage, userId } = ctx;
        const failed = [];
        if (pause) {
            if (stage.pausedState) return { changed: false, stage, failed, count: 0 };
            const automations = await d.automationStore.getAutomationsForProject(stage.projectId, { kinds: ['automation'] });
            const on = automations.filter(a => a.isActive === true);
            // The record first: a crash half way leaves a set that Resume can restore.
            const updated = await d.stageStore.setPausedState(stage.projectId,
                { automations: on.map(a => a.id), pausedAt: iso(d), pausedBy: userId }, { expectedVersion });
            if (!updated) throw notFound('stage_not_found', 'This stage does not exist.');
            for (const a of on) {
                try { await d.goLive.deactivateCore({ automation: a, actorId: userId }); } catch (err) {
                    failed.push({ id: a.id, code: (err && err.code) || 'deactivate_failed' });
                    log.warn(`[stages] pause: automation ${a.id} not switched off: ${err && err.message}`);
                }
            }
            return { changed: true, stage: updated, failed, count: on.length };
        }

        if (!stage.pausedState) return { changed: false, stage, failed, count: 0 };
        const state = isObject(stage.pausedState) ? stage.pausedState : {};
        const ids = Array.isArray(state.automations) ? state.automations : [];
        let count = 0;
        for (const id of ids) {
            const a = await d.automationStore.getAutomation(id);
            // Only what the stage still owns, and only what is not on already.
            if (!a || a.projectId !== stage.projectId || a.isActive === true) continue;
            if (a.liveVersion == null) continue;
            try {
                const r = await d.goLive.activateCore({ automation: a, actorId: userId, organizationId: stage.organizationId || null });
                if (r.ok) count += 1; else failed.push({ id, code: r.code || 'go_live_refused' });
            } catch (err) {
                failed.push({ id, code: (err && err.code) || 'activate_failed' });
                log.warn(`[stages] resume: automation ${id} not switched on: ${err && err.message}`);
            }
        }
        // What could not come back on stays recorded, and the stage stays paused.
        const updated = await d.stageStore.setPausedState(stage.projectId,
            failed.length ? { ...state, automations: failed.map(f => f.id) } : null, { expectedVersion });
        return { changed: true, stage: updated || stage, failed, count };
    }

    function pauseHandler(pause) {
        return async function pauseResume(req, res) {
            const ctx = req.stageCtx;
            const out = await setPaused(ctx, pause);
            if (out.changed) {
                await logOn(d, ctx.stage.projectId, ctx.userId, pause ? 'stage_paused' : 'stage_resumed', {
                    targetType: 'project', targetId: ctx.stage.projectId, count: out.count, failed: out.failed.length, viaOrgAdmin: ctx.viaOrgAdmin,
                });
                await notifyOwnerOfAdmin(d, ctx, pause ? 'paused' : 'resumed');
            }
            res.json({
                paused: !!(out.stage && out.stage.pausedState), changed: out.changed, count: out.count, failed: out.failed,
                settingsVersion: out.stage ? out.stage.settingsVersion : ctx.stage.settingsVersion, enabled: out.stage ? out.stage.enabled === true : undefined,
            });
        };
    }

    /**
     * GET /:id/stages/:stage/variables and the drain router's: the declarations
     * (steering marked) and what was entered, next to what runs.
     */
    async function getValues(req, res) {
        const ctx = req.stageCtx;
        const target = ctx.stageName === 'dev' ? ctx.dev.id : ctx.stage.projectId;
        const [decls, values] = await Promise.all([declarationsFor(d, ctx), d.stageStore.listVariableValues(target)]);
        res.json({
            stage: ctx.stageName,
            variables: [...decls.values()].map(publicDecl),
            values: values.map(v => ({ name: v.name, value: v.value, appliedValue: v.appliedValue, updatedAt: v.updatedAt })),
            bindingsPending: ctx.stage ? ctx.stage.bindingsPending === true : false,
        });
    }

    /**
     * PUT /:id/stages/:stage/variables (`:stage` may be dev) and the drain
     * router's (`opts.drain`: non-steering values only, whoever asks).
     */
    function putValuesHandler({ drain = false } = {}) {
        return async function putValues(req, res) {
            const ctx = req.stageCtx;
            const onDev = ctx.stageName === 'dev';
            const target = onDev ? ctx.dev.id : ctx.stage.projectId;
            const isOwner = onDev ? ctx.devRole === 'owner' : ctx.stageRole === 'owner';
            const decls = await declarationsFor(d, ctx);
            const typed = {};
            // Owner-only names (D18) on every target; on a stage they also wait
            // for a deployment. Dev has no deployment, so its values go live at once.
            const steeringNames = [];
            const { coerceValue } = require('../../../stores/solutionStage/variables');
            for (const [name, value] of Object.entries(req.body.values)) {
                const decl = decls.get(name);
                if (!decl) throw new HttpError(400, 'variable_unknown', `"${name.slice(0, 80)}" is not a variable of this Solution.`, { name: name.slice(0, 80) });
                if (steeringOf(decl)) {
                    if (drain) throw new HttpError(403, 'steering_not_here', 'A steering value changes through a deployment, not from here.', { name });
                    if (!isOwner) throw new HttpError(403, 'steering_owner_only', 'Only the Solution owner can change a value that steers where data or mail goes.', { name });
                    steeringNames.push(name);
                }
                if (value === null) { typed[name] = null; continue; }
                const coerced = coerceValue(decl.type || 'text', value, decl.choices);
                if (coerced === undefined) throw new HttpError(400, 'variable_invalid', `The value of "${name}" is not a valid ${decl.type || 'text'}.`, { name, type: decl.type || 'text' });
                typed[name] = coerced;
            }
            const out = await d.stageStore.setVariableValues(target, typed, ctx.userId, { steeringNames: onDev ? [] : steeringNames });
            const row = onDev ? null : await d.stageStore.getStage(target);
            await logOn(d, onDev ? ctx.dev.id : target, ctx.userId, 'stage_variables_changed', {
                targetType: 'project', targetId: target, names: Object.keys(typed), steering: steeringNames.length,
            });
            res.json({ written: out.written, pending: out.pending === true, bindingsPending: row ? row.bindingsPending === true : false });
        };
    }

    return {
        patchPart, pause: pauseHandler(true), resume: pauseHandler(false), setPaused,
        getValues, putValues: putValuesHandler(), putValuesDrain: putValuesHandler({ drain: true }),
    };
}

// ── Settings of a stage, bindings, variables, options ─────────────────────────

const sameJson = (a, b) => stableStringify(a ?? null) === stableStringify(b ?? null);

function settingsView(row) {
    return {
        stage: row.stage, projectId: row.projectId, settingsVersion: row.settingsVersion, enabled: row.enabled === true,
        paused: !!row.pausedState, newPartsActive: row.newPartsActive === true, requiresApproval: row.requiresApproval === true,
        approvalPolicy: row.approvalPolicy ?? null, rollbackNeedsApproval: row.rollbackNeedsApproval === true,
        bindingsPending: row.bindingsPending === true,
    };
}

function makeSettingsRouter(d, h) {
    const router = express.Router({ mergeParams: true });
    const hasGateFields = (req) => !!req.body && S.GATE_FIELDS.some(k => req.body[k] !== undefined);
    const turnsGateOn = (req) => !!req.body && req.body.requiresApproval === true;

    /** PATCH /:id/stages/:stage */
    async function patchStage(req, res) {
        const ctx = req.stageCtx;
        const { stage, userId } = ctx;
        const body = req.body;
        const isOwner = ctx.stageRole === 'owner';
        const gateFields = S.GATE_FIELDS.filter(k => body[k] !== undefined);
        if ((gateFields.length || body.newPartsActive !== undefined) && !isOwner) {
            throw new HttpError(403, 'insufficient_permissions', 'Only the Solution owner can change these settings. A stage editor can switch the stage on and off.');
        }
        if (stage.stage === 'uat' && gateFields.length) {
            throw new HttpError(400, 'approval_not_on_uat', 'Only Production has an approval gate.');
        }
        if (body.settingsVersion !== stage.settingsVersion) {
            throw new HttpError(409, 'settings_stale', 'The stage settings changed in the meantime. Reload and try again.', { settingsVersion: stage.settingsVersion });
        }

        // The gate (D19): turning it ON is a plain write; once it is on, any change to it is a deployment.
        let gatePatch = null;
        const direct = {};
        if (body.newPartsActive !== undefined) direct.newPartsActive = body.newPartsActive;
        if (gateFields.length) {
            const nextOn = body.requiresApproval !== undefined ? body.requiresApproval : stage.requiresApproval;
            const nextPolicy = body.approvalPolicy !== undefined ? body.approvalPolicy : stage.approvalPolicy;
            const nextRollback = body.rollbackNeedsApproval !== undefined ? body.rollbackNeedsApproval : stage.rollbackNeedsApproval;
            if (nextOn) {
                await d.approvalGate.validatePolicy(nextPolicy, { orgId: stage.organizationId || null, ownerId: stage.runAsUserId }, {});
            }
            const changes = {};
            if (nextOn !== stage.requiresApproval) changes.requiresApproval = nextOn;
            if (body.approvalPolicy !== undefined && !sameJson(nextPolicy, stage.approvalPolicy)) changes.approvalPolicy = nextPolicy;
            if (nextRollback !== stage.rollbackNeedsApproval) changes.rollbackNeedsApproval = nextRollback;
            if (Object.keys(changes).length) {
                if (stage.requiresApproval === true) gatePatch = changes;
                else Object.assign(direct, changes);
            }
        }

        let current = stage;
        if (Object.keys(direct).length) {
            current = await d.stageStore.updateStageSettings(stage.projectId, body.settingsVersion, direct);
        }
        if (body.enabled !== undefined && body.enabled !== current.enabled) {
            const out = await h.setPaused({ ...ctx, stage: current }, body.enabled === false);
            if (out.stage) current = out.stage;
            if (out.changed) {
                await logOn(d, stage.projectId, userId, body.enabled ? 'stage_resumed' : 'stage_paused', { targetType: 'project', targetId: stage.projectId, count: out.count });
            }
        }
        if (Object.keys(direct).length) {
            await logOn(d, stage.projectId, userId, 'stage_settings_changed', { targetType: 'project', targetId: stage.projectId, fields: Object.keys(direct) });
        }

        if (gatePatch) {
            const planned = await d.plan({ stageProjectId: stage.projectId, kind: 'settings', settingsPatch: gatePatch }, d.planDeps);
            const { deployment } = await d.runner.admit({
                solutionId: ctx.dev.id, stage: stage.stage, releaseId: null, kind: 'settings', planHash: planned.planHash,
                requestKey: `settings:${stage.projectId}:${crypto.randomUUID()}`,
                acknowledgements: [], actor: { id: userId }, settingsPatch: gatePatch,
            });
            await logOn(d, stage.projectId, userId, 'stage_gate_change_requested', { targetType: 'deployment', targetId: deployment.id, fields: Object.keys(gatePatch) });
            return res.status(202).json({ deployment: deploymentView(deployment), settings: settingsView(current) });
        }
        res.json(settingsView(current));
    }

    router.patch('/:id/stages/:stage', authMw(d, { stage: 'editor' }), validate({ body: S.PatchStageBody }),
        gate(d, 'blueprint_packaging', hasGateFields), gate(d, 'approvals', turnsGateOn), patchStage);

    /** GET /:id/stages/:stage/requirements */
    router.get('/:id/stages/:stage/requirements', gate(d, 'projects'), authMw(d, { stage: 'editor' }), validate({ query: S.RequirementsQuery }), async (req, res) => {
        const ctx = req.stageCtx;
        const { dev, stage } = ctx;
        let release = null;
        if (req.query.releaseId) {
            release = await d.blueprintStore.getRelease(dev.id, req.query.releaseId);
            if (!release || release.channel !== 'pipeline') throw notFound('release_not_found', 'That release does not exist.');
        } else {
            const [latest] = await d.blueprintStore.listPipelineReleases(dev.id, { limit: 1 });
            release = latest ? await d.blueprintStore.getRelease(dev.id, latest.id) : null;
        }
        const slots = release && release.manifest && release.manifest.solution && Array.isArray(release.manifest.solution.slots)
            ? release.manifest.solution.slots : [];
        const bound = new Map((await d.stageStore.listBindings(stage.projectId)).map(b => [b.slot, b]));
        const isOwner = ctx.stageRole === 'owner';
        const bySlot = new Map();
        for (const s of slots) {
            if (!s || typeof s.slot !== 'string') continue;
            const entry = bySlot.get(s.slot) || { slot: s.slot, kind: s.kind || null, label: s.label || s.slot, neededBy: [], suggested: s.suggested ?? null };
            if (s.ref && !entry.neededBy.includes(s.ref)) entry.neededBy.push(s.ref);
            bySlot.set(s.slot, entry);
        }
        const requirements = [...bySlot.values()].map((e) => {
            const row = bound.get(e.slot);
            return {
                slot: e.slot, kind: e.kind, label: e.label, neededBy: e.neededBy, bound: !!row,
                // The Dev value and the stored binding name connections and tables: the owner's to see.
                ...(isOwner ? { suggested: e.suggested, binding: row ? row.value : null } : {}),
            };
        });
        res.json({ release: release ? { id: release.id, seq: release.seq } : null, requirements });
    });

    /** PUT /:id/stages/:stage/bindings */
    router.put('/:id/stages/:stage/bindings', gate(d, 'blueprint_packaging'), authMw(d, { stage: 'owner' }), validate({ body: S.PutBindingsBody }), async (req, res) => {
        const ctx = req.stageCtx;
        const { dev, stage, userId } = ctx;
        if (req.body.settingsVersion !== stage.settingsVersion) {
            throw new HttpError(409, 'settings_stale', 'The stage settings changed in the meantime. Reload and try again.', { settingsVersion: stage.settingsVersion });
        }
        const seen = new Set();
        const rows = [];
        for (const { slot, value } of req.body.bindings) {
            if (seen.has(slot)) throw new HttpError(400, 'binding_invalid', 'A slot can be set once per request.', { slot, why: 'duplicate' });
            seen.add(slot);
            const checked = await d.validateBinding(slot, value, {
                stageProjectId: stage.projectId, solutionId: dev.id, stage: stage.stage,
                runAsUserId: stage.runAsUserId, organizationId: stage.organizationId || null, deps: d.bindingDeps,
            });
            rows.push({ slot: checked.slot, kind: checked.kind, value: checked.value });
        }
        // A binding is written into a locked definition at the next deploy: the bump makes a deployment
        // admitted on the old settings fail its commit, and the mark asks for the redeploy.
        const bumped = await d.stageStore.updateStageSettings(stage.projectId, stage.settingsVersion, {});
        const bindings = await d.stageStore.upsertBindings(stage.projectId, rows, userId);
        await d.stageStore.setBindingsPending(stage.projectId, true);

        let needed = new Set();
        const [latest] = await d.blueprintStore.listPipelineReleases(dev.id, { limit: 1 });
        const ids = [stage.currentReleaseId, latest && latest.id].filter(Boolean);
        for (const id of ids) {
            const release = await d.blueprintStore.getRelease(dev.id, id);
            const slots = release && release.manifest && release.manifest.solution && release.manifest.solution.slots;
            for (const s of Array.isArray(slots) ? slots : []) if (s && s.slot) needed.add(s.slot);
        }
        if (!ids.length) needed = null;
        const ignored = needed ? rows.filter(r => r.value !== null && !needed.has(r.slot)).map(r => r.slot) : [];
        await logOn(d, stage.projectId, userId, 'stage_bindings_changed', { targetType: 'project', targetId: stage.projectId, slots: rows.map(r => r.slot) });
        res.json({
            bindings: bindings.map(b => ({ slot: b.slot, kind: b.kind, value: b.value })),
            ignored, bindingsPending: true, settingsVersion: bumped.settingsVersion,
        });
    });

    /** GET /:id/variables */
    router.get('/:id/variables', gate(d, 'projects'), authMw(d, { dev: 'viewer' }), async (req, res) => {
        const list = await d.stageStore.listVariables(req.stageCtx.dev.id);
        res.json({ variables: list.map(publicDecl) });
    });

    /** PUT /:id/variables */
    router.put('/:id/variables', gate(d, 'blueprint_packaging'), authMw(d, { dev: 'editor' }), validate({ body: S.PutVariablesBody }), async (req, res) => {
        const { dev, userId } = req.stageCtx;
        const { CONNECTOR_SECRET_KEY_RE } = require('../../../core/dataEngine/dataModel/vocabulary');
        const names = new Set();
        const decls = [];
        for (const v of req.body.variables) {
            if (!VARIABLE_NAME_RE.test(v.name)) {
                throw new HttpError(400, 'variable_name_invalid',
                    'A variable name starts with a lowercase letter and holds lowercase letters, digits and underscores (at most 63).', { name: v.name.slice(0, 80) });
            }
            if (CONNECTOR_SECRET_KEY_RE.test(v.name)) {
                throw new HttpError(400, 'variable_secret_name', `"${v.name}" looks like a secret. Store secrets in a connection, not in a variable.`, { name: v.name });
            }
            if (names.has(v.name)) throw new HttpError(400, 'variable_duplicate', `"${v.name}" is declared twice.`, { name: v.name });
            names.add(v.name);
            const type = v.type || 'text';
            if (type === 'choice' && !(Array.isArray(v.choices) && v.choices.length)) {
                throw new HttpError(400, 'variable_choices_missing', `"${v.name}" is a choice and needs its choices.`, { name: v.name });
            }
            decls.push({
                name: v.name, type, choices: type === 'choice' ? v.choices : null, description: v.description || '',
                required: v.required !== false, steering: v.steering === true,
            });
        }
        const saved = await d.stageStore.replaceVariables(dev.id, decls);
        await logOn(d, dev.id, userId, 'solution_variables_declared', { targetType: 'project', targetId: dev.id, count: decls.length });
        res.json({ variables: saved.map(publicDecl) });
    });

    const valueAuth = (min) => authMw(d, { stage: min, devStage: min });
    router.get('/:id/stages/:stage/variables', gate(d, 'projects'), valueAuth('viewer'), h.getValues);
    router.put('/:id/stages/:stage/variables', gate(d, 'projects'), valueAuth('editor'), validate({ body: S.PutValuesBody }), h.putValues);

    router.patch('/:id/stages/:stage/parts/:ref', gate(d, 'projects'), authMw(d, { stage: 'editor' }), validate({ body: S.PatchPartBody }), h.patchPart);
    router.post('/:id/stages/:stage/pause', gate(d, 'projects'), authMw(d, { stage: 'editor', orgAdmin: true }), validate({ body: S.EmptyBody }), h.pause);
    router.post('/:id/stages/:stage/resume', gate(d, 'projects'), authMw(d, { stage: 'editor', orgAdmin: true }), validate({ body: S.EmptyBody }), h.resume);

    /** PATCH /:id/parts/:ref/options */
    router.patch('/:id/parts/:ref/options', gate(d, 'blueprint_packaging'), authMw(d, { dev: 'owner' }), validate({ body: S.PartOptionsBody }), async (req, res) => {
        const { dev, userId } = req.stageCtx;
        const row = (await d.blueprintStore.refsFor(dev.id)).find(r => r.ref === req.params.ref && !r.retiredAt);
        if (!row) throw notFound('part_not_found', 'This part is not in the Solution.');
        const body = req.body;
        if (body.reference !== undefined && row.kind !== 'datatables') {
            throw new HttpError(400, 'option_not_for_kind', 'Only a table can be a reference table.');
        }
        if ((body.contentMode !== undefined || body.acks !== undefined) && row.kind !== 'knowledgeBases') {
            throw new HttpError(400, 'option_not_for_kind', 'Only a knowledge base carries content.');
        }
        const existing = await d.stageStore.getPartOptions(dev.id, { ref: row.ref });
        const options = { ...(existing && existing.options ? existing.options : {}), ...body };
        const saved = await d.stageStore.setPartOption(dev.id, { ref: row.ref, kind: row.kind, options }, userId);
        await logOn(d, dev.id, userId, 'solution_part_options_changed', { targetType: row.kind, ref: row.ref, fields: Object.keys(body) });
        res.json({ ref: row.ref, kind: row.kind, options: saved.options });
    });

    return router;
}

module.exports = { makeSettingsHandlers, makeSettingsRouter, declarationsFor, steeringOf, settingsView };
