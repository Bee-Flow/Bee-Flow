/**
 * Compensation (design 6.5): put a stage back the way it was before a
 * deployment that failed before (or during) its commit. The live copies were
 * never moved (prepare writes only non-live slots, and a failed commit rolled
 * back), so what is left to undo is exactly what prepare journaled:
 *
 *   create            a part this deployment created: deleted (with its
 *                     capability; it was never live)
 *   write_working     an automation's working copy: reset to its live definition
 *   write_definition  an app's definition: reset to its published definition
 *   write_agent       an agent's concept: reset to its published prompt and
 *                     config, its labels to what the journal recorded
 *   webpage_version   the new snapshot is deleted unless something pins it;
 *                     the page's grants and metadata go back
 *   kb_shell          a knowledge base's labels go back
 *   deactivate,       (a `remove` deployment's prepare) an automation switched off
 *   unpublish         is switched on again, an unpublished part republished
 *   data_model        stays: an additive change is harmless to the older release
 *   template_version  stays: an unreferenced revision changes nothing
 *
 * It runs while the deployment row is `compensating`, which is still in the
 * active set, so the capability (`managedWrite`) the store guards ask for is
 * valid for every reset. Every undo is best-effort and journaled in the
 * `compensate` phase (done / failed); one failure never stops the others.
 * Pending rows count too: a write may have landed before its journal row was
 * marked done.
 */

'use strict';

const log = require('../../telemetry/log');
const { storesOf, makeJournal } = require('./prepare');

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** Delete a part this deployment created, by kind. */
const DELETERS = {
    automation: (s, id, { managedWrite }) => s.automationStore.deleteAutomation(id, { managedWrite }),
    app: (s, id, { managedWrite, runAs }) => s.studioAppStore.deleteStudioApp(id, runAs, { managedWrite }),
    webpage: (s, id, { managedWrite, runAs }) => s.webpageStore.deleteWebpage(id, runAs, { managedWrite }),
    datatable: (s, id, { managedWrite, stage }) => s.datatableDbStore.dropDatatable(id, s.datatableStore.orgScope(stage.organizationId), { managedWrite }),
    agent: (s, id, { managedWrite, runAs }) => s.agentStore.deleteAgent(id, runAs, { managedWrite }),
    knowledge_base: (s, id, { managedWrite }) => s.kbStore.deleteKB(id, { managedWrite }),
    skill: (s, id, { managedWrite, runAs }) => s.skillStore.deleteSkill(id, runAs, false, { managedWrite }),
    async document(s, id, { managedWrite, runAs, stage, deps }) {
        await s.templates.clearTemplateSolution(id, stage.projectId, runAs, { managedWrite });
        const documentStore = dep(deps, 'documentStore', () => require('../../stores/documentStore'));
        return documentStore.deleteDocument(id, runAs);
    },
};

const UNDO = {
    async create(s, step, ctx) {
        if (!step.entityId) return 'skipped';
        const del = DELETERS[step.kind];
        if (!del) return 'skipped';
        await del(s, step.entityId, ctx);
        return 'done';
    },

    async write_working(s, step, { runAs, managedWrite }) {
        const a = await s.automationStore.getAutomation(step.entityId);
        if (!a) return 'skipped';
        const b = isObject(step.before) ? step.before : {};
        const updates = {};
        // A layout-only write does not bump the version, so the definition is reset whatever the versions say.
        if (a.liveDefinition) updates.definition = a.liveDefinition;
        if (typeof b.title === 'string' && b.title !== a.title) updates.title = b.title;
        if (typeof b.description === 'string' && b.description !== (a.description || '')) updates.description = b.description;
        if (!Object.keys(updates).length) return 'skipped';
        await s.automationStore.updateAutomation(step.entityId, updates, runAs, { managedWrite });
        return 'done';
    },

    async write_definition(s, step, { runAs, managedWrite }) {
        const app = await s.studioAppStore.getStudioApp(step.entityId);
        if (!app) return 'skipped';
        const b = isObject(step.before) ? step.before : {};
        const meta = {};
        for (const key of ['name', 'description', 'icon', 'accentColor']) {
            if (b[key] !== undefined && (app[key] ?? null) !== (b[key] ?? null)) meta[key] = b[key];
        }
        if (Object.keys(meta).length && typeof s.studioAppStore.updateStudioApp === 'function') {
            await s.studioAppStore.updateStudioApp(step.entityId, meta, runAs, { managedWrite });
        }
        if (!app.publishedDefinition) return Object.keys(meta).length ? 'done' : 'skipped';
        await s.studioAppStore.saveDefinition(step.entityId, runAs, app.publishedDefinition, { managedWrite });
        return 'done';
    },

    async write_agent(s, step, { runAs, managedWrite }) {
        const views = await s.agentStore.getAgentViews(step.entityId);
        if (!views) return 'skipped';
        const draft = views.draft || {};
        const runtime = views.runtime || {};
        const b = isObject(step.before) ? step.before : {};
        const out = await s.agentStore.updateAgent(step.entityId,
            b.name ?? draft.name, b.description ?? draft.description ?? '',
            runtime.system_prompt ?? draft.system_prompt ?? '', runAs,
            b.model !== undefined ? b.model : (draft.model || null),
            Array.isArray(b.starterPrompts) ? b.starterPrompts : (draft.starter_prompts || []),
            b.avatar !== undefined ? b.avatar : (draft.avatar || null),
            b.threadsEnabled !== false, b.copyEnabled !== false, b.workspaceEnabled === true,
            isObject(runtime.config) ? runtime.config : (draft.config || {}), draft.embed_enabled === true,
            undefined, undefined, undefined, { managedWrite });
        return out && out.ok === false ? 'failed' : 'done';
    },

    async webpage_version(s, step, { runAs, managedWrite }) {
        const page = await s.webpageStore.getWebpageRaw(step.entityId);
        if (!page) return 'skipped';
        const versionId = isObject(step.detail) ? step.detail.versionId : null;
        if (versionId && page.publishedVersionId !== versionId) {
            await s.webpageStore.deleteVersion(runAs, versionId, step.entityId, { managedWrite });
        }
        const b = isObject(step.before) ? step.before : null;
        if (!b) return 'done';
        if (isObject(b.grants)) {
            await s.webpageStore.updateBridgeGrants(step.entityId, runAs, {
                automations: (b.grants.automations || []).map(automationId => ({ automationId })),
                tables: (b.grants.tables || []).map(t => ({ ...t, publicColumns: [] })),
                integrations: (b.grants.integrations || []).map(tool => ({ tool })),
                agent: b.grants.agentId ? { agentId: b.grants.agentId } : null,
            }, { managedWrite });
        }
        const meta = { name: b.name, description: b.description, knowledgeBaseIds: b.knowledgeBaseIds || [] };
        if (b.slug) meta.slug = b.slug;
        await s.webpageStore.updateWebpageMetadata(step.entityId, runAs, meta, { managedWrite });
        return 'done';
    },

    async kb_shell(s, step, { managedWrite }) {
        const b = isObject(step.before) ? step.before : null;
        if (!b) return 'skipped';
        await s.kbStore.updateKB(step.entityId, { name: b.name, description: b.description, icon: b.icon }, { managedWrite });
        return 'done';
    },

    async deactivate(s, step, { runAs, stage, deps }) {
        const b = isObject(step.before) ? step.before : {};
        if (b.isActive !== true) return 'skipped';
        const a = await s.automationStore.getAutomation(step.entityId);
        if (!a || a.isActive) return 'skipped';
        const { activateCore } = dep(deps, 'goLive', () => require('../../automation/goLive'));
        const aiActState = dep(deps, 'aiActState', () => require('../../automation/aiActCheck').defaultAiActState());
        const out = await activateCore({ automation: a, actorId: runAs, organizationId: stage.organizationId || null,
            deps: { aiActState, ...(deps.goLiveDeps || {}) } });
        return out && out.ok === false ? 'failed' : 'done';
    },

    async unpublish(s, step, { runAs, managedWrite }) {
        const b = isObject(step.before) ? step.before : {};
        if (b.isPublished !== true) return 'skipped';
        if (step.kind === 'app') await s.studioAppStore.setStudioAppAudience(step.entityId, runAs, { isPublished: true, managedWrite });
        else if (step.kind === 'webpage') await s.webpageStore.setWebpagePublished(step.entityId, true, runAs);
        else if (step.kind === 'agent') await s.agentStore.setAgentPublished(step.entityId, true, runAs);
        else return 'skipped';
        return 'done';
    },
};

/**
 * Undo a deployment's prepare, newest write first.
 *
 * @param {{ deployment: object, stage: object }} input  the row is `compensating`
 * @param {object} [deps]  stores (prepare.storesOf), `goLive`, `goLiveDeps`, `aiActState`, `documentStore`
 * @returns {Promise<{ undone: number, failed: number, skipped: number }>}
 */
async function compensate({ deployment, stage }, deps = {}) {
    const s = storesOf(deps);
    const ctx = { stage, deps, runAs: stage.runAsUserId, managedWrite: { deploymentId: deployment.id } };
    const journal = makeJournal(s.stageStore, deployment.id, 'compensate');
    const steps = (await s.stageStore.listSteps(deployment.id, { phase: 'prepare' }))
        .filter(st => st.status === 'done' || st.status === 'pending')
        .sort((a, b) => b.seq - a.seq);
    const out = { undone: 0, failed: 0, skipped: 0 };
    for (const step of steps) {
        const undo = UNDO[step.action];
        if (!undo) { out.skipped += 1; continue; }
        const row = { ref: step.ref, kind: step.kind, entityId: step.entityId, detail: { undoes: step.seq } };
        try {
            const result = await undo(s, step, ctx);
            if (result === 'failed') {
                out.failed += 1;
                await journal.record(`undo_${step.action}`, row, 'failed');
            } else if (result === 'skipped') {
                out.skipped += 1;
            } else {
                out.undone += 1;
                await journal.record(`undo_${step.action}`, row, 'done');
            }
        } catch (err) {
            out.failed += 1;
            log.warn(`[stages/compensate] ${deployment.id} could not undo ${step.action} of ${step.ref || step.entityId}: ${err && err.message}`);
            try { await journal.record(`undo_${step.action}`, row, 'failed'); } catch { /* the journal is best-effort here */ }
        }
    }
    return out;
}

module.exports = { compensate, UNDO, DELETERS };
