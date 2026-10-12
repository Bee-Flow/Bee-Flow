/**
 * PREPARE, the first phase of a release deployment (design 6.4, 6.5).
 *
 * Everything here writes only NON-LIVE slots of the stage, so a run that
 * starts while a deployment prepares still executes what the stage ran
 * before (D6, D17):
 *
 *   1. create the parts the stage does not have yet, through the install
 *      engine's `installOne` (inactive / unpublished, owned by the run-as user,
 *      filed into the stage project, the datatable key `<key>__<stage>`, step
 *      ids kept: `rekey: false`). A skill is only computed (the commit writes
 *      it); a template is created with the revision an automation pins.
 *   2. bind every release entity the way the plan did (`$ref` → stage ids,
 *      the bindings, literal Dev table ids in page code), now that every part
 *      has an id, and pin each `fill_document` step to its stage template's
 *      revision.
 *   3. write the working copies with the deployment's capability
 *      (`managedWrite`): an automation's working copy (updateAutomation), an app's
 *      definition (saveDefinition), an agent's concept (updateAgent), a page's
 *      new version snapshot (createVersionSnapshotFromFiles), a template's
 *      new revision (createVersionRow). An app's own data model is applied now,
 *      additive only (the stated exception of D6; never compensated).
 *   4. tables: the per-table target is computed here only to hash the stamp
 *      and, in PRD, to run the schema DDL once in a transaction that rolls
 *      back (the preflight); the commit builds it again under the model lock.
 *   5. verify the TARGET stage: completeness over the stage graph, readiness,
 *      the cross-stage scan, and the go-live checks of every automation that will
 *      be active (owner = run-as). Any blocking finding fails the deployment
 *      ("Nothing changed in <stage>"), and the runner compensates.
 *
 * Every write is journaled BEFORE it is made (`pending`, with the ids and
 * versions compensation needs in `before`) and marked `done` after, so a
 * crash between the two still leaves a row compensation acts on. A journal row
 * holds ids, versions, hashes and counts, never content (`detail`).
 *
 * The result (`prepared`) is handed to the commit in memory: a crash after
 * prepare is compensated, never committed, so nothing needs to survive it.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');
const log = require('../../telemetry/log');
const { KIND_OF_SECTION, canonicalOf, hashPayload } = require('./stagePayload');

const dep = (deps, name, load) => (deps && deps[name] !== undefined ? deps[name] : load());
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const blocking = (code, extra = {}) => ({ code, severity: 'blocking', ...extra });

/** The datatable key grammar allows 63 characters (vocabulary.js KEY_RE). */
const MAX_TABLE_KEY = 63;
/** Parts are created in this order: what others point AT first (install.js's order). */
const CREATE_ORDER = Object.freeze(['datatable', 'knowledge_base', 'document', 'block', 'layer', 'automation',
    'app', 'webpage', 'skill', 'agent']);
/** Actions that write a part. `unchanged` writes nothing. */
const WRITE_ACTIONS = Object.freeze(['create', 'replace', 'revive']);

/** The stores and engine modules prepare (and the later phases) use; each one injectable. */
function storesOf(deps = {}) {
    return {
        get stageStore() { return dep(deps, 'solutionStageStore', () => require('../../stores/solutionStageStore')); },
        get blueprintStore() { return dep(deps, 'blueprintStore', () => require('../../stores/blueprintStore')); },
        get automationStore() { return dep(deps, 'automationStore', () => require('../../stores/automationStore')); },
        get studioAppStore() { return dep(deps, 'studioAppStore', () => require('../../stores/studioAppStore')); },
        get studioAppDataStore() { return dep(deps, 'studioAppDataStore', () => require('../../stores/studioAppDataStore')); },
        get webpageStore() { return dep(deps, 'webpageStore', () => require('../../stores/webpageStore')); },
        get agentStore() { return dep(deps, 'agentStore', () => require('../../stores/agentStore')); },
        get kbStore() { return dep(deps, 'kbStore', () => require('../../stores/knowledgeBases')); },
        get datatableStore() { return dep(deps, 'datatableStore', () => require('../../stores/datatableStore')); },
        get datatableDbStore() { return dep(deps, 'datatableDbStore', () => require('../../stores/datatableDbStore')); },
        get projectStore() { return dep(deps, 'projectStore', () => require('../../stores/projectStore')); },
        get skillStore() { return dep(deps, 'skillStore', () => require('../../stores/skillStore')); },
        get templates() { return dep(deps, 'solutionTemplates', () => require('../../stores/document/solutionTemplates')); },
        get install() { return dep(deps, 'install', () => require('../packaging/install')); },
        get withTransaction() { return dep(deps, 'withTransaction', () => require('../../db').withTransaction); },
    };
}

// ── The journal ──────────────────────────────────────────────────────────────

/**
 * A journal over one deployment and phase: `pending(action, row)` writes the
 * row before the write it describes and answers a `done(patch)` /
 * `failed()` pair; `record(action, row)` writes a finished row at once.
 * `row` is `{ ref, kind, entityId, before, afterHash, detail }`; `detail`
 * holds ids, versions and counts only.
 */
function makeJournal(stageStore, deploymentId, phase, { client = null } = {}) {
    const opts = client ? { client } : {};
    return {
        async pending(action, row = {}) {
            const step = await stageStore.appendStep(deploymentId, { phase, action, status: 'pending', ...row }, opts);
            return {
                seq: step.seq,
                done: (patch = {}) => stageStore.updateStep(deploymentId, step.seq, { status: 'done', ...patch }, opts),
                failed: (patch = {}) => stageStore.updateStep(deploymentId, step.seq, { status: 'failed', ...patch }, opts),
            };
        },
        record(action, row = {}, status = 'done') {
            return stageStore.appendStep(deploymentId, { phase, action, status, ...row }, opts);
        },
    };
}

/** `<key>__<stage>`, shortened so the whole key fits the grammar. */
function stageTableKey(key, stage) {
    const tail = `__${stage}`;
    return `${String(key || 'table').slice(0, MAX_TABLE_KEY - tail.length)}${tail}`;
}

/** The release's entities with their section, kind and install kind, by ref. */
function releaseEntities(manifest) {
    const out = new Map();
    const entities = (manifest && manifest.solution && manifest.solution.entities) || {};
    for (const [section, kind] of Object.entries(KIND_OF_SECTION)) {
        for (const entity of Array.isArray(entities[section]) ? entities[section] : []) {
            if (!isObject(entity) || typeof entity.ref !== 'string') continue;
            const installKind = kind === 'automation' && ['block', 'layer'].includes(entity.kind) ? entity.kind : kind;
            out.set(entity.ref, { ref: entity.ref, section, kind, installKind, entity });
        }
    }
    return out;
}

/** Dev table id → stage table id, through the ledger's refs (literal table tokens in page code). */
async function tableTokens(solutionId, idByRef, blueprintStore) {
    const out = new Map();
    if (typeof blueprintStore.refsFor !== 'function') return out;
    for (const row of await blueprintStore.refsFor(solutionId)) {
        if (row.kind !== 'datatables') continue;
        const stageId = idByRef.get(row.ref);
        if (stageId) out.set(row.entityId, stageId);
    }
    return out;
}

/** The plan row for a ref (its action, goesLive); a part the plan did not list is a create. */
function planned(plan, ref) {
    const parts = Array.isArray(plan && plan.parts) ? plan.parts : [];
    return parts.find(p => p && p.ref === ref) || null;
}

// ── 1. Create ───────────────────────────────────────────────────────────────

async function createMissing(ctx) {
    const { s, release, entities, plan, idByRef, stage, journal, managedWrite } = ctx;
    const report = {};
    const installCtx = s.install.makeInstallCtx({
        ownerId: stage.runAsUserId,
        organizationId: stage.organizationId,
        projectId: stage.projectId,
        refMap: idByRef,
        rekey: false,
        scope: s.datatableStore.orgScope(stage.organizationId),
        datatableKeyFor: (e) => stageTableKey(e.key, stage.stage),
        dataModelOptions: { managedWrite, additiveOnly: true },
        managedWrite,
        installedVersion: Number.isInteger(release.seq) && release.seq > 0 ? release.seq : 1,
        releaseId: release.id,
    });
    ctx.installCtx = installCtx;
    const toCreate = [...entities.values()].filter((e) => {
        const p = planned(plan, e.ref);
        return !p || p.action === 'create' || p.missing === true;
    });
    toCreate.sort((a, b) => CREATE_ORDER.indexOf(a.installKind) - CREATE_ORDER.indexOf(b.installKind));
    for (const e of toCreate) {
        // A missing part's stamp still names the gone entity: forget it, so the ref is created anew.
        idByRef.delete(e.ref);
        const step = await journal.pending('create', { ref: e.ref, kind: e.kind });
        // A page is created empty: its files arrive as the version snapshot the commit pins (D16), and
        // its `current/` slots are written in converge.
        const entity = e.kind === 'webpage' ? { ...e.entity, files: {} } : e.entity;
        const id = e.installKind === 'block'
            ? await createBlock(ctx, e)
            : await s.install.installOne(e.installKind, entity, installCtx, report);
        if (!id) {
            await step.failed();
            const skipped = (report.skipped || []).find(r => r && r.ref === e.ref);
            log.warn(`[stages/prepare] ${ctx.deployment.id} could not create ${e.ref}: ${skipped ? skipped.why : 'unknown'}`);
            throw new HttpError(409, 'part_create_failed', `"${e.ref}" could not be created in the stage.`,
                { ref: e.ref, kind: e.kind, ...(skipped && skipped.permanent ? { permanent: true } : {}) });
        }
        await step.done({ entityId: id });
        ctx.created.set(e.ref, id);
        if (e.kind === 'knowledge_base') await attachKnowledgeBase(ctx, id);
    }
    for (const c of (report.computed && report.computed.skills) || []) ctx.computedSkills.set(c.ref, c.id);
}

/**
 * A reusable Step (`kind = 'block'`) is created as one: the install path's
 * createAutomation makes every row a plain automation, and the commit flips a
 * block's published_version, which only a block row has. Its working copy
 * is written with the rest.
 */
async function createBlock(ctx, e) {
    const { s, stage, managedWrite, idByRef } = ctx;
    const created = await s.automationStore.createStep({
        userId: stage.runAsUserId, organizationId: stage.organizationId || null,
        title: e.entity.title || 'Untitled step', description: e.entity.description || '', definition: {},
    });
    await s.automationStore.updateAutomation(created.id, { projectId: stage.projectId }, stage.runAsUserId, { managedWrite });
    idByRef.set(e.ref, created.id);
    return created.id;
}

/** A created knowledge base joins the stage project's list (the install path files it only with a request). */
async function attachKnowledgeBase(ctx, kbId) {
    const { s, stage, managedWrite } = ctx;
    const project = await s.projectStore.getProject(stage.projectId);
    const ids = Array.isArray(project && project.knowledgeBaseIds) ? project.knowledgeBaseIds : [];
    if (ids.includes(kbId)) return;
    await s.projectStore.updateProject(stage.projectId, { knowledgeBaseIds: [...ids, kbId] }, { managedWrite });
}

// ── 2. Bind ─────────────────────────────────────────────────────────────────

/** Stage template id → the revision its automations pin: a new revision for a replaced template. */
async function templateRevisions(ctx) {
    const { s, entities, plan, idByRef, journal, managedWrite } = ctx;
    const pins = new Map(ctx.installCtx.templateVersions);
    for (const e of entities.values()) {
        if (e.kind !== 'document') continue;
        const id = idByRef.get(e.ref);
        if (!id || pins.has(id)) continue;
        const p = planned(plan, e.ref);
        if (p && WRITE_ACTIONS.includes(p.action)) {
            const fields = s.install.templateFieldsOf(e.entity);
            const step = await journal.pending('template_version', { ref: e.ref, kind: 'document', entityId: id });
            const versionId = await s.templates.createVersionRow(id,
                { bodyHtml: fields.bodyHtml, css: fields.css, settings: fields.settings, summary: `Release ${ctx.release.seq}` },
                { managedWrite });
            await step.done({ detail: { versionId } });
            pins.set(id, versionId);
            ctx.templates.push({ ref: e.ref, id, fields });
        } else {
            const row = await ctx.readShape('document', id);
            if (row && row.version_id) pins.set(id, row.version_id);
        }
    }
    return pins;
}

async function bindAll(ctx) {
    const { s, entities, idByRef, bindings, slots, stage, plan } = ctx;
    const { bindReleaseEntity, dataDiff } = dep(ctx.deps, 'planModule', () => require('./plan'));
    const tokens = await tableTokens(stage.solutionId, idByRef, s.blueprintStore);
    const pins = await templateRevisions(ctx);
    for (const e of entities.values()) {
        const bound = bindReleaseEntity(e.kind, e.entity, { idByRef, bindings, slots, tableTokens: tokens });
        const missed = bound.unresolved.filter(r => entities.has(r));
        if (missed.length) {
            throw new HttpError(409, 'part_unresolved', `"${e.ref}" points at a part the stage does not have.`, { ref: e.ref, refs: missed });
        }
        const entity = bound.entity;
        if (e.kind === 'automation') s.install.pinTemplateVersions(entity.definition, pins);
        const id = idByRef.get(e.ref) || ctx.computedSkills.get(e.ref) || null;
        const p = planned(plan, e.ref);
        const action = ctx.created.has(e.ref) ? 'create' : (p ? p.action : 'create');
        if (e.kind === 'datatable') {
            const current = ctx.created.has(e.ref) ? null : await ctx.readShape('datatable', id);
            const now = current && current.descriptor ? s.datatableStore.tableFingerprint(current.descriptor) : null;
            // The entry the PLAN saw is what the commit re-checks under the lock (design 3.2 step 6).
            const seen = (Array.isArray(plan && plan.data) ? plan.data : []).find(d => d && d.ref === e.ref);
            const fingerprint = (seen && seen.fingerprint) || now;
            if (seen && seen.fingerprint && now && seen.fingerprint !== now) {
                throw new HttpError(409, 'plan_stale', 'The stage changed since this deployment was planned. Plan it again.', { ref: e.ref, why: 'table_changed' });
            }
            const { diff, retiredFields } = dataDiff(e.entity, current ? { ...current, fingerprint } : null);
            entity.retiredFields = current ? retiredFields : [];
            ctx.tables.push({ ref: e.ref, id, entity, release: e.entity, fingerprint, diff, action });
        }
        if (e.kind === 'app' && isObject(entity.dataModel) && !ctx.created.has(e.ref)) {
            const shape = await ctx.readShape('app', id);
            if (shape && isObject(shape.dataModel)) {
                const merged = s.studioAppDataStore.additiveModel(shape.dataModel, entity.dataModel);
                if (merged.invalid || (merged.refused && merged.refused.length)) {
                    ctx.blocking.push(blocking('app.data_model_not_additive', { ref: e.ref }));
                } else entity.dataModel = merged.model;
            }
        }
        ctx.parts.push({
            ref: e.ref, kind: e.kind, installKind: e.installKind, entityId: id, action,
            newOrRevived: action === 'create' || action === 'revive',
            goesLive: p ? p.goesLive === true : stage.newPartsActive === true,
            entity, releaseEntity: e.entity,
            hash: hashPayload(canonicalOf(e.kind, entity)),
            sourceHash: hashPayload(canonicalOf(e.kind, e.entity)),
        });
    }
}

// ── 3. Write the working copies ─────────────────────────────────────────────

const WRITERS = {
    async automation(ctx, part) {
        const { s, stage, journal, managedWrite } = ctx;
        const a = await s.automationStore.getAutomation(part.entityId);
        if (!a) throw new HttpError(409, 'part_missing', `"${part.ref}" is gone from the stage.`, { ref: part.ref });
        const step = await journal.pending('write_working', {
            ref: part.ref, kind: part.kind, entityId: part.entityId,
            before: { version: a.version, liveVersion: a.liveVersion ?? null, title: a.title, description: a.description || '' },
        });
        const updates = { definition: part.entity.definition || {}, title: part.entity.title || a.title, description: part.entity.description || '' };
        const out = await s.automationStore.updateAutomation(part.entityId, updates, stage.runAsUserId, { managedWrite });
        if (!out) throw new HttpError(409, 'part_missing', `"${part.ref}" could not be written.`, { ref: part.ref });
        await step.done({ afterHash: part.hash, detail: { version: out.version } });
    },

    async app(ctx, part) {
        const { s, stage, journal, managedWrite } = ctx;
        const app = await s.studioAppStore.getStudioApp(part.entityId);
        if (!app) throw new HttpError(409, 'part_missing', `"${part.ref}" is gone from the stage.`, { ref: part.ref });
        const step = await journal.pending('write_definition', {
            ref: part.ref, kind: 'app', entityId: part.entityId,
            before: { definitionVersion: app.definitionVersion ?? null, publishedVersion: app.publishedVersion ?? null,
                name: app.name, description: app.description || '', icon: app.icon || null, accentColor: app.accentColor || null },
        });
        const e = part.entity;
        const meta = {};
        for (const key of ['name', 'description', 'icon', 'accentColor']) {
            const want = key === 'name' ? (e.name || app.name) : (e[key] ?? (key === 'description' ? '' : null));
            if ((app[key] ?? null) !== want) meta[key] = want;
        }
        if (Object.keys(meta).length && typeof s.studioAppStore.updateStudioApp === 'function') {
            await s.studioAppStore.updateStudioApp(part.entityId, meta, stage.runAsUserId, { managedWrite });
        }
        await s.studioAppStore.saveDefinition(part.entityId, stage.runAsUserId, e.definition || {}, { managedWrite });
        const written = await s.studioAppStore.getStudioApp(part.entityId);
        ctx.apps.set(part.entityId, { definition: written.definition, version: written.definitionVersion });
        await step.done({ afterHash: part.hash, detail: { definitionVersion: written.definitionVersion ?? null } });
        if (isObject(e.dataModel) && Array.isArray(e.dataModel.tables) && e.dataModel.tables.length) {
            // Applied now, additive only, outside the commit (D6); never compensated.
            const dm = await journal.pending('data_model', { ref: part.ref, kind: 'app', entityId: part.entityId });
            try {
                const out = await s.studioAppDataStore.saveDataModel(part.entityId, stage.runAsUserId, e.dataModel, { managedWrite, additiveOnly: true });
                if (out && out.ok === false) throw new HttpError(409, 'app.data_model_invalid', 'The app data model was refused.', { ref: part.ref });
            } catch (err) {
                await dm.failed();
                if (err && err.code === 'app.data_model_not_additive') {
                    throw new HttpError(409, 'prepare_blocked', `Nothing changed in ${stage.stage}.`,
                        { findings: [blocking('app.data_model_not_additive', { ref: part.ref })] });
                }
                throw err;
            }
            await dm.done();
        }
    },

    async webpage(ctx, part) {
        const { s, stage, journal, managedWrite, release } = ctx;
        const page = await s.webpageStore.getWebpageRaw(part.entityId);
        if (!page) throw new HttpError(409, 'part_missing', `"${part.ref}" is gone from the stage.`, { ref: part.ref });
        const grantsBefore = await s.webpageStore.getBridgeGrants(part.entityId);
        const step = await journal.pending('webpage_version', {
            ref: part.ref, kind: 'webpage', entityId: part.entityId,
            before: {
                publishedVersionId: page.publishedVersionId || null,
                grants: grantIds(grantsBefore),
                knowledgeBaseIds: Array.isArray(page.knowledgeBaseIds) ? page.knowledgeBaseIds : [],
                slug: page.slug || null, name: page.name, description: page.description || '',
            },
        });
        const e = part.entity;
        const files = isObject(e.files) ? e.files : {};
        const version = await s.webpageStore.createVersionSnapshotFromFiles(part.entityId, stage.runAsUserId,
            { html: files.html || '', css: files.css || '', js: files.js || '' },
            { managedWrite, source: 'published', summary: `Release ${release.seq}`, actorUserId: stage.runAsUserId });
        ctx.webpages.set(part.entityId, version.id);
        await step.done({ afterHash: part.hash, detail: { versionId: version.id } });
        await s.webpageStore.updateBridgeGrants(part.entityId, stage.runAsUserId, stageGrants(e.bridgeGrants), { managedWrite });
        const meta = {
            name: e.name || page.name, description: e.description || '', instructions: e.instructions || '',
            knowledgeBaseIds: Array.isArray(e.knowledgeBaseIds) ? e.knowledgeBaseIds : [],
        };
        // A bound address (slug:<ref>) is written on every write of the page.
        if (typeof e.slug === 'string' && e.slug) meta.slug = e.slug;
        await s.webpageStore.updateWebpageMetadata(part.entityId, stage.runAsUserId, meta, { managedWrite });
    },

    async agent(ctx, part) {
        const { s, stage, journal, managedWrite } = ctx;
        const a = await s.agentStore.getAgent(part.entityId);
        if (!a) throw new HttpError(409, 'part_missing', `"${part.ref}" is gone from the stage.`, { ref: part.ref });
        const e = part.entity;
        const step = await journal.pending('write_agent', {
            ref: part.ref, kind: 'agent', entityId: part.entityId,
            before: {
                rev: a.rev ?? null, name: a.name, description: a.description || '', model: a.model || null,
                starterPrompts: Array.isArray(a.starter_prompts) ? a.starter_prompts : [], avatar: a.avatar || null,
                threadsEnabled: a.threads_enabled !== false, copyEnabled: a.copy_enabled !== false,
                workspaceEnabled: a.workspace_enabled === true,
            },
        });
        const config = isObject(e.config) ? clone(e.config) : {};
        if (isObject(config.tools)) for (const k of Object.keys(config.tools)) if (isObject(config.tools[k])) config.tools[k].actAs = 'viewer';
        const out = await s.agentStore.updateAgent(part.entityId, e.name || a.name, e.description || '', e.systemPrompt || '',
            stage.runAsUserId, e.model || null, Array.isArray(e.starterPrompts) ? e.starterPrompts : [],
            e.avatar ?? a.avatar ?? null, e.threadsEnabled !== false, e.copyEnabled !== false, e.workspaceEnabled === true,
            config, a.embed_enabled === true, undefined, undefined, undefined,
            { managedWrite, ...(e.persona !== undefined ? { persona: e.persona } : {}) });
        if (out && out.ok === false) throw new HttpError(409, 'part_write_failed', `"${part.ref}" could not be written.`, { ref: part.ref });
        await step.done({ afterHash: part.hash, detail: { rev: out && out.rev != null ? out.rev : null } });
    },

    async knowledge_base(ctx, part) {
        const { s, journal, managedWrite } = ctx;
        const kb = await s.kbStore.getKB(part.entityId);
        if (!kb) throw new HttpError(409, 'part_missing', `"${part.ref}" is gone from the stage.`, { ref: part.ref });
        const e = part.entity;
        const step = await journal.pending('kb_shell', {
            ref: part.ref, kind: 'knowledge_base', entityId: part.entityId,
            before: { name: kb.name, description: kb.description || '', icon: kb.icon || null },
        });
        await s.kbStore.updateKB(part.entityId, {
            name: e.name || kb.name, description: e.description || '', icon: e.icon || null,
            ...(Array.isArray(e.usageContexts) ? { usageContexts: e.usageContexts } : {}),
        }, { managedWrite });
        await step.done({ afterHash: part.hash });
    },
};
WRITERS.block = WRITERS.automation;
WRITERS.layer = WRITERS.automation;

/** A page's grant ids (no labels), for the journal and a compensation that puts them back. */
function grantIds(g) {
    const grants = isObject(g) ? g : {};
    return {
        automations: (Array.isArray(grants.automations) ? grants.automations : []).map(x => x && x.automationId).filter(Boolean),
        tables: (Array.isArray(grants.tables) ? grants.tables : []).filter(isObject)
            .map(x => ({ datatableId: x.datatableId, mode: x.mode === 'readwrite' ? 'readwrite' : 'read', columns: Array.isArray(x.columns) ? x.columns : [] })),
        integrations: (Array.isArray(grants.integrations) ? grants.integrations : []).map(x => x && x.tool).filter(Boolean),
        agentId: isObject(grants.agent) ? grants.agent.agentId || null : null,
    };
}

/** The grants a stage page gets: the bound release's, never public columns or public AI. */
function stageGrants(raw) {
    const g = isObject(raw) ? raw : {};
    return {
        automations: (Array.isArray(g.automations) ? g.automations : []).filter(x => isObject(x) && typeof x.automationId === 'string' && x.automationId)
            .map(x => ({ automationId: x.automationId, ...(x.label ? { label: String(x.label) } : {}) })),
        tables: (Array.isArray(g.tables) ? g.tables : []).filter(x => isObject(x) && typeof x.datatableId === 'string' && x.datatableId)
            .map(x => ({ datatableId: x.datatableId, mode: x.mode === 'readwrite' ? 'readwrite' : 'read', columns: Array.isArray(x.columns) ? x.columns : [], publicColumns: [] })),
        integrations: (Array.isArray(g.integrations) ? g.integrations : []).filter(x => isObject(x) && typeof x.tool === 'string' && x.tool)
            .map(x => ({ tool: x.tool, ...(x.label ? { label: String(x.label) } : {}) })),
        agent: isObject(g.agent) && typeof g.agent.agentId === 'string' && g.agent.agentId ? { agentId: g.agent.agentId } : null,
    };
}

async function writeParts(ctx) {
    // The plan already turned an `unchanged` part whose bound address or mirror changed into a replace.
    const idOf = new Map([...ctx.idByRef, ...ctx.computedSkills]);
    for (const part of ctx.parts) {
        if (!WRITE_ACTIONS.includes(part.action)) continue;
        if (part.kind === 'skill') {
            ctx.skills.push({ ref: part.ref, id: part.entityId, fields: ctx.s.install.skillFieldsOf(part.releaseEntity, idOf) });
            continue;
        }
        const write = WRITERS[part.installKind] || WRITERS[part.kind];
        if (write) await write(ctx, part);
    }
}

// ── 4. Data (reference rows, knowledge, PRD preflight) ──────────────────────

async function collectPayloads(ctx) {
    const { s, release, stage, idByRef } = ctx;
    const payloads = await s.blueprintStore.getReleasePayloads(release.id);
    let previous = new Map();
    if (stage.currentReleaseId && stage.currentReleaseId !== release.id) {
        previous = new Map((await s.blueprintStore.getReleasePayloads(stage.currentReleaseId, { kind: 'knowledge_listing' }))
            .map(p => [p.ref, p.payload]));
    } else {
        for (const p of payloads) if (p.kind === 'knowledge_listing') previous.set(p.ref, p.payload);
    }
    let uatStamps = null;
    for (const p of payloads) {
        const targetId = idByRef.get(p.ref);
        if (!targetId) continue;
        if (p.kind === 'reference_rows') {
            ctx.referenceRows.push({ ref: p.ref, tableId: targetId, rows: Array.isArray(p.payload && p.payload.rows) ? p.payload.rows : [] });
        } else if (p.kind === 'knowledge_listing') {
            let sourceKbId = p.sourceEntityId;
            if (stage.stage === 'prd') {
                if (!uatStamps) {
                    const uat = await s.stageStore.getStageFor(stage.solutionId, 'uat');
                    uatStamps = uat ? await s.blueprintStore.listStamps(uat.projectId) : new Map();
                }
                const st = uatStamps.get(p.ref);
                sourceKbId = st && !st.retiredAt ? st.entityId : null;
            }
            if (!sourceKbId) {
                ctx.blocking.push(blocking('kb.source_missing', { ref: p.ref }));
                continue;
            }
            ctx.knowledge.push({ ref: p.ref, targetKbId: targetId, sourceKbId, releaseDocs: p.payload, previousDocs: previous.get(p.ref) || null });
        }
    }
}

/** PRD: run each changed table's DDL once in a transaction that always rolls back (design 3.2 step 5). */
async function preflight(ctx) {
    const { s, stage } = ctx;
    if (stage.stage !== 'prd') return;
    const changed = ctx.tables.filter(t => t.diff && t.diff.preflight === 'pending');
    if (!changed.length) return;
    const { buildStageTables, stageMigrationPlan } = dep(ctx.deps, 'commitModule', () => require('./commit'));
    const scope = s.datatableStore.orgScope(stage.organizationId);
    const key = s.datatableDbStore.scopeKey(scope);
    const ROLLBACK = Symbol('preflight');
    try {
        await s.withTransaction(async (client) => {
            await client.query(`SET LOCAL lock_timeout = '2s'`);
            const { model, modelVersion } = await s.datatableStore.getModel(scope);
            const built = await buildStageTables(client, clone(model), changed, { stage, deps: ctx.deps, checkFingerprints: false });
            const ddl = stageMigrationPlan(model, built.model, built);
            if (ddl.length) await s.datatableDbStore.applyMigration(key, key, ddl, { client, targetVersion: modelVersion + 1 });
            throw ROLLBACK;
        });
    } catch (err) {
        if (err === ROLLBACK) { for (const t of changed) t.diff.preflight = 'ok'; return; }
        try { s.datatableDbStore.invalidate(key); } catch { /* best effort */ }
        for (const t of changed) t.diff.preflight = 'failed';
        ctx.blocking.push(blocking('schema.preflight_failed', { code: err && err.code ? String(err.code) : null }));
    }
    try { s.datatableDbStore.invalidate(key); } catch { /* best effort */ }
}

// ── 5. Verify ───────────────────────────────────────────────────────────────

async function verify(ctx) {
    const { s, stage, deps, release, parts } = ctx;
    // Go-live of every automation that will be active, with its bound definition and owner = run-as.
    const check = dep(deps, 'checkBeforeLiveCore', () => require('../../automation/goLive').checkBeforeLiveCore);
    const aiActState = dep(deps, 'aiActState', () => require('../../automation/aiActCheck').defaultAiActState());
    for (const part of parts) {
        if (part.kind !== 'automation' || part.installKind !== 'automation' || !part.goesLive) continue;
        const automation = {
            id: part.entityId, kind: 'automation', title: part.entity.title || '', userId: stage.runAsUserId,
            organizationId: stage.organizationId || null, projectId: stage.projectId, definition: part.entity.definition,
        };
        try {
            const verdict = await check({ automation, definition: part.entity.definition, ownerId: stage.runAsUserId,
                organizationId: stage.organizationId || null, deps: { aiActState } });
            if (verdict && verdict.ok === false) ctx.blocking.push(blocking(verdict.code || 'go_live_refused', { ref: part.ref }));
        } catch (err) {
            ctx.blocking.push(blocking('go_live_unchecked', { ref: part.ref }));
            log.warn(`[stages/prepare] go-live check of ${part.ref} failed: ${err && err.message}`);
        }
    }
    const scan = dep(deps, 'scanStagePayloads', () => require('./crossStageScan').scanStagePayloads);
    ctx.blocking.push(...await scan({ solutionId: stage.solutionId, stageProjectId: stage.projectId,
        payloads: parts.map(p => ({ ref: p.ref, kind: p.kind, payload: p.entity })) }, deps));

    const readiness = dep(deps, 'readiness', () => require('./readiness').readiness);
    const [bindingRows, values, stamps] = await Promise.all([
        s.stageStore.listBindings(stage.projectId), s.stageStore.listVariableValues(stage.projectId),
        s.blueprintStore.listStamps(stage.projectId),
    ]);
    for (const f of await readiness({ stage, manifest: release.manifest, bindings: bindingRows, values, stamps }, deps)) {
        if (f && f.severity === 'error') ctx.blocking.push(blocking(f.code, { ref: f.ref || null }));
    }

    const completeness = dep(deps, 'stageCompleteness', () => defaultStageCompleteness);
    for (const f of await completeness(stage.projectId)) ctx.blocking.push(blocking(f.code || 'completeness.blocked', { ref: f.ref || null }));
}

/** The stage graph's blocking completeness findings (the release gate, asked of the TARGET stage). */
async function defaultStageCompleteness(stageProjectId) {
    const { buildGraphForProject } = require('../graphForProject');
    const { collectCompleteness } = require('../completeness');
    const built = await buildGraphForProject(stageProjectId);
    const out = await collectCompleteness({ graph: built.graph, ...built.members, unavailable: built.unavailable });
    if (!out || !out.blocked) return [];
    return (out.findings || []).filter(f => f && (f.severity === 'error' || f.severity === 'blocking'))
        .map(f => ({ code: f.code, ref: null }));
}

// ── prepare ─────────────────────────────────────────────────────────────────

/**
 * @param {{ deployment: object, stage: object, plan: object }} input  the deployment row, its stage row and
 *   the plan it runs (its `parts` give each ref's action and goesLive)
 * @param {object} [deps]  stores and engine modules (storesOf), `checkBeforeLiveCore`, `aiActState`,
 *   `scanStagePayloads`, `readiness`, `stageCompleteness(projectId)`, `readers` (stagePayload)
 * @returns {Promise<object>} what the commit needs
 * @throws {HttpError} 409 prepare_blocked {findings} when a verification blocks, or the error of a write
 */
async function prepare({ deployment, stage, plan }, deps = {}) {
    const s = storesOf(deps);
    const release = await s.blueprintStore.getRelease(stage.solutionId, deployment.releaseId);
    if (!release || release.channel !== 'pipeline' || !isObject(release.manifest)) {
        throw new HttpError(404, 'release_not_found', 'That release does not exist.');
    }
    const [stamps, bindingRows] = await Promise.all([
        s.blueprintStore.listStamps(stage.projectId), s.stageStore.listBindings(stage.projectId),
    ]);
    const { bindingMap } = require('./applyBindings');
    const { readStageShape } = require('./stagePayload');
    const entities = releaseEntities(release.manifest);
    const ctx = {
        s, deps, deployment, stage, plan, release, entities,
        managedWrite: { deploymentId: deployment.id },
        journal: makeJournal(s.stageStore, deployment.id, 'prepare'),
        idByRef: new Map([...stamps.values()].map(st => [st.ref, st.entityId])),
        bindings: bindingMap(bindingRows),
        slots: Array.isArray(release.manifest.solution && release.manifest.solution.slots) ? release.manifest.solution.slots : [],
        readShape: (kind, id) => readStageShape(kind, id, {}, deps),
        created: new Map(), computedSkills: new Map(), parts: [], tables: [], templates: [], skills: [],
        apps: new Map(), webpages: new Map(), referenceRows: [], knowledge: [], blocking: [],
    };
    await createMissing(ctx);
    await bindAll(ctx);
    await collectPayloads(ctx);
    if (ctx.blocking.length) throw blockedError(stage, ctx.blocking);
    await writeParts(ctx);
    await preflight(ctx);
    await verify(ctx);
    if (ctx.blocking.length) throw blockedError(stage, ctx.blocking);
    const retire = [...stamps.values()].filter(st => !st.retiredAt && !entities.has(st.ref));
    return {
        release: { id: release.id, seq: release.seq }, stage, managedWrite: ctx.managedWrite,
        idByRef: ctx.idByRef, parts: ctx.parts, retire, skills: ctx.skills, templates: ctx.templates,
        apps: ctx.apps, webpages: ctx.webpages, tables: ctx.tables, referenceRows: ctx.referenceRows,
        knowledge: ctx.knowledge,
    };
}

function blockedError(stage, findings) {
    const label = stage.stage === 'prd' ? 'Production' : 'UAT';
    return new HttpError(409, 'prepare_blocked', `Nothing changed in ${label}.`, { findings });
}

module.exports = {
    prepare, makeJournal, storesOf, stageTableKey, releaseEntities, stageGrants, grantIds,
    WRITE_ACTIONS, CREATE_ORDER,
};
