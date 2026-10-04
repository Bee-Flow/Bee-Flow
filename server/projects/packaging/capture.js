/**
 * Read a live Solution and write it down as a Blueprint.
 *
 * The I/O half of packaging. The decisions all live next door — manifest.js
 * owns the format and the `$ref` rewrite, scrub.js owns what must never leave —
 * so this module is the order those run in, plus the store reads that feed them.
 *
 * ── The order, and why each step is where it is ────────────────────────────
 *
 *   1. Load EVERY automation kind. A `call_block` pointing at a reusable Step
 *      that is in this project must resolve to a `$ref`, and the project
 *      listing filters blocks out.
 *   2. Assign bundle-local refs to everything first, so a rewrite can tell
 *      "inside the bundle" from "outside" without a second pass.
 *   3. Rewrite in-bundle pointers to `$ref`, THEN scrub. Reversed, the scrub
 *      would null the in-bundle pointer and there would be nothing left to
 *      rewrite. This ordering is what makes a Blueprint arrive wired.
 *   4. Build the graph LAST, from the same members, so `requires` reports the
 *      dependencies the graph found rather than a second opinion about them.
 *
 * ── What this version does not carry, and says so ──────────────────────────
 *
 * App table data is opt-in per table and defaults to none — the reasoning is
 * templateCapture's and unchanged: an `includeData: true` flag ships a
 * customer's purchase orders along with the vocabulary tables you meant.
 * A webpage's `data.db` is live user data and is excluded outright. Extra
 * webpage files are reported, not carried. Every one of these is named in the
 * report rather than left for someone to discover.
 *
 * ── Apps are NOT re-canonicalized ──────────────────────────────────────────
 *
 * The stored definition is already canonical — it was canonicalized when saved.
 * Running it through canonicalizeAppDefinition again REGENERATES component ids
 * (`b1` becomes `cmp_e91i1h`), which would break every binding that refers to a
 * component by id. Capture rewrites leaf values and removes fields; neither can
 * make a canonical document structurally invalid, so it is left alone.
 */

'use strict';

const { assignRefs, buildManifest } = require('./manifest');
const {
    scrubAppDefinition, RULES,
    captureDatatableShape, captureAgentShape, captureKnowledgeBaseShape, captureBridgeGrants,
    liftAutomationHoles, liftAppHoles, captureAppDataModel, captureWebpageKnowledgeBases,
    noteUnlisted, note, finding,
} = require('./scrub');
const { toRefs, variablesInSteeringFields, splitIds, isRef } = require('./pointers');
const { sweepRawIds, isTableToken } = require('./idSweep');
const { buildProjectGraph } = require('../graph');

function clone(v) {
    try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v ?? null)); }
}

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Load every member of the project, in the shapes the packagers need.
 *
 * Three of the six need a SECOND read after the listing, and each for the same
 * reason the apps line already gives: the listing carries what a page shows and
 * the packager needs what the entity IS.
 *
 *   - apps: the wiring is in the definition, not in the meta row.
 *   - agents: `config` holds the tool grants and the model, and the Content-tab
 *     listing deliberately does not carry it.
 *   - knowledge bases: the listing is a name and an icon; the shell that
 *     travels also needs the base's usage contexts.
 *
 * A table needs its SCHEMA, which does not live on the `datatables` row at all
 * — it lives in the scope model, addressed by the row's own scope.
 */
async function loadMembers(projectId) {
    const skillStore = require('../../stores/skillStore');
    const templateStore = require('../../stores/document/solutionTemplates');
    const documentStore = require('../../stores/documentStore');
    const automationStore = require('../../stores/automationStore');
    const studioAppStore = require('../../stores/studioAppStore');
    const webpageStore = require('../../stores/webpageStore');
    const datatableStore = require('../../stores/datatableStore');
    const agentStore = require('../../stores/agentStore');
    const kbStore = require('../../stores/knowledgeBases');
    const kbMembership = require('../knowledgeBaseMembership');

    const [automations, appMetas, webpages, datatables, agentMetas, kbShells, skillCards, templateCards] = await Promise.all([
        automationStore.getAutomationsForProject(projectId, { kinds: ['automation', 'block', 'layer'] }),
        studioAppStore.listProjectApps(projectId),
        webpageStore.listProjectWebpages(projectId),
        datatableStore.listDatatablesForProject(projectId),
        agentStore.listProjectAgents(projectId),
        kbMembership.listProjectKnowledgeBases(projectId),
        skillStore.listProjectSkills(projectId),
        templateStore.listSolutionTemplates(projectId),
    ]);
    const apps = (await Promise.all(
        (appMetas || []).map(m => studioAppStore.getStudioApp(m.id).catch(() => null)),
    )).filter(Boolean);
    const agents = (await Promise.all(
        (agentMetas || []).map(m => agentStore.getAgent(m.id).catch(() => null)),
    )).filter(Boolean);
    const knowledgeBases = (await Promise.all(
        (kbShells || []).map(k => kbStore.getKB(k.id).catch(() => null)),
    )).filter(Boolean);
    // The skill listing is a narrow projection, and a skill is read through its
    // own scope (organisation and owner), the way the agent-config check does.
    const skills = (await Promise.all((skillCards || []).map(async (card) => {
        try {
            const scope = await skillStore.getSkillScope(card.id);
            return scope ? await skillStore.getSkill(card.id, scope.org_id, scope.user_id) : null;
        } catch { return null; }
    }))).filter(Boolean);
    // A template card carries no slots; the body is read as its owner.
    const documents = (await Promise.all(
        (templateCards || []).map(c => documentStore.getDocument(c.id, c.userId).catch(() => null)),
    )).filter(Boolean);

    // An app's own data model (F13): the SHAPE from studio_app_data_meta,
    // never a row. Its model_version is the app's data_model_version, which
    // the release cut reads as a consistency token.
    // A read that FAILS is not "this app has no data model": it lands in
    // `unreadableDataModels`, so capture can say so (and a pipeline cut can
    // refuse) instead of shipping the app without its tables and a token of 0.
    const appDataModels = new Map();
    const unreadableDataModels = new Set();
    if (apps.length) {
        const studioAppDataStore = require('../../stores/studioAppDataStore');
        for (const app of apps) {
            try {
                appDataModels.set(app.id, await studioAppDataStore.getDataModel(app.id, app.userId));
            } catch {
                appDataModels.set(app.id, null);
                unreadableDataModels.add(app.id);
            }
        }
    }

    // The columns come from the scope model, one lookup per table, using the
    // scope the row itself carries — never a guessed one.
    const tableMetaById = new Map();
    for (const table of (datatables || [])) {
        const meta = await datatableStore.getTableMeta(table.scope, table.id).catch(() => null);
        tableMetaById.set(table.id, meta);
    }

    // ── The two kinds this packager does NOT carry ──────────────────
    //
    // The membership registry knows ten kinds; eight are read above (skills and
    // document templates among them). The two that are not are a different
    // pair than they look:
    //
    //   APPROVALS are left out ON PURPOSE, and manifest.js says why: an
    //   approval is a decision, not a thing somebody owns. A past decision
    //   belongs to the organisation that took it and cannot be installed
    //   somewhere else.
    //
    //   NOTEBOOKS were left out by OVERSIGHT — there is no note anywhere
    //   claiming a reason. Carrying them is a manifest change (a kind, an
    //   installer, a scrub pass) and that is O4's work, not a line here. What
    //   this line fixes is the silence: a project with notebooks was captured,
    //   installed elsewhere, and arrived without them, and nothing on either
    //   side ever said so. A Blueprint that quietly leaves part of a Solution
    //   behind is worse than one that refuses to.
    let notebookCount = 0;
    try {
        const notebookStore = require('../../stores/notebookStore');
        const counts = await notebookStore.countProjectNotebooks([projectId]);
        notebookCount = Number(counts?.get?.(projectId)) || 0;
    } catch (e) {
        // Could not count them — which is not "there are none". Say that too,
        // rather than let an unreadable count read as a clean capture.
        notebookCount = null;
    }

    return {
        automations: automations || [], apps, webpages: webpages || [],
        datatables: datatables || [], agents, knowledgeBases, skills, documents,
        tableMetaById, appDataModels, unreadableDataModels, notebookCount,
    };
}

/**
 * `opts` (every capture function takes the same one): `{ pipeline, connSlots,
 * slots, findings }`. Holes become slot descriptors in `opts.slots`; pipeline
 * mode also lifts them out of the payload (see scrub.js).
 */
/**
 * A fill_document step that names a template of THIS bundle (`{ $ref }`) loses
 * Dev's `documentVersionId`: that id is a revision of Dev's row, and install
 * pins the step to the revision of the copy it creates instead.
 */
function dropDevTemplatePins(definition) {
    require('../../automation/portability').walkAllSteps(definition, (step, _layerKey, isTrigger) => {
        if (!isTrigger && step.type === 'fill_document' && isRef(step.documentId)) delete step.documentVersionId;
    });
}

function captureAutomation(automation, refs, warnings, opts = {}) {
    const { buildExport } = require('../../automation/portability');
    const definition = clone(automation.definition);
    toRefs('automation', { definition }, refs);
    dropDevTemplatePins(definition);
    liftAutomationHoles(definition, { ...opts, ref: refs.get(automation.id) });

    // buildExport runs the shared scrub and reports what it cleared, so the
    // automation payload is produced by the same code path a single-automation export
    // uses — one exporter, not two.
    // buildExport returns { envelope, warnings }; only the automation payload is
    // taken. Its envelope stamps its own exportedAt from the clock, which is
    // discarded here — a Blueprint carries one timestamp, passed in, so the
    // whole capture stays comparable between runs.
    const { envelope, warnings: exportWarnings } = buildExport({ ...automation, definition });
    for (const w of exportWarnings || []) warnings.push(w);

    return { ref: refs.get(automation.id), kind: automation.kind || 'automation', ...envelope.automation };
}

function captureApp(app, refs, warnings, opts = {}, dataMeta = null) {
    const ref = refs.get(app.id);
    const definition = clone(app.definition);
    const holder = { definition, dataModel: isPlainObject(dataMeta?.model) ? clone(dataMeta.model) : null };
    toRefs('app', holder, refs);
    liftAppHoles(definition, { ...opts, ref });
    const report = scrubAppDefinition(definition);
    const dataModel = captureAppDataModel(holder.dataModel, report, { ...opts, ref });

    const nulled = report.filter(r => r.rule === RULES.APP_AUTOMATION_REFERENCE).length;
    if (nulled) warnings.push(`"${app.name}" points at ${nulled} automation(s) outside this project. Whoever installs it has to connect them.`);
    const seats = report.filter(r => r.rule === RULES.APP_APPROVER_IDENTITY).length;
    if (seats) warnings.push(`Cleared ${seats} approver seat(s) from "${app.name}" — approvers are people in one organisation.`);
    if (report.some(r => r.rule === RULES.APP_DATA_MODEL_REFERENCE)) {
        warnings.push(`"${app.name}"'s data model reads a table outside this project or maps groups to roles. Whoever installs it picks their own.`);
    }

    return {
        ref,
        name: app.name || '',
        description: app.description || '',
        icon: app.icon || null,
        accentColor: app.accentColor || null,
        definition,
        // The shape of the app's own tables; their rows never travel.
        ...(dataModel ? { dataModel } : {}),
        // Opt-in per table, and nothing is opted in here. See the header.
        seedTables: [],
    };
}

async function captureWebpage(webpage, refs, warnings, opts = {}) {
    const webpageStore = require('../../stores/webpageStore');
    const ref = refs.get(webpage.id);
    const live = clone(webpage.bridgeGrants) || {};
    const holder = { bridgeGrants: live, knowledgeBaseIds: Array.isArray(webpage.knowledgeBaseIds) ? clone(webpage.knowledgeBaseIds) : [] };
    toRefs('webpage', holder, refs);

    // A grant pointing outside the bundle is still a real id — say so before
    // the allow-list nulls it, so the installer is told to re-add it.
    for (const g of (Array.isArray(live.automations) ? live.automations : [])) {
        if (g && typeof g.automationId === 'string') {
            warnings.push(`"${webpage.name}" is allowed to call an automation outside this project. That grant will need re-adding after install.`);
        }
    }

    // Rebuilt from an allow-list rather than patched: the old version stripped
    // `fixedArgs` by hand while the line under it used `{ ...g, automationId:
    // null }`, which carries every other key a grant has — and cloned the whole
    // `ai` block, `publicEnabled` included. See scrub.captureBridgeGrants.
    const grantReport = [];
    const { payload: bridgeGrants } = captureBridgeGrants(live, grantReport, { ...opts, ref });
    const knowledgeBaseIds = captureWebpageKnowledgeBases(holder.knowledgeBaseIds, grantReport, { ...opts, ref });
    const outside = grantReport.filter(r => r.rule === RULES.WEBPAGE_RESOURCE_REFERENCE);
    if (outside.some(r => r.field !== 'bridgeGrants.agent')) {
        warnings.push(`"${webpage.name}" reads a table or knowledge base outside this project. That link does not travel — whoever installs it picks their own.`);
    }
    if (outside.some(r => r.field === 'bridgeGrants.agent')) {
        warnings.push(`"${webpage.name}" talks to an agent outside this project. That link does not travel — whoever installs it picks their own agent.`);
    }
    if (grantReport.some(r => r.rule === RULES.WEBPAGE_BRIDGE_ARGUMENTS)) {
        warnings.push(`Cleared the saved arguments from "${webpage.name}"'s integration grants — the installer re-authorises the tool.`);
    }
    if (grantReport.some(r => r.rule === RULES.WEBPAGE_PUBLIC_AI)) {
        warnings.push(`"${webpage.name}" keeps its own AI settings. Public AI for anonymous visitors is off on arrival, whoever installs it decides.`);
    }

    let files = { html: '', css: '', js: '' };
    try {
        files = await webpageStore.readAllSlots(webpage.userId, webpage.id);
    } catch (err) {
        warnings.push(`Could not read the files of "${webpage.name}": ${err.message}`);
    }

    let extraCount = 0;
    try { extraCount = (await webpageStore.listExtraFiles(webpage.id) || []).length; } catch { /* best effort */ }
    if (extraCount) warnings.push(`"${webpage.name}" has ${extraCount} additional file(s), which this version does not carry.`);
    // A stage would run the page without them, so a pipeline release refuses
    // rather than ship a page that differs from Dev (extra files are P8).
    if (extraCount && opts.pipeline && Array.isArray(opts.findings)) {
        opts.findings.push({ code: 'webpage.extra_files', severity: 'blocking', ref, count: extraCount });
    }
    if (webpage.dbSize) warnings.push(`"${webpage.name}" has a database. It holds live data and is never exported.`);

    return {
        ref,
        name: webpage.name || '',
        description: webpage.description || '',
        instructions: webpage.instructions || '',
        icon: webpage.icon || null,
        accentColor: webpage.accentColor || null,
        tagline: webpage.tagline || null,
        files: { html: files.html || '', css: files.css || '', js: files.js || '' },
        bridgeGrants,
        knowledgeBaseIds,
    };
}

/**
 * A table, as SHAPE. Never a row, never a grant — see scrub.js.
 *
 * `tableMeta` is the entry in the scope model that holds the columns; without
 * it the table still travels, as an empty shell, and the report says so rather
 * than pretending the table had no columns.
 */
function captureDatatable(table, tableMeta, refs, warnings, opts = {}) {
    const report = [];
    const { payload } = captureDatatableShape(table, tableMeta, report, { pipeline: !!opts.pipeline });
    if (!tableMeta) {
        warnings.push(`Could not read the columns of "${table.name || table.key}", so it travels as an empty table.`);
    }
    warnings.push(`"${payload.name || payload.key}" travels as a table shape: no rows and no access grants.`);
    return { ref: refs.get(table.id), ...payload };
}

/**
 * An agent, with its authority written down to the floor.
 *
 * Two things leave as REQUIREMENTS rather than as payload, and `required`
 * collects them: the apps it may reach (`config.enabledIntegrations`) and the
 * apps its per-action grants name. Both are only meaningful against credentials
 * that exist in ONE installation, so they arrive as something the installer
 * connects on purpose instead of something already switched on.
 */
function captureAgent(agent, refs, warnings, required, opts = {}) {
    const report = [];
    // Only a pipeline release keeps the agent's KB and skill links: the stages
    // share one organisation, so the links mean the same thing there.
    const source = opts.pipeline ? clone(agent) : agent;
    if (opts.pipeline) toRefs('agent', source, refs);
    const { payload } = captureAgentShape(source, report, { ...opts, ref: refs.get(agent.id) });

    const downgraded = report.filter(r => r.rule === RULES.AGENT_TOOL_AUTHORITY);
    if (downgraded.length) {
        warnings.push(`"${payload.name}" had ${downgraded.length} tool grant(s) acting as its owner. They travel acting as whoever uses the agent, never more.`);
    }
    for (const entry of report.filter(r => r.rule === RULES.AGENT_ENABLED_INTEGRATIONS)) {
        for (const app of entry.integrations || []) required.integrations.add(app);
    }
    for (const app of Object.keys(payload.config?.tools || {})) required.integrations.add(app);
    if (report.some(r => r.rule === RULES.AGENT_RESOURCE_REFERENCE)) {
        warnings.push(`"${payload.name}" is linked to knowledge bases or skills of this installation. Those links do not travel — whoever installs it picks their own.`);
    }

    return { ref: refs.get(agent.id), ...payload };
}

/** A knowledge base, as a shell. The documents stay where they are. */
function captureKnowledgeBase(kb, refs, warnings) {
    const report = [];
    const { payload } = captureKnowledgeBaseShape(kb, report);
    warnings.push(`"${payload.name}" travels as an empty knowledge base — its documents and its sources stay here.`);
    return { ref: refs.get(kb.id), ...payload };
}

// ── Skills and document templates (design section 2) ────────────────────────

const SKILL_ALLOWED = [
    'name', 'description', 'instructions', 'workflow', 'rules', 'examples', 'steps', 'rules_v2', 'examples_v2',
    'output_schema', 'icon', 'dynamic_activation',
];
/** Every key a skill row has, in both spellings, so none of them reads as "unlisted". */
const SKILL_KNOWN_KEYS = [
    'id', 'orgId', 'org_id', 'userId', 'user_id', 'isShared', 'is_shared', 'sharedGroups', 'shared_groups',
    'projectId', 'project_id', 'version', 'lastUsedAt', 'last_used_at', 'createdAt', 'created_at', 'updatedAt', 'updated_at',
    'enabledIntegrations', 'enabled_integrations', 'dynamicActivation', 'rulesV2', 'examplesV2', 'outputSchema',
    'knowledgeBaseIds', 'allowedAutomationIds', 'automationId',
];

/**
 * A skill, as an allow-list. Returns `{ payload, integrations }`; `report` gets
 * the rules that fired. The pointer fields travel as `$ref` when the target is
 * in the bundle; a base or automation outside it is dropped and reported, and in a
 * pipeline release also a blocking finding, because the stage would otherwise
 * run the skill without a link its Dev copy has. Connected apps
 * (`enabled_integrations`) never travel as a switch: they are returned as
 * `integrations` for `requires`.
 */
function captureSkillShape(skill, refs, report = [], opts = {}) {
    const src = isPlainObject(skill) ? skill : {};
    // The store hands back camelCase; a column row snake_case. Exactly one is written.
    const read = (camel, snake) => (src[camel] !== undefined ? src[camel] : src[snake]);
    const json = (v, dflt) => (v === undefined || v === null ? dflt : clone(v));
    const payload = {
        name: read('name', 'name') || '',
        description: read('description', 'description') || '',
        instructions: read('instructions', 'instructions') || '',
        workflow: read('workflow', 'workflow') || '',
        rules: read('rules', 'rules') || '',
        examples: read('examples', 'examples') || '',
        steps: json(read('steps', 'steps'), []),
        rules_v2: json(read('rulesV2', 'rules_v2'), []),
        examples_v2: json(read('examplesV2', 'examples_v2'), []),
        output_schema: json(read('outputSchema', 'output_schema'), null),
        icon: read('icon', 'icon') || null,
        dynamic_activation: read('dynamicActivation', 'dynamic_activation') === true,
    };

    const holder = {
        knowledge_base_ids: json(read('knowledgeBaseIds', 'knowledge_base_ids'), []),
        allowed_automation_ids: json(read('allowedAutomationIds', 'allowed_automation_ids'), []),
        automation_id: read('automationId', 'automation_id') || null,
    };
    toRefs('skill', holder, refs);
    const where = { ...opts, ref: opts.ref || null };
    for (const field of ['knowledge_base_ids', 'allowed_automation_ids']) {
        const { kept, outside } = splitIds(holder[field]);
        payload[field] = kept;
        if (!outside.length) continue;
        note(report, RULES.SKILL_RESOURCE_REFERENCE, { field, count: outside.length });
        if (opts.pipeline) finding(where, 'skill.resource_not_in_solution', { field, count: outside.length });
    }
    if (isRef(holder.automation_id)) {
        payload.automation_id = holder.automation_id;
    } else if (typeof holder.automation_id === 'string' && holder.automation_id) {
        payload.automation_id = null;
        note(report, RULES.SKILL_RESOURCE_REFERENCE, { field: 'automation_id', count: 1 });
        if (opts.pipeline) finding(where, 'skill.resource_not_in_solution', { field: 'automation_id', count: 1 });
    } else {
        payload.automation_id = null;
    }

    // A step's references name rows of this installation by raw id. The ones in the
    // bundle become a $ref; the rest are dropped and reported, like the pointer fields.
    let outsideStepRefs = 0;
    payload.steps = (Array.isArray(payload.steps) ? payload.steps : []).map((step) => {
        if (!isPlainObject(step) || !Array.isArray(step.refs)) return step;
        const kept = [];
        for (const r of step.refs) {
            const ref = isPlainObject(r) && typeof r.id === 'string' ? refs.get(r.id) : null;
            if (ref) kept.push({ ...r, id: { $ref: ref } });
            else outsideStepRefs += 1;
        }
        return { ...step, refs: kept };
    });
    if (outsideStepRefs) {
        note(report, RULES.SKILL_RESOURCE_REFERENCE, { field: 'steps.refs', count: outsideStepRefs });
        if (opts.pipeline) finding(where, 'skill.resource_not_in_solution', { field: 'steps.refs', count: outsideStepRefs });
    }

    for (const field of ['orgId', 'org_id', 'userId', 'user_id', 'projectId', 'project_id']) {
        if (src[field]) note(report, RULES.SKILL_TENANT_IDENTITY, { field });
    }
    if (read('isShared', 'is_shared') === true) note(report, RULES.SKILL_TENANT_IDENTITY, { field: 'isShared' });
    if ((read('sharedGroups', 'shared_groups') || []).length) note(report, RULES.SKILL_TENANT_IDENTITY, { field: 'sharedGroups' });
    const raw = read('enabledIntegrations', 'enabled_integrations');
    const integrations = (Array.isArray(raw) ? raw : []).filter(i => typeof i === 'string' && i);
    if (integrations.length) note(report, RULES.SKILL_TENANT_IDENTITY, { field: 'enabledIntegrations', integrations, count: integrations.length });

    noteUnlisted(report, 'skill', src, SKILL_ALLOWED, SKILL_KNOWN_KEYS);
    return { payload, integrations, report };
}

function captureSkill(skill, refs, warnings, required, opts = {}) {
    const ref = refs.get(skill.id);
    const report = [];
    const { payload, integrations } = captureSkillShape(skill, refs, report, { ...opts, ref });
    for (const app of integrations) required.integrations.add(app);
    if (report.some(r => r.rule === RULES.SKILL_RESOURCE_REFERENCE)) {
        warnings.push(`"${payload.name}" is linked to knowledge bases or automations outside this project. Those links do not travel: whoever installs it picks their own.`);
    }
    return { ref, ...payload };
}

const DOCUMENT_ALLOWED = ['name', 'docType', 'kind', 'description', 'bodyHtml', 'css', 'settings'];
const DOCUMENT_KNOWN_KEYS = [
    'id', 'doc_type', 'body_html', 'userId', 'user_id', 'organizationId', 'organization_id', 'visibility', 'folderId', 'folder_id',
    'categories', 'versionId', 'version_id', 'baselineVersionId', 'baseline_version_id', 'archived', 'projectId', 'project_id',
    'solutionProjectId', 'solution_project_id', 'updatedBy', 'updated_by', 'createdAt', 'created_at', 'updatedAt', 'updated_at',
];
/** Settings keys typed by the template's author, never part of the template itself. */
const DOCUMENT_SETTINGS_AUTHORED = ['sampleValues', 'sectionOverrides'];

/**
 * A document template, as an allow-list: `name, doc_type, kind, description,
 * body_html, css, settings`. `settings` loses `sampleValues` and
 * `sectionOverrides`; a gallery file also loses `resolvedHouseStyleCss`, the
 * source organisation's frozen house style (the installer's store writes its
 * own). A pipeline release keeps it: the stages share one organisation.
 */
function captureDocumentShape(doc, report = [], opts = {}) {
    const src = isPlainObject(doc) ? doc : {};
    const read = (camel, snake) => (src[camel] !== undefined ? src[camel] : src[snake]);
    const settings = isPlainObject(src.settings) ? clone(src.settings) : {};
    for (const key of DOCUMENT_SETTINGS_AUTHORED) {
        if (settings[key] === undefined) continue;
        delete settings[key];
        note(report, RULES.DOCUMENT_TENANT_IDENTITY, { field: `settings.${key}` });
    }
    if (!opts.pipeline && settings.resolvedHouseStyleCss !== undefined) {
        delete settings.resolvedHouseStyleCss;
        note(report, RULES.DOCUMENT_TENANT_IDENTITY, { field: 'settings.resolvedHouseStyleCss' });
    }
    const payload = {
        name: read('name', 'name') || '',
        doc_type: read('docType', 'doc_type') || 'document',
        kind: ['template', 'section', 'document'].includes(src.kind) ? src.kind : 'template',
        description: read('description', 'description') || '',
        body_html: read('bodyHtml', 'body_html') || '',
        css: read('css', 'css') || '',
        settings,
    };
    for (const field of ['userId', 'user_id', 'organizationId', 'organization_id', 'folderId', 'folder_id']) {
        if (src[field]) note(report, RULES.DOCUMENT_TENANT_IDENTITY, { field });
    }
    if ((src.categories || []).length) note(report, RULES.DOCUMENT_TENANT_IDENTITY, { field: 'categories' });
    if (src.visibility && src.visibility !== 'private') note(report, RULES.DOCUMENT_TENANT_IDENTITY, { field: 'visibility' });
    noteUnlisted(report, 'document', src, DOCUMENT_ALLOWED, DOCUMENT_KNOWN_KEYS);
    return { payload, report };
}

function captureDocumentTemplate(doc, refs, opts = {}) {
    const { payload } = captureDocumentShape(doc, [], opts);
    return { ref: refs.get(doc.id), ...payload };
}

/**
 * The graph's findings, with every real id taken out.
 *
 * ── Why the report needed this ─────────────────────────────────────────────
 *
 * The payload has always been careful: positional `$ref`s exist precisely so a
 * Blueprint "says nothing about the ids of the installation that produced it".
 * The REPORT beside it was not. `problems[].from` is a node id built from a real
 * entity id, `problems[].targetId` and the prose that quotes it are the id of
 * whatever the reference pointed at, and `externals[]` is a list of ids with the
 * ids of the entities that reference them.
 *
 * That was already the source installation's automation and app ids travelling in
 * every exported file. It became worse the moment an agent could depend on a
 * knowledge base or a skill, because those ids name internal resources of one
 * organisation rather than one person's automation.
 *
 * So the file carries the SHAPE of each finding — what kind of problem, how
 * bad, which bundled entity holds it — and never an id from this installation.
 * An external is a COUNT per kind, which is exactly what `requires` needs and
 * all the installer can act on anyway: they cannot look up an id they have no
 * access to.
 */
function reportForFile(graph, refs) {
    const problems = graph.problems.map((p) => {
        // The prose interpolates the target id, so it is removed from the
        // sentence by the same value that put it there — no pattern matching,
        // no chance of leaving half an id behind.
        const message = (typeof p.targetId === 'string' && p.targetId)
            ? p.message.split(p.targetId).join('something outside this Blueprint')
            : p.message;
        const holder = p.targetRef?.id;
        const out = {
            code: p.code,
            severity: p.severity,
            kind: p.kind,
            // WHICH bundled entity holds the broken reference, named the only
            // way a Blueprint may name anything: by its bundle-local ref.
            ref: (typeof holder === 'string' && refs.get(holder)) || null,
            message,
        };
        if (p.targetRef?.title) out.title = p.targetRef.title;
        if (p.targetRef?.stepId) out.stepId = p.targetRef.stepId;
        return out;
    });

    const byKind = new Map();
    for (const ext of graph.externals) byKind.set(ext.kind, (byKind.get(ext.kind) || 0) + 1);
    const externals = [...byKind].map(([kind, count]) => ({ kind, count }));

    return { problems, externals };
}

/**
 * The raw-id sweep over the captured entities (idSweep.js). A literal table id
 * in a page's files is marked `substitutable` when the table is in the bundle:
 * a stage deploy rewrites it by whole token, so it is listed, not refused.
 */
function sweepCapture(entities, members) {
    const tableIds = new Set(members.datatables.map(t => t.id));
    const memberIds = ['automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases', 'skills', 'documents']
        .flatMap(kind => (members[kind] || []).map(e => e?.id));
    return sweepRawIds(entities, memberIds).map(hit => (
        /^files\./.test(hit.path) && tableIds.has(hit.id) && isTableToken(hit.id) ? { ...hit, substitutable: true } : hit
    ));
}

/** The version tokens a consistent cut re-reads (design 6.1), by ref. */
function cutTokensOf(members, refs) {
    const tokens = {};
    const put = (entity, token) => { const ref = refs.get(entity.id); if (ref) tokens[ref] = token; };
    for (const a of members.automations) put(a, { version: a.version ?? null });
    for (const a of members.apps) {
        const meta = members.appDataModels?.get(a.id) || null;
        // No model row is version 0; a model that could not be read has no
        // token at all (null), never a 0 that would read as "no model".
        const dataModelVersion = members.unreadableDataModels?.has(a.id) ? null : (meta ? meta.modelVersion : 0);
        put(a, { definitionVersion: a.definitionVersion ?? null, dataModelVersion });
    }
    for (const a of members.agents) put(a, { rev: a.rev ?? null });
    for (const k of members.skills || []) put(k, { version: k.version ?? null });
    for (const d of members.documents || []) put(d, { versionId: d.versionId ?? null });
    return tokens;
}

/**
 * Capture the project as a Blueprint.
 *
 * `exportedAt` is a parameter rather than a clock read so the result is a pure
 * function of the database's state and can be compared between runs.
 *
 * `refs` (Map entityId → ref, from the ref ledger) keeps every part's ref
 * stable between captures; without it refs are positional, as before.
 * `pipeline: true` captures a release for the Solution's own stages (same
 * organisation): see scrub.js for what that carries, and `slots` for the holes
 * a stage binds. `connSlots` (Map Dev connection id → `cn_n`) keys connection
 * slots so one API used by three automations is bound once.
 *
 * Returns `{ ok, manifest, slots, rawIds, findings, steeringNames, cutTokens }`.
 * A gallery capture's manifest carries no slots, and its slots no Dev values.
 */
async function captureSolution({
    project, exportedAt = null, version = 1, refs: ledger = null, connSlots = null, pipeline = false,
} = {}) {
    if (!project?.id) return { ok: false, errors: ['That project could not be read.'] };

    const members = await loadMembers(project.id);
    const refs = assignRefs(members, { refs: ledger });
    const warnings = [];
    const required = { integrations: new Set() };
    const opts = { pipeline: !!pipeline, connSlots, slots: [], findings: [] };

    const automations = members.automations.map(a => captureAutomation(a, refs, warnings, opts));
    const apps = members.apps.map(a => captureApp(a, refs, warnings, opts, members.appDataModels?.get(a.id) || null));
    for (const a of members.apps) {
        if (!members.unreadableDataModels?.has(a.id)) continue;
        warnings.push(`Could not read the data model of "${a.name}". Its tables are not included, so whoever installs it starts without them.`);
        if (opts.pipeline) opts.findings.push({ code: 'app.data_model_unreadable', severity: 'blocking', ref: refs.get(a.id) || null });
    }
    const webpages = [];
    for (const w of members.webpages) webpages.push(await captureWebpage(w, refs, warnings, opts));
    const datatables = members.datatables.map(t => captureDatatable(t, members.tableMetaById?.get(t.id) || null, refs, warnings, opts));
    const agents = members.agents.map(a => captureAgent(a, refs, warnings, required, opts));
    const knowledgeBases = members.knowledgeBases.map(k => captureKnowledgeBase(k, refs, warnings));
    const skills = (members.skills || []).map(k => captureSkill(k, refs, warnings, required, opts));
    const documents = (members.documents || []).map(d => captureDocumentTemplate(d, refs, opts));

    const steering = new Set();
    for (const a of members.automations) for (const name of variablesInSteeringFields(a.definition)) steering.add(name);

    // Notebooks do not travel — see loadMembers. Said here rather than nowhere,
    // in the same channel every other "you will have to do this yourself"
    // already uses, so the person capturing learns it BEFORE they hand the file
    // to somebody else instead of after that person asks where the notes went.
    if (members.notebookCount === null) {
        warnings.push('Could not check whether this Solution has notebooks. Notebooks are not included in a Blueprint, so if there are any they will not travel.');
    } else if (members.notebookCount > 0) {
        warnings.push(`${members.notebookCount} notebook(s) in this Solution are NOT included — a Blueprint does not carry notebooks. Whoever installs it starts without them.`);
    }

    // The graph is the authority on what this Solution depends on. Asking it
    // rather than re-deriving means `requires` and the Flow tab cannot disagree
    // about which references leave the bundle.
    const graph = buildProjectGraph({ project, ...members });

    // Grouped by KIND. It used to count every external as an automation, which
    // was true while an automation was the only thing an edge could point at and
    // became a lie the moment an agent could depend on a skill: "needs 3
    // automation(s)" for three missing knowledge bases sends the installer to
    // the wrong screen. The `{ kind, count }` shape is unchanged.
    const requires = [];
    const externalsByKind = new Map();
    for (const ext of graph.externals) {
        externalsByKind.set(ext.kind, (externalsByKind.get(ext.kind) || 0) + 1);
    }
    for (const [kind, count] of externalsByKind) requires.push({ kind, count });

    const approvalPolicies = graph.nodes.filter(n => n.type === 'approval').length;
    if (approvalPolicies) requires.push({ kind: 'approver', count: approvalPolicies });
    // A connected app is a requirement, never a grant that arrives switched on.
    if (required.integrations.size) requires.push({ kind: 'integration', count: required.integrations.size });

    const manifest = buildManifest({
        project,
        entities: { automations, apps, webpages, datatables, agents, knowledgeBases, skills, documents },
        requires,
        report: {
            counts: {
                automations: automations.length, apps: apps.length, webpages: webpages.length,
                datatables: datatables.length, agents: agents.length, knowledgeBases: knowledgeBases.length,
                skills: skills.length, documents: documents.length,
            },
            // Redacted: the findings travel, the ids of this installation do
            // not. See reportForFile.
            ...reportForFile(graph, refs),
            warnings,
        },
        exportedAt,
        version,
        slots: opts.pipeline ? opts.slots : null,
    });
    const entities = { automations, apps, webpages, datatables, agents, knowledgeBases, skills, documents };

    return {
        ok: true,
        manifest,
        slots: opts.slots,
        rawIds: sweepCapture(entities, members),
        findings: opts.findings,
        steeringNames: [...steering].sort(),
        cutTokens: cutTokensOf(members, refs),
    };
}

module.exports = {
    captureSolution, loadMembers,
    captureApp, captureAutomation, captureWebpage,
    captureDatatable, captureAgent, captureKnowledgeBase, reportForFile, sweepCapture,
    captureSkill, captureSkillShape, captureDocumentTemplate, captureDocumentShape,
};
