'use strict';

/**
 * /api/playbooks — the entity, the transitions, the two server-run phases and
 * the gates, against fake deps (createPlaybooksRouter(deps)). Auth and the
 * rate limiter are stubbed at the module seam so the router's own gates are
 * what is tested.
 *
 * Run: node --test --test-force-exit routes/playbooks.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('module');

// ── module seams ─────────────────────────────────────────────────────────────
// The router is routes/playbooks/index.js, so these are the specifiers AS
// WRITTEN INSIDE IT (two levels down) and the parent guard names that file —
// both stop matching silently if either moves again.
const MOCKS = {
    '../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session && req.session.isAuthenticated ? next() : res.status(401).json({ error: 'Not authenticated' })),
        requirePermission: (perm) => (req, res, next) => {
            const perms = String(req.headers['x-test-perms'] || '').split(',').filter(Boolean);
            return perms.includes('all') || perms.includes(perm) ? next() : res.status(403).json({ error: `Permission ${perm} required` });
        },
        Permissions: { MANAGE_APPS: 'manage_apps', MANAGE_DATATABLES: 'manage_datatables' },
    },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const id = `mock:${request}`;
    MOCK_IDS[request] = id;
    require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]playbooks[\\/]index\.js$/.test(parent.filename || '') && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const { createPlaybooksRouter } = require('./playbooks');
const recipes = require('../playbooks/recipes');
const lifecycle = require('../playbooks/lifecycle');
const { tierAccessOf } = require('../core/entitlements/tierAccess');

// ── fake deps ────────────────────────────────────────────────────────────────
const state = {};
function resetState() {
    state.rows = new Map();
    state.approvals = true;
    // The tiers the owner may use -- every one, unless a test narrows it.
    state.permitted = new Set(['auto', 'fast', 'thinking', 'writer', 'pro']);
    state.tierAsks = [];
    state.hasManageDatatables = true;
    state.automations = { a1: { id: 'a1', userId: 'u1', title: 'Facturen inlezen', isDraft: false, definition: { trigger: { kind: 'manual' } } } };
    state.apps = {};
    state.runs = {};
    state.rowCount = 0;
    state.createdApps = 0;
    state.execute = async (a, opts) => { opts.onRunCreated({ id: 'run_1' }); state.rowCount = 32; state.runs.run_1 = { id: 'run_1', status: 'success' }; return state.runs.run_1; };
    state.createdTables = [];
    state.bumpVersionOnCreate = false;
    state.compose = async () => ({ ok: true, recipe: CUSTOM_DOC, warnings: [] });
    state.designInputs = [];
    state.frameworks = ['GDPR', 'ISO27001'];
    state.enrichInputs = [];
    state.enrichment = { personal: null, personalMethod: 'names', privacy: null, aiAct: [], org: null };
    state.risks = [];
    state.evidence = [];
    state.metaWrites = [];
    state.reviewInputs = [];
    state.aggregates = [];
    state.review = async (args) => {
        state.reviewInputs.push(args);
        return { ok: true, artifacts: { findings: [{ code: 'x', severity: 'high', framework: 'GDPR', title: 'Look at this', why: 'because', fix: 'do that' }], facts: args.facts, frameworks: args.facts.frameworks, modelFailed: null }, summary: '1 point to look at, 1 of them important.' };
    };
    state.design = async (input) => {
        state.designInputs.push(input);
        const design = { name: 'Facturen', tagline: 'Alle facturen in één oogopslag', look: { preset: 'cloud', accent: '#1e7f4f', mood: 'kalm, precies' }, screens: [{ name: 'Overzicht', purpose: 'Het totaal zien', sections: [{ title: 'Kerncijfers', layout: 'row', elements: [{ kind: 'stat', label: 'Aantal facturen', note: 'count' }, { kind: 'chart', label: 'Per maand', note: 'totaal over datum' }] }] }, { name: 'Factuur', purpose: 'Eén factuur', sections: [{ title: 'Details', layout: 'stack', elements: [{ kind: 'detail', label: 'Factuur', note: 'alle velden' }] }] }], principles: ['Eén accentkleur'] };
        return { ok: true, artifacts: { design, designName: design.name, screenCount: 2, elementCount: 3 }, summary: 'Ontwerp "Facturen": 2 schermen, 3 elementen, look cloud.' };
    };
}
const CUSTOM_DOC = {
    title: 'Leveranciers volgen', description: 'Reads supplier sheets into a table and builds a directory app.',
    table: { fields: [{ key: 'naam', name: 'Naam', type: 'text' }, { key: 'email', name: 'E-mail', type: 'text' }, { key: 'rating', name: 'Rating', type: 'number', required: false }] },
    inputs: [{ key: 'folderPath', label: 'Map met leverancierslijsten', kind: 'folder', default: '/Leveranciers' }],
    phases: [
        { key: 'table', kind: 'table', label: 'Tabel' },
        { key: 'inlezen', kind: 'routine', label: 'Inlezen', brief: 'Build a routine that I start by hand: manual trigger. 1. nextcloud_list_files on "{{input.folderPath}}". 2. datatable add_row into the EXISTING datatable "{{table.name}}" (id {{table.id}}, key {{table.key}}) with {{field.naam}}, {{field.email}}.' },
        { key: 'app', kind: 'app', label: 'Directory-app', brief: 'Build an app on "{{table.name}}": app_link_datatable {name:"{{table.name}}"}, a data_grid with {{field.naam}}, {{field.email}}. Finish with app_finalize.' },
        { key: 'rating_turn', kind: 'app_turn', label: 'Beoordelen', brief: 'Extend this app: a rating form writing {{field.rating}}. Finish with app_finalize.', requiresRole: 'rating' },
    ],
};
resetState();

let seq = 0;
const playbookStore = {
    createPlaybook: async ({ userId, organizationId, recipeId, recipe = null, title, options, phases, currentPhase }) => {
        const id = `pb_${String(++seq).padStart(12, '0')}`;
        const row = { id, userId, organizationId, recipeId, recipe, title, status: 'active', options, phases, currentPhase, version: 1, createdAt: 'T', updatedAt: 'T' };
        state.rows.set(id, row);
        return { ...row };
    },
    getPlaybook: async (id, userId) => { const r = state.rows.get(id); return r && r.userId === userId ? JSON.parse(JSON.stringify(r)) : null; },
    listPlaybooksForUser: async (userId) => [...state.rows.values()].filter((r) => r.userId === userId).map((r) => JSON.parse(JSON.stringify(r))),
    savePhases: async (id, userId, patch, { expectedVersion } = {}) => {
        const r = state.rows.get(id);
        if (!r || r.userId !== userId) return { ok: false, notFound: true };
        if (expectedVersion != null && r.version !== expectedVersion) return { ok: false, conflict: true, currentVersion: r.version, playbook: JSON.parse(JSON.stringify(r)) };
        if (Array.isArray(patch.phases)) r.phases = patch.phases;
        if (patch.currentPhase !== undefined) r.currentPhase = patch.currentPhase;
        if (patch.status !== undefined) r.status = patch.status;
        if (patch.title !== undefined) r.title = patch.title;
        r.version += 1;
        return { ok: true, version: r.version, playbook: JSON.parse(JSON.stringify(r)) };
    },
    deletePlaybook: async (id, userId) => { const r = state.rows.get(id); if (!r || r.userId !== userId) return false; state.rows.delete(id); return true; },
};

const deps = {
    playbookStore,
    datatableStore: {
        listDatatablesForScope: async () => [],
        createDatatable: async (args, { applyPhysical }) => {
            state.createdTables.push(args);
            // Simulates a write landing between the phase's `running` save and
            // its closing save — the closing CAS then loses.
            if (state.bumpVersionOnCreate) { for (const r of state.rows.values()) r.version += 1; }
            await applyPhysical({ query: async () => ({}) }, { before: { tables: [] }, next: { tables: [{ id: 'tbl_new1', key: args.key }] }, modelVersion: 1 });
            return { id: 'tbl_new1', key: args.key, name: args.name };
        },
        getDatatable: async (id) => (id === 'tbl_new1' || id === 'tbl_ex' ? { id, key: 'facturen', name: 'Facturen', rowCount: state.rowCount, managedKind: id === 'tbl_ex' ? 'nextcloud_table' : null, lawfulBasis: null, retentionDays: null, retentionField: 'created_at', subjectColumn: null, rowScope: 'all' } : null),
        updateDatatableMeta: async (id, scope, patch) => { state.metaWrites.push({ id, scope, patch }); return { id }; },
        listGrants: async () => [],
        getTableMeta: async () => ({ fields: recipes.getRecipe('invoice_tracker').INVOICE_SCHEMA.filter((f) => f.key !== 'status' && f.key !== 'bestand') }),
    },
    datatableDbStore: { scopeKey: (s) => `${s.kind}:${s.id}`, applyMigration: async () => {}, invalidate: () => {} },
    automationStore: { getAutomation: async (id) => state.automations[id] || null, getRun: async (id) => state.runs[id] || null },
    studioAppStore: {
        createStudioApp: async ({ userId, name }) => { state.createdApps += 1; const id = `app_${state.createdApps}`; state.apps[id] = { id, userId, name }; return state.apps[id]; },
        getStudioApp: async (id) => state.apps[id] || null,
    },
    userStore: { getUser: async (id) => ({ id, organizationId: 'orgA' }), getAllGroups: async () => [{ id: 'grp_fin', organizationId: 'orgA' }, { id: 'grp_other', organizationId: 'orgB' }] },
    db: { withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
    runner: { executeAutomation: (a, opts) => state.execute(a, opts) },
    entitlements: { hasCapability: async (cap) => (cap === 'approvals' ? state.approvals : true) },
    // The real question (core/entitlements/tierAccess) over a stubbed list.
    tierAccessFor: async (args) => { state.tierAsks.push(args); return tierAccessOf(state.permitted); },
    permissions: { hasPermission: async () => state.hasManageDatatables, Permissions: { MANAGE_DATATABLES: 'manage_datatables' } },
    datatableAccess: {
        resolveDatatablePrincipalForUser: async (userId) => ({ userId, orgId: 'orgA', groupIds: [], orgIds: new Set(['orgA']) }),
        defaultCreateScope: (p) => ({ kind: 'org', id: p.orgId }),
        datatableScopesFor: (p) => [{ kind: 'org', id: p.orgId }, { kind: 'user', id: p.userId }],
        gradeForPrincipal: () => 'editor',
        gradeAtLeast: (g, min) => (g === 'owner' || g === 'editor' || g === min),
    },
    normalizeFields: require('../core/dataEngine/dataModel/datatableFields').normalizeFields,
    migrationPlan: () => [],
    ddlForTable: () => 'CREATE',
    assertDatatableQuota: async () => {},
    recipes,
    recipeDoc: require('../playbooks/recipeDoc'),
    runDesignPhase: async (input) => state.design(input),
    datatableRuntime: {
        resolveForPrincipal: async () => ({}),
        readRows: async () => ({ rows: [{ datum: '2026-09-01', leverancier: 'Acme' }] }),
        aggregateRows: async (_r, opts) => {
            state.aggregates.push(opts);
            if ((opts.filters || []).length) return { rows: [{ rows: 3 }] };
            return { rows: [{ oldest: '2025-07-01', newest: '2026-09-01', rows: 32 }] };
        },
    },
    composeRecipe: async (args) => state.compose(args),
    // The compliance review: the real gatherer (pure), a fake reviewer.
    gatherFacts: require('../playbooks/phases/compliancePhase').gatherFacts,
    runCompliancePhase: async (args) => state.review(args),
    frameworkPolicy: { activeRegulations: async () => new Set(state.frameworks) },
    complianceFrameworks: { byRegulation: (code) => ({ id: code.toLowerCase(), name_key: `compliance.fw_${code.toLowerCase()}_name` }) },
    studioAppDataStore: { getDataModel: async () => ({ model: { roles: [], roleMapping: { default: 'app', byGroup: {} } } }), listMembers: async () => [] },
    enrichComplianceFacts: async (args) => { state.enrichInputs.push(args); return state.enrichment; },
    guiDefaults: { 'compliance.fw_gdpr_name': 'GDPR', 'compliance.fw_iso27001_name': 'ISO/IEC 27001' },
    riskStore: { createRisk: async (orgId, fields, actorId) => { state.risks.push({ orgId, fields, actorId }); return { id: `risk_${state.risks.length}` }; } },
    complianceStore: { addEvidence: async (row) => { state.evidence.push(row); return { id: 'ev_1' }; } },
    datatableAccessPlan: { resolveDatatablePrincipalForUser: async () => ({ userId: 'u1', orgId: 'org1' }) },
    rlsGateway: { validateRowFilter: () => ({ ok: true, errors: [] }) },
    now: () => Date.parse('2026-09-13T12:00:00.000Z'),
};

// ── HTTP harness ─────────────────────────────────────────────────────────────
let server; let baseUrl;
test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid) req.session = { isAuthenticated: true, user: { id: uid, organizationId: 'orgA' } };
        next();
    });
    app.use('/api/playbooks', createPlaybooksRouter(deps));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/playbooks`;
});
test.after(async () => { await new Promise((r) => server.close(r)); });
test.beforeEach(() => resetState());

async function api(method, path, { user = 'u1', perms = 'manage_apps', body } = {}) {
    const headers = {};
    if (user) headers['x-test-user'] = user;
    if (perms) headers['x-test-perms'] = perms;
    let payload;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 204 */ }
    return { status: res.status, body: json };
}
// The Dutch demo is what most of these tests read, so the helper asks for it
// explicitly — a request that names NO language builds in English now, and
// that case has a test of its own.
const create = (options = {}) => api('POST', '/', { body: { recipeId: 'invoice_tracker', title: 'Facturen', options: { tableMode: 'new', folderPath: '/Invoices-Test', locale: 'nl', ...options } } });
const phase = (pb, key) => lifecycle.phaseByKey(pb.phases, key);
const statuses = (pb) => pb.phases.map((p) => `${p.key}:${p.status}`).join(' ');

// ── tests ────────────────────────────────────────────────────────────────────

test('recipes offers nothing built-in — a playbook is described — while the modules still resolve for the ones on file', async () => {
    const r = await api('GET', '/recipes');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.recipes, [], 'the dialog has one door: Describe it');
    assert.equal(r.body.approvalsAllowed, true);
    // Playbooks created from a built-in are still on file: their recipeId has
    // to resolve, or their briefs and phase labels cannot be composed.
    assert.ok(recipes.getRecipe('invoice_tracker'), 'the module stays for the rows that reference it');
    const doc = recipes.getRecipe('invoice_tracker').toDocument('en');
    assert.deepEqual(doc.phases.map((p) => p.kind), ['table', 'routine', 'fill', 'design', 'app', 'routine']);
    assert.deepEqual(doc.inputs.map((i) => i.key), ['folderPath']);
    assert.equal(doc.table.fields.length, 8);
    const created = await create();
    assert.equal(created.status, 201, 'and one can still be created from it');
});

test('a request that names no language builds in ENGLISH, never Dutch by default', async () => {
    // Dutch used to be the fallback, so anything that dropped the locale on
    // the way — an older client, a script, a proxy that eats a body field —
    // produced a Dutch demo under an English screen and nothing said so.
    state.composeLocales = [];
    state.compose = async ({ locale }) => { state.composeLocales.push(locale); return { ok: true, recipe: CUSTOM_DOC, warnings: [] }; };
    await api('POST', '/recipes/compose', { body: { description: 'Read the invoices in /Invoices' } });
    assert.deepEqual(state.composeLocales, ['en']);
    await api('POST', '/recipes/compose', { body: { description: 'x', locale: 'nl-NL' } });
    assert.deepEqual(state.composeLocales, ['en', 'nl'], 'a locale that IS given still decides');

    const pb = (await api('POST', '/', { body: { recipeId: 'invoice_tracker', options: { tableMode: 'new', folderPath: '/Invoices' } } })).body.playbook;
    assert.equal(pb.options.locale, 'en');
    assert.deepEqual(pb.phases.map((p) => p.label), ['Table', 'Automation', 'First rows', 'Design', 'App', 'Approval flow', 'Access', 'Compliance check']);
    // The recipe listing follows the same rule.
    assert.equal((await api('GET', '/recipes')).status, 200);
});

test('create: validates the options, resolves the org, seeds the phases (table ready, approvals locked without the capability); writes need manage_apps', async () => {
    const r = await create();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pb = r.body.playbook;
    assert.match(pb.id, /^pb_/);
    assert.equal(pb.organizationId, 'orgA');
    assert.equal(statuses(pb), 'table:ready routine:pending fill:pending design:pending app:pending approvals:pending access:pending compliance:pending');
    assert.equal(pb.currentPhase, 'table');
    assert.deepEqual(pb.options, { tableMode: 'new', datatableId: null, tableTitle: 'Facturen', folderPath: '/Invoices-Test', inputs: { folderPath: '/Invoices-Test' }, tier: 'fast', locale: 'nl', approverGroupId: null, ask: null });
    assert.deepEqual(pb.phases.map((p) => [p.key, p.kind, p.label]), [['table', 'table', 'Tabel'], ['routine', 'routine', 'Automatisering'], ['fill', 'fill', 'Eerste rijen'], ['design', 'design', 'Ontwerp'], ['app', 'app', 'App'], ['approvals', 'routine', 'Goedkeuringsflow'], ['access', 'access', 'Toegang'], ['compliance', 'compliance', 'Compliance-check']]);
    state.approvals = false;
    assert.equal(phase((await create()).body.playbook, 'approvals').status, 'locked');
    assert.equal((await api('POST', '/', { body: { recipeId: 'nope', options: {} } })).body.code, 'recipe_unknown');
    assert.equal((await create({ folderPath: 'Invoices' })).body.code, 'bad_options');
    assert.equal((await create({ tableMode: 'existing' })).body.code, 'bad_options');
    assert.equal((await create({ approverGroupId: 'grp_other' })).body.code, 'bad_options');
    assert.equal((await create({ approverGroupId: 'grp_fin' })).body.playbook.options.approverGroupId, 'grp_fin');
    assert.equal((await api('POST', '/', { perms: '', body: { recipeId: 'invoice_tracker', options: { folderPath: '/x' } } })).status, 403);
    assert.equal((await api('GET', '/', { user: null })).status, 401);
    // The list carries progress and phase statuses for the cards.
    const list = await api('GET', '/');
    assert.ok(list.body.playbooks.length >= 2);
    assert.deepEqual(list.body.playbooks[0].progress, { done: 0, total: 8, locked: list.body.playbooks[0].phases[4].status === 'locked' ? 1 : 0 });
    // Another user sees none of them.
    assert.deepEqual((await api('GET', '/', { user: 'u2' })).body.playbooks, []);
    assert.equal((await api('GET', `/${pb.id}`, { user: 'u2' })).status, 404);
});

test('an English workspace gets an English demo: the recipes, the columns, the summaries and the builder briefs', async () => {
    // A recipe document in the language asked for (nothing is OFFERED today,
    // so this reads the module the stored playbooks still resolve to).
    const doc = recipes.getRecipe('invoice_tracker').toDocument('en');
    assert.equal(doc.title, 'Invoice tracker');
    assert.equal(doc.inputs[0].label, 'Nextcloud folder with the invoices');
    assert.deepEqual(doc.table.fields.map((f) => f.key), ['date', 'supplier', 'invoice_number', 'excl_vat', 'vat', 'total', 'status', 'file']);

    const r = await api('POST', '/', { body: { recipeId: 'invoice_tracker', options: { tableMode: 'new', folderPath: '/Invoices-Test', locale: 'en' } } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const pb = r.body.playbook;
    assert.equal(pb.title, 'Invoice tracker');
    assert.equal(pb.options.locale, 'en');
    assert.equal(pb.options.tableTitle, 'Invoices');
    assert.deepEqual(pb.phases.map((p) => p.label), ['Table', 'Automation', 'First rows', 'Design', 'App', 'Approval flow', 'Access', 'Compliance check']);

    const after = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    const table = phase(after, 'table');
    assert.deepEqual(table.artifacts.fields.map((f) => f.key), ['date', 'supplier', 'invoice_number', 'excl_vat', 'vat', 'total', 'status', 'file']);
    assert.equal(table.artifacts.mapping.totaal, 'total');
    assert.equal(table.summary, 'Table "Invoices" created with 8 columns.');
    assert.equal(state.createdTables.at(-1).key, 'invoices');
    assert.doesNotMatch(state.createdTables.at(-1).description, /Facturen/);
    // The brief the routine builder is handed speaks the table's real keys.
    const brief = phase(after, 'routine').brief;
    assert.match(brief, /date \(date\), supplier \(string\), invoice_number \(string\), excl_vat \(number\), vat \(number\), total \(number\)/);
    assert.match(brief, /\*\*"Invoices"\*\* \(id `tbl_new1`, key `invoices`\)/);
    assert.match(brief, /Title "Read invoices"/);
    // …and a Dutch workspace is untouched.
    const nl = (await create()).body.playbook;
    assert.equal(nl.options.locale, 'nl');
    assert.deepEqual(nl.phases.map((p) => p.label), ['Tabel', 'Automatisering', 'Eerste rijen', 'Ontwerp', 'App', 'Goedkeuringsflow', 'Toegang', 'Compliance-check']);
});

test('the table phase creates the datatable, lands awaiting with artifacts and the routine brief already composed; Continue makes routine ready', async () => {
    const pb = (await create()).body.playbook;
    const run = await api('POST', `/${pb.id}/phases/table/run`);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    const after = run.body.playbook;
    assert.equal(statuses(after), 'table:awaiting routine:pending fill:pending design:pending app:pending approvals:pending access:pending compliance:pending');
    const table = phase(after, 'table');
    assert.equal(table.artifacts.datatableId, 'tbl_new1');
    assert.equal(table.artifacts.datatableKey, 'facturen');
    assert.equal(table.artifacts.fields.length, 8);
    assert.match(table.summary, /aangemaakt met 8 kolommen/);
    assert.equal(state.createdTables[0].description.length > 0, true);
    // The handoff card can show the next brief right away.
    const routine = phase(after, 'routine');
    assert.match(routine.brief, /\*\*"Facturen"\*\* \(id `tbl_new1`, key `facturen`\)/);
    assert.match(routine.brief, /"\/Invoices-Test"/);
    // A second run is refused: the phase is not ready.
    assert.equal((await api('POST', `/${pb.id}/phases/table/run`)).body.code, 'phase_not_ready');
    // Continue (with an edited brief for the next phase, one CAS write).
    const cont = await api('PATCH', `/${pb.id}`, { body: { expectedVersion: after.version, phases: [{ key: 'table', status: 'done' }, { key: 'routine', brief: 'EDITED brief' }] } });
    assert.equal(cont.status, 200, JSON.stringify(cont.body));
    assert.equal(statuses(cont.body.playbook), 'table:done routine:ready fill:pending design:pending app:pending approvals:pending access:pending compliance:pending');
    assert.equal(phase(cont.body.playbook, 'routine').brief, 'EDITED brief');
    assert.equal(phase(cont.body.playbook, 'routine').briefEdited, true);
    assert.equal(cont.body.playbook.currentPhase, 'routine');
});

test('table phase refusals: no manage_datatables → 403 and failed; an existing table without required columns → 422 table_unusable', async () => {
    state.hasManageDatatables = false;
    const pb = (await create()).body.playbook;
    const r = await api('POST', `/${pb.id}/phases/table/run`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'manage_datatables_required');
    assert.equal(phase(r.body.playbook, 'table').status, 'failed');
    // retry → ready again, attempt bumped.
    const retry = await api('POST', `/${pb.id}/phases/table/retry`, { body: { expectedVersion: r.body.playbook.version } });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(phase(retry.body.playbook, 'table').status, 'ready');
    assert.equal(phase(retry.body.playbook, 'table').attempt, 1);
    state.hasManageDatatables = true;
    deps.datatableStore.getTableMeta = async () => ({ fields: [{ key: 'datum', name: 'Datum', type: 'date' }] });
    const ex = (await create({ tableMode: 'existing', datatableId: 'tbl_ex' })).body.playbook;
    const bad = await api('POST', `/${ex.id}/phases/table/run`);
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'table_unusable');
    assert.deepEqual(bad.body.missing, ['leverancier', 'factuurnummer', 'excl_btw', 'totaal']);
    deps.datatableStore.getTableMeta = async () => ({ fields: recipes.getRecipe('invoice_tracker').INVOICE_SCHEMA.filter((f) => f.key !== 'status' && f.key !== 'bestand') });
});

test('a save conflict on a server phase\'s closing write fails the phase — never a silent `running` for ever', async () => {
    // The table IS created, then the closing save loses the CAS race. Before
    // savePhaseOutcome the row stayed `running`: no Retry (running → ready is
    // illegal), no Skip (the table is unskippable), and the page polled it for
    // ever (2026-09-17).
    const pb = (await create()).body.playbook;
    state.bumpVersionOnCreate = true;
    const r = await api('POST', `/${pb.id}/phases/table/run`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'version_conflict');
    const stored = state.rows.get(pb.id);
    assert.equal(phase(stored, 'table').status, 'failed', 'the phase was failed so Retry works');
    assert.match(phase(stored, 'table').error, /changed elsewhere/);
    assert.equal(phase(r.body.playbook, 'table').status, 'failed', 'the 409 carries the healed row');
    assert.equal(state.createdTables.length, 1, 'one table, created once');
    // …and Retry really works from here — and REUSES the table the first
    // attempt created (its id survived on the failed phase), never a second one.
    state.bumpVersionOnCreate = false;
    const retry = await api('POST', `/${pb.id}/phases/table/retry`, { body: { expectedVersion: stored.version } });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(phase(retry.body.playbook, 'table').status, 'ready');
    const rerun = await api('POST', `/${pb.id}/phases/table/run`);
    assert.equal(rerun.status, 200, JSON.stringify(rerun.body));
    const landed = phase(rerun.body.playbook, 'table');
    assert.equal(landed.status, 'awaiting');
    assert.equal(landed.artifacts.datatableId, 'tbl_new1', 'the same table, not a new one');
    assert.equal(landed.artifacts.reused, true);
    assert.equal(state.createdTables.length, 1, 'still one table');
});

test('GET fails a server phase whose run outlived its own budget (a died mid-write process)', async () => {
    const pb = (await create()).body.playbook;
    const row = state.rows.get(pb.id);
    const t = phase(row, 'table');
    t.status = 'running';
    t.startedAt = '2026-09-13T11:40:00.000Z';   // 20 min before the fixed clock — past STALE_SERVER_RUN_MS
    const r = await api('GET', `/${pb.id}`);
    assert.equal(r.status, 200);
    assert.equal(phase(r.body.playbook, 'table').status, 'failed');
    assert.equal(phase(state.rows.get(pb.id), 'table').status, 'failed', 'the heal is persisted, not just rendered');
    // A phase running within its budget is left alone.
    const pb2 = (await create()).body.playbook;
    const row2 = state.rows.get(pb2.id);
    const t2 = phase(row2, 'table');
    t2.status = 'running';
    t2.startedAt = '2026-09-13T11:59:00.000Z';   // one minute old — the POST is legitimately in flight
    const r2 = await api('GET', `/${pb2.id}`);
    assert.equal(phase(r2.body.playbook, 'table').status, 'running');
});

test('the client\'s transitions: running → awaiting needs a finalised routine of the owner; the CAS version guards every write; illegal moves are 409', async () => {
    let pb = (await create()).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'table', status: 'done' }] } })).body.playbook;
    // Stale version.
    const stale = await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version - 1, phases: [{ key: 'routine', status: 'running' }] } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'version_conflict');
    assert.equal(stale.body.currentVersion, pb.version);
    assert.equal((await api('PATCH', `/${pb.id}`, { body: { phases: [] } })).body.code, 'version_required');
    // Start the routine (client-run).
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'running', artifacts: { builderSessionId: 'bs1' } }] } })).body.playbook;
    assert.equal(phase(pb, 'routine').status, 'running');
    assert.equal(phase(pb, 'routine').artifacts.builderSessionId, 'bs1');
    // awaiting without an automation → 409; with a draft → routine_not_finalized; another owner → 403.
    assert.equal((await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'awaiting' }] } })).body.code, 'artifacts_missing');
    state.automations.a1.isDraft = true;
    assert.equal((await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'awaiting', artifacts: { automationId: 'a1' } }] } })).body.code, 'routine_not_finalized');
    state.automations.a1.isDraft = false;
    state.automations.a1.userId = 'u2';
    assert.equal((await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'awaiting', artifacts: { automationId: 'a1' } }] } })).status, 403);
    state.automations.a1.userId = 'u1';
    // A trigger the FILL phase will refuse is refused HERE, while the builder is
    // still open — it used to land, the playbook advanced, and the next phase
    // died with a sentence about triggers on a routine already closed.
    const wasTrigger = state.automations.a1.definition.trigger.kind;
    state.automations.a1.definition.trigger.kind = 'file_event';
    const badTrigger = await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'awaiting', artifacts: { automationId: 'a1' } }] } });
    assert.equal(badTrigger.body.code, 'trigger_not_manual');
    assert.match(badTrigger.body.error, /file_event/);
    state.automations.a1.definition.trigger.kind = wasTrigger;
    const ok = await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'awaiting', artifacts: { automationId: 'a1' }, summary: 'Routine built' }] } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    pb = ok.body.playbook;
    assert.equal(phase(pb, 'routine').artifacts.automationTitle, 'Facturen inlezen');
    // Illegal: awaiting → running.
    const ill = await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'running' }] } });
    assert.equal(ill.status, 409);
    assert.deepEqual([ill.body.code, ill.body.from, ill.body.to], ['illegal_transition', 'awaiting', 'running']);
    // The server-run phases refuse client status writes.
    assert.equal((await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'fill', status: 'running' }] } })).body.code, 'illegal_transition');
    // Stop — resuming is refused while active.
    assert.equal((await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, status: 'active' } })).body.code, 'illegal_transition');
    const stopped = await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, status: 'stopped' } });
    assert.equal(stopped.body.playbook.status, 'stopped');
    // Resume: the playbook is active again; the awaiting routine stays as it was.
    const resumed = await api('PATCH', `/${pb.id}`, { body: { expectedVersion: stopped.body.playbook.version, status: 'active' } });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.playbook.status, 'active');
    assert.equal(phase(resumed.body.playbook, 'routine').status, 'awaiting');
});

test('resume after a stop mid-turn: the running phase lands as failed ("interrupted") so the card offers Retry', async () => {
    let pb = (await create()).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'table', status: 'done' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'running', artifacts: { automationId: 'a1' } }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, status: 'stopped' } })).body.playbook;
    assert.equal(phase(pb, 'routine').status, 'running', 'stop leaves the phase as it was — the builder turn finishes on its own');
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, status: 'active' } })).body.playbook;
    assert.equal(pb.status, 'active');
    assert.deepEqual([phase(pb, 'routine').status, phase(pb, 'routine').error, phase(pb, 'routine').artifacts.automationId], ['failed', 'interrupted', 'a1']);
    // Retry keeps the routine and asks the builder again (attempt 1).
    const retried = (await api('POST', `/${pb.id}/phases/routine/retry`, { body: { expectedVersion: pb.version } })).body.playbook;
    assert.deepEqual([phase(retried, 'routine').status, phase(retried, 'routine').attempt, phase(retried, 'routine').artifacts.automationId], ['ready', 1, 'a1']);
});

/** Straight to a landed compliance review — the closing phase. */
async function toComplianceAwaiting(options = {}) {
    let pb = (await create(options)).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    for (const [key, status, artifacts] of [['table', 'done'], ['routine', 'running'], ['routine', 'awaiting', { automationId: 'a1' }], ['routine', 'done']]) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key, status, ...(artifacts ? { artifacts } : {}) }] } })).body.playbook;
    }
    pb = (await api('POST', `/${pb.id}/phases/fill/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'fill', status: 'done' }] } })).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/design/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'design', status: 'done' }] } })).body.playbook;
    for (const status of ['running', 'awaiting', 'done']) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'app', status }] } })).body.playbook;
    }
    for (const status of ['running', 'awaiting', 'done']) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'approvals', status, ...(status === 'awaiting' ? { artifacts: { automationId: 'a1' } } : {}) }] } })).body.playbook;
    }
    for (const status of ['running', 'awaiting', 'done']) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'access', status }] } })).body.playbook;
    }
    return (await api('POST', `/${pb.id}/phases/compliance/run`)).body.playbook;
}

/** Up to a design phase that is ready to run. */
async function toDesignReady(options = {}) {
    let pb = (await create(options)).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    for (const [key, status, artifacts] of [['table', 'done'], ['routine', 'running'], ['routine', 'awaiting', { automationId: 'a1' }], ['routine', 'done']]) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key, status, ...(artifacts ? { artifacts } : {}) }] } })).body.playbook;
    }
    pb = (await api('POST', `/${pb.id}/phases/fill/run`)).body.playbook;
    return (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'fill', status: 'done' }] } })).body.playbook;
}

/** Straight to a design that has landed — the path the revision test needs. */
async function toDesignAwaiting(options = {}) {
    const pb = await toDesignReady(options);
    return (await api('POST', `/${pb.id}/phases/design/run`)).body.playbook;
}

// A playbook's own model calls -- the design, the review, both assistants --
// read the tier straight off the row. `auto` is no tier modelResolver knows,
// so it resolved to the FAST model whatever the owner's groups allowed, and a
// tier the owner had lost since the playbook was created stayed theirs.
test('a playbook on auto runs its design and its review on the cheapest tier the owner may use', async () => {
    state.permitted = new Set(['auto', 'thinking', 'pro']);
    await toComplianceAwaiting({ tier: 'auto' });
    assert.equal(state.designInputs.at(-1).tier, 'thinking', 'not auto, which the designer resolved to the fast model');
    assert.equal(state.reviewInputs.at(-1).tier, 'thinking');
    const asked = state.tierAsks.at(-1);
    assert.equal(asked.userId, 'u1', "the owner's own list");
    assert.equal(asked.taskType, 'automation');
});

test('a tier the owner has lost since the playbook was created stops its design before anything moves', async () => {
    const pb = await toDesignReady({ tier: 'pro' });
    state.permitted = new Set(['auto', 'fast']);
    const r = await api('POST', `/${pb.id}/phases/design/run`);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'tier_not_permitted');
    assert.equal(r.body.error, 'Tier "pro" is not available on your account.');
    assert.deepEqual(state.designInputs, [], 'no designer was asked');
    const after = (await api('GET', `/${pb.id}`)).body.playbook;
    assert.equal(phase(after, 'design').status, 'ready', 'never flipped to running, so there is nothing to fail or retry');
});

test('a lost tier stops the compliance review too, a recheck included', async () => {
    const pb = await toComplianceAwaiting({ tier: 'pro' });
    const runs = state.reviewInputs.length;
    state.permitted = new Set(['fast']);
    const r = await api('POST', `/${pb.id}/phases/compliance/run`, { body: { recheck: true } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'tier_not_permitted');
    assert.equal(state.reviewInputs.length, runs, 'the review did not run again');
});

test('a playbook stored before it carried a tier runs on the default, measured like any other', async () => {
    const pb = await toDesignReady();
    delete state.rows.get(pb.id).options.tier;
    state.permitted = new Set(['pro', 'thinking']);
    const r = await api('POST', `/${pb.id}/phases/design/run`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(state.designInputs.at(-1).tier, 'thinking', 'fast is not theirs, so not fast by default either');
});

test('the design phase is handed the person\'s own words and the brief the builder will get', async () => {
    // "Just one screen" used to reach nobody: the designer saw a one-line goal
    // written by the composer and drew a detail screen as well, which then
    // argued with the app brief (owner, 2026-09-16).
    let pb = (await api('POST', '/', { body: { recipeId: 'invoice_tracker', title: 'Facturen', options: { tableMode: 'new', folderPath: '/Invoices-Test', locale: 'en', ask: 'Read the invoices. Just one screen in the app.' } } })).body.playbook;
    assert.equal(pb.options.ask, 'Read the invoices. Just one screen in the app.');
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    for (const [key, status, artifacts] of [['table', 'done'], ['routine', 'running'], ['routine', 'awaiting', { automationId: 'a1' }], ['routine', 'done']]) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key, status, ...(artifacts ? { artifacts } : {}) }] } })).body.playbook;
    }
    pb = (await api('POST', `/${pb.id}/phases/fill/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'fill', status: 'done' }] } })).body.playbook;
    await api('POST', `/${pb.id}/phases/design/run`);
    const asked = state.designInputs.at(-1);
    assert.equal(asked.ask, 'Read the invoices. Just one screen in the app.');
    assert.match(asked.builderBrief, /app_link_datatable/, 'the concrete instruction the app builder will receive');
    assert.match(asked.builderBrief, /Screen "Overview"/);
});

test('a phase that steps aside hands the turn on: a locked approvals phase does not strand the access phase behind it', async () => {
    // Before there was anything after `approvals`, a skip or a lock could end
    // the chain unnoticed; with the access phase last it stranded the playbook
    // on a `pending` phase nobody could start (2026-09-16).
    state.approvals = false;
    let pb = (await create()).body.playbook;
    assert.equal(phase(pb, 'approvals').status, 'locked');
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    for (const [key, status, artifacts] of [['table', 'done'], ['routine', 'running'], ['routine', 'awaiting', { automationId: 'a1' }], ['routine', 'done']]) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key, status, ...(artifacts ? { artifacts } : {}) }] } })).body.playbook;
    }
    pb = (await api('POST', `/${pb.id}/phases/fill/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'fill', status: 'done' }] } })).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/design/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'design', status: 'done' }] } })).body.playbook;
    for (const status of ['running', 'awaiting', 'done']) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'app', status }] } })).body.playbook;
    }
    // Approvals stays locked; the access phase behind it is the one to do now.
    assert.equal(phase(pb, 'approvals').status, 'locked');
    assert.equal(phase(pb, 'access').status, 'ready');
    assert.equal(phase(pb, 'access').artifacts.appId, 'app_1');
    assert.equal(pb.currentPhase, 'access');
});

test('the compliance review reads REAL state, and Register writes it into the three registers', async () => {
    state.enrichment = {
        personal: [{ key: 'email', name: 'E-mail', kinds: ['email'], by: 'values' }],
        personalMethod: 'values',
        privacy: { lawfulBasis: null, retentionDays: null, retentionField: 'created_at', subjectColumn: null, rowScope: 'all' },
        aiAct: [{ title: 'Facturen inlezen', signals: { contains_ai: true, generates_content: false, customer_facing: false } }],
        org: { legalBases: ['contract'], defaultRetentionDays: 365, hasDpo: true },
    };
    let pb = await toComplianceAwaiting();
    // The reviewer was given the organisation's frameworks BY NAME (it used to
    // get bare codes — `fw.name` does not exist, only `fw.name_key`).
    const asked = state.reviewInputs.at(-1);
    assert.deepEqual(asked.frameworkNames, ['GDPR', 'ISO27001 (ISO/IEC 27001)'],
        'the human name when it says more than the code, the code alone when it does not');
    // …and the facts it reasoned from are the enriched ones.
    assert.equal(asked.facts.personalMethod, 'values');
    assert.deepEqual(asked.facts.table.personal.map((p) => p.key), ['email']);
    assert.equal(asked.facts.table.lawfulBasis, null);
    const enrichCall = state.enrichInputs.at(-1);
    assert.equal(enrichCall.orgId, 'orgA', "the playbook's own organisation, never a default");
    assert.equal(enrichCall.automations[0].definition.trigger.kind, 'manual', 'the AI Act detector reads the graph');

    // REGISTER — the one write of this phase.
    const r = await api('POST', `/${pb.id}/phases/compliance/register`, {
        body: {
            registration: { lawfulBasis: 'contract', retentionDays: 365, retentionField: 'datum', subjectColumn: 'leverancier' },
            risks: ['x', 'ghost'],
        },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.failed, []);
    assert.deepEqual(r.body.written, ['processing_register', 'risks:1', 'evidence']);

    // 1. the table now carries what the register reads.
    assert.deepEqual(state.metaWrites.at(-1).patch, { lawfulBasis: 'contract', retentionDays: 365, retentionField: 'datum', subjectColumn: 'leverancier' });
    // 2. one risk, from the finding that was kept — the invented code is ignored.
    assert.equal(state.risks.length, 1);
    assert.equal(state.risks[0].fields.source, 'playbook');
    assert.equal(state.risks[0].fields.seed_key, `playbook:${pb.id}:x`);
    assert.match(state.risks[0].fields.title, /Look at this/);
    // 3. the review itself, on the evidence chain.
    const ev = state.evidence.at(-1);
    assert.equal(ev.check_id, 'PLAYBOOK-review');
    assert.equal(ev.subject_type, 'playbook');
    assert.equal(ev.subject_id, pb.id);
    assert.deepEqual(ev.payload.frameworks, ['GDPR', 'ISO27001']);
    assert.equal(ev.payload.risks_opened, 1);
    assert.equal(ev.payload.registered.lawfulBasis, 'contract');
    // No finding TEXT beyond what a register needs — codes and headings only.
    assert.equal('why' in ev.payload.findings[0], false);

    pb = r.body.playbook;
    assert.deepEqual(phase(pb, 'compliance').artifacts.registered.written, ['processing_register', 'risks:1', 'evidence']);
});

test('a landed review can be run again in place, and says what changed', async () => {
    // awaiting → running is illegal and the lifecycle table is pinned, so a
    // recheck writes the new artifacts onto the phase where it stands.
    const pb = await toComplianceAwaiting();
    const before = phase(pb, 'compliance');
    assert.equal(before.status, 'awaiting');
    const runs = state.reviewInputs.length;

    const r = await api('POST', `/${pb.id}/phases/compliance/run`, { body: { recheck: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = phase(r.body.playbook, 'compliance');
    assert.equal(after.status, 'awaiting', 'the phase never moved');
    assert.equal(state.reviewInputs.length, runs + 1, 'and the review really ran again');
    assert.equal(after.artifacts.rechecks.length, 1);
    assert.equal(after.artifacts.rechecks[0].was, before.artifacts.findings.length);
    assert.ok(Number.isFinite(after.artifacts.rechecks[0].now));

    // Without the flag it is still refused, so nothing re-runs by accident.
    const plain = await api('POST', `/${pb.id}/phases/compliance/run`, { body: {} });
    assert.equal(plain.status, 409);
    assert.equal(plain.body.code, 'phase_not_ready');
});

test('a retention period is checked against the rows that are really there', async () => {
    // "Keep for 365 days" is a number until someone asks the table what it
    // means. The oldest row may already be outside the window — or the column
    // may hold no dates at all, in which case the period never fires.
    const pb = await toComplianceAwaiting();
    const r = await api('POST', `/${pb.id}/phases/compliance/retention-preview`, {
        body: { retentionField: 'datum', retentionDays: 365 },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usable, true);
    assert.equal(r.body.oldest, '2025-07-01');
    assert.equal(r.body.rowCount, 32);
    assert.equal(r.body.outsideWindow, 3, 'three rows the clean-up would take on its first pass');
    assert.ok(r.body.oldestDays > 365);
    // The counting query asked for exactly what it claims to have counted.
    const counted = state.aggregates.at(-1);
    assert.deepEqual(counted.filters, [{ field: 'datum', op: 'lt', value: counted.filters[0].value }]);
    assert.match(counted.filters[0].value, /^\d{4}-\d{2}-\d{2}T/);

    // A column that is not in the table, and a period nobody could mean.
    assert.equal((await api('POST', `/${pb.id}/phases/compliance/retention-preview`, { body: { retentionField: 'ghost', retentionDays: 365 } })).body.code, 'bad_retention_field');
    assert.equal((await api('POST', `/${pb.id}/phases/compliance/retention-preview`, { body: { retentionField: 'datum', retentionDays: 0 } })).body.code, 'bad_retention_days');
    assert.equal((await api('POST', `/${pb.id}/phases/compliance/retention-preview`, { body: { retentionField: 'datum', retentionDays: 99999 } })).body.code, 'bad_retention_days');

    // A column holding no readable date is the case that matters most: the
    // period would be recorded and the clean-up would never act on it.
    deps.datatableRuntime.aggregateRows = async () => ({ rows: [{ oldest: 'Acme BV', newest: 'Zeta', rows: 4 }] });
    const unusable = await api('POST', `/${pb.id}/phases/compliance/retention-preview`, { body: { retentionField: 'leverancier', retentionDays: 365 } });
    assert.equal(unusable.body.usable, false);
    assert.equal(unusable.body.oldest, null);
});

test('the registration is held to the same rules as the datatable itself', async () => {
    // It wrote straight to updateDatatableMeta, so none of these applied: a
    // basis the Compliance Center does not recognise went in, a retention of
    // a hundred years went in, and — the one that actually mattered — days
    // with no field to count them from, which the clean-up can never act on.
    const pb = await toComplianceAwaiting();
    const reg = (registration) => api('POST', `/${pb.id}/phases/compliance/register`, { body: { registration, risks: [] } });

    const before = state.metaWrites.length;
    const bad = await reg({ lawfulBasis: 'because we felt like it' });
    assert.deepEqual(bad.body.written, ['evidence']);
    assert.match(bad.body.failed[0].error, /not one of the six legal bases/);

    assert.match((await reg({ lawfulBasis: 'contract', retentionDays: 36500, retentionField: 'datum' })).body.failed[0].error, /between 1 and 3650 days/);
    assert.match((await reg({ lawfulBasis: 'contract', retentionDays: 365 })).body.failed[0].error, /needs a date column to count from/);
    assert.match((await reg({ retentionDays: 365, retentionField: 'ghost_column' })).body.failed[0].error, /no column "ghost_column" to count the retention from/);
    assert.match((await reg({ subjectColumn: 'ghost_column' })).body.failed[0].error, /no column "ghost_column" to name the person/);
    assert.equal(state.metaWrites.length, before, 'not one of them reached the table');

    // And the shape that IS right still lands.
    const ok = await reg({ lawfulBasis: 'legitimate_interests', retentionDays: 2555, retentionField: 'datum', subjectColumn: 'leverancier' });
    assert.deepEqual(ok.body.failed, []);
    assert.deepEqual(state.metaWrites.at(-1).patch, { lawfulBasis: 'legitimate_interests', retentionDays: 2555, retentionField: 'datum', subjectColumn: 'leverancier' });
});

test('a register write that fails does not take the others with it', async () => {
    const pb = await toComplianceAwaiting();
    deps.riskStore.createRisk = async () => { throw new Error('risk table gone'); };
    const r = await api('POST', `/${pb.id}/phases/compliance/register`, {
        body: { registration: { lawfulBasis: 'contract' }, risks: ['x'] },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.written, ['processing_register', 'evidence']);
    assert.deepEqual(r.body.failed.map((f) => f.what), ['risk:x']);
    assert.equal(state.evidence.length, 1, 'the evidence still landed');
});

test('a design that landed is redrawn on request: the designer sees the design that stands, the phase never leaves awaiting, and the app brief follows the NEW design', async () => {
    let pb = await toDesignAwaiting();
    assert.equal(phase(pb, 'design').artifacts.design.screens.length, 2);
    state.design = async (input) => {
        state.designInputs.push(input);
        const design = { name: 'Facturen', tagline: 'Per leverancier', look: { preset: 'cloud', accent: '#1e7f4f', mood: 'kalm' }, screens: [{ name: 'Leveranciers', purpose: 'Per leverancier', sections: [{ title: 'Lijst', layout: 'stack', elements: [{ kind: 'list', label: 'Leveranciers', note: 'leverancier' }] }] }], principles: [] };
        return { ok: true, artifacts: { design, designName: design.name, screenCount: 1, elementCount: 1 }, summary: 'Ontwerp "Facturen": 1 scherm, 1 element, look cloud.' };
    };
    const revised = await api('POST', `/${pb.id}/phases/design/run`, { body: { feedback: 'Geef elke leverancier een eigen scherm' } });
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    pb = revised.body.playbook;
    const d = phase(pb, 'design');
    assert.equal(d.status, 'awaiting', 'a revision is the same phase doing the same work — no transition');
    assert.deepEqual(d.artifacts.revisions, ['Geef elke leverancier een eigen scherm']);
    assert.deepEqual(d.artifacts.design.screens.map((x) => x.name), ['Leveranciers']);
    assert.equal(d.artifacts.screenCount, 1);
    const asked = state.designInputs.at(-1);
    assert.equal(asked.feedback, 'Geef elke leverancier een eigen scherm');
    assert.deepEqual(asked.previousDesign.screens.map((x) => x.name), ['Overzicht', 'Factuur'], 'the designer revises what stands, it does not start over');
    // The builder of the NEXT phase reads the design on screen, not the first one.
    const designBlock = phase(pb, 'app').brief.split('DESIGN')[1] || '';
    assert.match(designBlock, /Screen "Leveranciers"/);
    assert.doesNotMatch(designBlock, /Screen "Overzicht"/, 'the builder reads the design on screen, not the one it replaced');
    // A second one stacks; a run WITHOUT feedback on a landed phase is not a revision.
    pb = (await api('POST', `/${pb.id}/phases/design/run`, { body: { feedback: 'Zet de totalen bovenaan' } })).body.playbook;
    assert.deepEqual(phase(pb, 'design').artifacts.revisions, ['Geef elke leverancier een eigen scherm', 'Zet de totalen bovenaan']);
    assert.equal((await api('POST', `/${pb.id}/phases/design/run`)).body.code, 'phase_not_ready');
});

test('a revision that the designer cannot answer leaves the design that stands', async () => {
    let pb = await toDesignAwaiting();
    const before = phase(pb, 'design').artifacts.design;
    state.design = async () => ({ ok: false, code: 'design_empty', error: 'The designer returned nothing.' });
    const failed = await api('POST', `/${pb.id}/phases/design/run`, { body: { feedback: 'Maak het donker' } });
    assert.equal(failed.status, 422);
    assert.equal(failed.body.code, 'design_empty');
    pb = (await api('GET', `/${pb.id}`)).body.playbook;
    assert.equal(phase(pb, 'design').status, 'awaiting');
    assert.deepEqual(phase(pb, 'design').artifacts.design, before);
});

// runDesignPhase answers an unreachable model with a fixed sentence and the
// id its log line carries (playbooks/modelFailure.js). The id is the only
// thing that ties the person's screen to the operator's log, so the refusal
// has to carry it -- on a first run and on a revision alike.
test('a designer that cannot be reached is a 422 with the fixed sentence and the correlation id the log carries', async () => {
    const pb = await toDesignReady();
    state.design = async () => ({ ok: false, code: 'design_failed', error: 'The model could not be reached. Try again in a moment.', correlationId: 'req-4711' });
    const first = await api('POST', `/${pb.id}/phases/design/run`);
    assert.equal(first.status, 422, JSON.stringify(first.body));
    assert.equal(first.body.code, 'design_failed');
    assert.equal(first.body.error, 'The model could not be reached. Try again in a moment.');
    assert.equal(first.body.correlationId, 'req-4711');
    assert.equal(phase(first.body.playbook, 'design').error, 'The model could not be reached. Try again in a moment.', 'the stored error is the sentence too');

    state.design = async (input) => { state.designInputs.push(input); return { ok: true, artifacts: { design: { name: 'x', screens: [] } }, summary: 's' }; };
    const landed = await toDesignAwaiting();
    state.design = async () => ({ ok: false, code: 'design_failed', error: 'The model could not be reached. Try again in a moment.', correlationId: 'req-4712' });
    const revision = await api('POST', `/${landed.id}/phases/design/run`, { body: { feedback: 'Maak het donker' } });
    assert.equal(revision.status, 422);
    assert.equal(revision.body.correlationId, 'req-4712');
});

test('the fill phase runs the routine once, records the run and the rows, and lands awaiting; then Continue pre-creates the app and composes its brief', async () => {
    let pb = (await create()).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'table', status: 'done' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'running' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'awaiting', artifacts: { automationId: 'a1' } }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'done' }] } })).body.playbook;
    assert.equal(statuses(pb), 'table:done routine:done fill:ready design:pending app:pending approvals:pending access:pending compliance:pending');
    const fill = await api('POST', `/${pb.id}/phases/fill/run`);
    assert.equal(fill.status, 200, JSON.stringify(fill.body));
    pb = fill.body.playbook;
    const f = phase(pb, 'fill');
    assert.equal(f.status, 'awaiting');
    assert.equal(f.artifacts.runId, 'run_1');
    assert.equal(f.artifacts.rowsBefore, 0);
    assert.equal(f.artifacts.rowCount, 32);
    assert.match(f.summary, /32 rijen toegevoegd/);
    // Continue → app pre-created, brief composed, appId shared with approvals.
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'fill', status: 'done' }] } })).body.playbook;
    assert.equal(statuses(pb), 'table:done routine:done fill:done design:ready app:pending approvals:pending access:pending compliance:pending');
    // The DESIGN phase: the server asks the designer with the goal, the table's columns, sample rows and the approvals flag.
    assert.equal((await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'design', status: 'running' }] } })).body.code, 'illegal_transition');
    const designed = await api('POST', `/${pb.id}/phases/design/run`);
    assert.equal(designed.status, 200, JSON.stringify(designed.body));
    pb = designed.body.playbook;
    assert.equal(phase(pb, 'design').status, 'awaiting');
    assert.equal(phase(pb, 'design').artifacts.design.screens.length, 2);
    assert.match(phase(pb, 'design').summary, /Ontwerp "Facturen"/);
    const dIn = state.designInputs.at(-1);
    assert.match(dIn.goal, /factuur-app/);
    assert.deepEqual(dIn.table.fields.map((f) => f.key).slice(0, 2), ['datum', 'leverancier']);
    assert.equal(dIn.table.rowCount, 32);
    assert.equal(dIn.sampleRows.length, 1);
    assert.equal(dIn.approvals, true);
    // Continue → app pre-created, brief composed WITH the design block, appId shared with approvals.
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'design', status: 'done' }] } })).body.playbook;
    assert.equal(statuses(pb), 'table:done routine:done fill:done design:done app:ready approvals:pending access:pending compliance:pending');
    assert.equal(state.createdApps, 1);
    assert.equal(phase(pb, 'app').artifacts.appId, 'app_1');
    assert.equal(phase(pb, 'approvals').artifacts.appId, undefined, 'the approval flow is a routine — no app id');
    assert.match(phase(pb, 'app').brief, /app_link_datatable \{datatableId:"tbl_new1"\}/);
    assert.match(phase(pb, 'app').brief, /## DESIGN\nFollow this; where it differs from the screens above, THIS wins\. Call `app_set_theme \{preset:"cloud", primary:"#1e7f4f"\}`/);
    // "stat", not "stat tile": every word in the design block has to be a
    // component type the builder accepts verbatim, because the block tells it
    // the design outranks the brief.
    assert.match(phase(pb, 'app').brief, /### Screen "Overzicht" — Het totaal zien\n- \*\*Kerncijfers\*\*: stat "Aantal facturen" \(count\), chart "Per maand"/);
    assert.match(phase(pb, 'app').brief, /record_detail "Factuur"/);
    // App turn: running → awaiting (owner check) → done → approvals ready with its brief naming the owner.
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'app', status: 'running' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'app', status: 'awaiting' }] } })).body.playbook;
    assert.equal(phase(pb, 'app').status, 'awaiting');
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'app', status: 'done' }] } })).body.playbook;
    assert.equal(phase(pb, 'approvals').status, 'ready');
    assert.match(phase(pb, 'approvals').brief, /builder_add_approval` with assignee \{userId:"u1"\}/);
    assert.equal(pb.status, 'active');
    // Last consent completes the playbook.
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'approvals', status: 'running' }] } })).body.playbook;
    // A routine phase: awaiting needs the finalised routine, like the first one.
    assert.equal((await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'approvals', status: 'awaiting' }] } })).body.code, 'artifacts_missing');
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'approvals', status: 'awaiting', artifacts: { automationId: 'a1' } }] } })).body.playbook;
    assert.equal(phase(pb, 'approvals').artifacts.automationTitle, 'Facturen inlezen');
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'approvals', status: 'done' }] } })).body.playbook;
    // ACCESS closes the playbook: who may use the app, and with which role.
    // It inherits the app it governs, so it never has to be told.
    assert.equal(pb.status, 'active');
    assert.equal(phase(pb, 'access').status, 'ready');
    assert.equal(phase(pb, 'access').artifacts.appId, 'app_1');
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'access', status: 'running' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'access', status: 'awaiting', summary: 'Shared with 1 group.' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'access', status: 'done' }] } })).body.playbook;
    // …and the COMPLIANCE review closes it: what was built, read against the
    // frameworks this organisation has switched on.
    assert.equal(phase(pb, 'compliance').status, 'ready');
    const reviewed = await api('POST', `/${pb.id}/phases/compliance/run`);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    pb = reviewed.body.playbook;
    assert.equal(phase(pb, 'compliance').status, 'awaiting');
    assert.equal(phase(pb, 'compliance').artifacts.findings.length, 1);
    const seen = state.reviewInputs.at(-1);
    assert.deepEqual(seen.facts.frameworks, ['GDPR', 'ISO27001']);
    assert.equal(seen.facts.table.name, 'Facturen');
    assert.deepEqual(seen.facts.automations.map((a) => a.title), ['Facturen inlezen', 'Facturen inlezen']);
    assert.equal(seen.facts.app.name, 'Facturen');
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'compliance', status: 'done' }] } })).body.playbook;
    assert.equal(pb.status, 'done');
    assert.equal(pb.currentPhase, null);
});

test('fill refusals and the slow run: a non-manual routine is 422 trigger_not_manual; a run past the guard answers 202 and GET finishes it later', async () => {
    let pb = (await create()).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'table', status: 'done' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'running' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'awaiting', artifacts: { automationId: 'a1' } }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'routine', status: 'done' }] } })).body.playbook;
    state.automations.a1.definition.trigger.kind = 'nextcloud_file';
    const bad = await api('POST', `/${pb.id}/phases/fill/run`);
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'trigger_not_manual');
    assert.equal(phase(bad.body.playbook, 'fill').status, 'failed');
    state.automations.a1.definition.trigger.kind = 'manual';
    pb = (await api('POST', `/${pb.id}/phases/fill/retry`, { body: { expectedVersion: bad.body.playbook.version } })).body.playbook;
    assert.equal(phase(pb, 'fill').status, 'ready');
    // A run that does not finish inside the guard.
    let finishRun;
    deps.timeoutMs = 30;
    state.execute = async (a, opts) => { opts.onRunCreated({ id: 'run_slow' }); state.runs.run_slow = { id: 'run_slow', status: 'running' }; return new Promise((res) => { finishRun = res; }); };
    const pending = await api('POST', `/${pb.id}/phases/fill/run`);
    assert.equal(pending.status, 202, JSON.stringify(pending.body));
    assert.equal(pending.body.pending, true);
    assert.equal(phase(pending.body.playbook, 'fill').status, 'running');
    assert.equal(phase(pending.body.playbook, 'fill').artifacts.runId, 'run_slow');
    // GET while running reports the row count as it grows.
    state.rowCount = 7;
    const mid = await api('GET', `/${pb.id}`);
    assert.equal(phase(mid.body.playbook, 'fill').status, 'running');
    assert.equal(phase(mid.body.playbook, 'fill').artifacts.rowCount, 7);
    // The run ends; GET turns the phase.
    state.rowCount = 32;
    state.runs.run_slow = { id: 'run_slow', status: 'success' };
    finishRun(state.runs.run_slow);
    await new Promise((r) => setTimeout(r, 20));
    const done = await api('GET', `/${pb.id}`);
    assert.equal(phase(done.body.playbook, 'fill').status, 'awaiting');
    assert.match(phase(done.body.playbook, 'fill').summary, /32 rijen/);
    delete deps.timeoutMs;
});

test('skip and retry: skipping advances (never the table); a locked approvals phase retries only with the capability; delete removes nothing but the playbook', async () => {
    state.approvals = false;
    let pb = (await create()).body.playbook;
    assert.equal((await api('POST', `/${pb.id}/phases/table/skip`, { body: { expectedVersion: pb.version } })).body.code, 'illegal_transition');
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'table', status: 'done' }] } })).body.playbook;
    const skipped = await api('POST', `/${pb.id}/phases/routine/skip`, { body: { expectedVersion: pb.version } });
    assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
    pb = skipped.body.playbook;
    assert.equal(statuses(pb), 'table:done routine:skipped fill:ready design:pending app:pending approvals:locked access:pending compliance:pending');
    const noCap = await api('POST', `/${pb.id}/phases/approvals/retry`, { body: { expectedVersion: pb.version } });
    assert.equal(noCap.body.code, 'capability_missing');
    state.approvals = true;
    const withCap = await api('POST', `/${pb.id}/phases/approvals/retry`, { body: { expectedVersion: pb.version } });
    assert.equal(withCap.status, 200, JSON.stringify(withCap.body));
    assert.equal(phase(withCap.body.playbook, 'approvals').status, 'ready');
    assert.equal((await api('DELETE', `/${pb.id}`, { user: 'u2' })).status, 404);
    assert.equal((await api('DELETE', `/${pb.id}`)).status, 204);
    assert.equal((await api('GET', `/${pb.id}`)).status, 404);
    assert.equal(state.createdTables.length, 1, 'the table is still there');
});

test('a custom recipe document: compose returns it, create stores it with kinds/labels and a fill phase added, the phases run by KIND, and a missing column skips the turn that needs it', async () => {
    const composed = await api('POST', '/recipes/compose', { body: { description: 'Lees leverancierslijsten in en maak een directory-app' } });
    assert.equal(composed.status, 200, JSON.stringify(composed.body));
    assert.deepEqual(composed.body.recipe.phases.map((p) => p.kind), ['table', 'routine', 'app', 'app_turn']);
    assert.equal((await api('POST', '/recipes/compose', { body: {} })).body.code, 'description_required');
    state.compose = async () => ({ ok: false, code: 'recipe_invalid', status: 422, error: 'no', errors: [{ code: 'brief_required', path: 'phases[1].brief' }] });
    assert.equal((await api('POST', '/recipes/compose', { body: { description: 'x' } })).status, 422);

    // Create from the document: normalised (a fill phase after the routine), stored on the row.
    const created = await api('POST', '/', { body: { recipe: composed.body.recipe, title: 'Leveranciers', options: { tableMode: 'new', inputs: { folderPath: '/Leveranciers-Test' } } } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    let pb = created.body.playbook;
    assert.equal(pb.recipeId, 'custom_leveranciers_volgen');
    assert.ok(pb.recipe && pb.recipe.phases, 'the document travels with the playbook');
    assert.deepEqual(pb.phases.map((p) => [p.key, p.kind]), [['table', 'table'], ['inlezen', 'routine'], ['fill', 'fill'], ['design', 'design'], ['app', 'app'], ['rating_turn', 'app_turn'], ['access', 'access'], ['compliance', 'compliance']]);
    assert.deepEqual(pb.options.inputs, { folderPath: '/Leveranciers-Test' });
    assert.equal(pb.options.folderPath, '/Leveranciers-Test');
    // An invalid document is refused with the validator's findings.
    const bad = await api('POST', '/', { body: { recipe: { title: 'x', phases: [{ key: 'a', kind: 'fill', label: 'Fill' }] } } });
    assert.equal(bad.body.code, 'recipe_invalid');
    assert.ok(bad.body.errors.some((e) => e.code === 'fill_without_routine'));

    // The table phase runs by kind and creates the document's columns; the routine brief renders the real ids.
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    assert.equal(phase(pb, 'table').status, 'awaiting');
    assert.deepEqual(state.createdTables.at(-1).fields.map((f) => f.key), ['naam', 'email', 'rating']);
    assert.match(phase(pb, 'inlezen').brief, /"Leveranciers" \(id tbl_new1, key leveranciers\)/);
    assert.match(phase(pb, 'inlezen').brief, /nextcloud_list_files on "\/Leveranciers-Test"/);
    assert.match(phase(pb, 'inlezen').brief, /with naam, email\./);
    // A builder phase refuses the server-run route.
    assert.equal((await api('POST', `/${pb.id}/phases/inlezen/run`)).body.code, 'illegal_transition');
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'table', status: 'done' }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'inlezen', status: 'running', artifacts: { automationId: 'a1' } }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'inlezen', status: 'awaiting', artifacts: { automationId: 'a1' } }] } })).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'inlezen', status: 'done' }] } })).body.playbook;
    assert.equal(phase(pb, 'fill').status, 'ready');
    // The fill phase runs the routine BEFORE it (key `inlezen`, not `routine`).
    const filled = await api('POST', `/${pb.id}/phases/fill/run`);
    assert.equal(filled.status, 200, JSON.stringify(filled.body));
    pb = filled.body.playbook;
    assert.equal(phase(pb, 'fill').artifacts.runId, 'run_1');
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'fill', status: 'done' }] } })).body.playbook;
    assert.equal(phase(pb, 'design').status, 'ready');
    assert.equal(phase(pb, 'design').goal, 'Reads supplier sheets into a table and builds a directory app.');
    pb = (await api('POST', `/${pb.id}/phases/design/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'design', status: 'done' }] } })).body.playbook;
    // The app was pre-created for the app phase AND its later turn; the app brief rendered.
    assert.ok(phase(pb, 'app').artifacts.appId);
    assert.equal(phase(pb, 'rating_turn').artifacts.appId, phase(pb, 'app').artifacts.appId);
    assert.match(phase(pb, 'app').brief, /app_link_datatable \{name:"Leveranciers"\}/);
});

test('a custom recipe on an EXISTING table: the turn that needs a missing column is skipped with the reason', async () => {
    // The fake table has no `rating` column (getTableMeta serves the invoice schema minus status/bestand).
    const doc = { ...CUSTOM_DOC, table: { fields: [{ key: 'datum', name: 'Datum', type: 'date' }, { key: 'leverancier', name: 'Leverancier', type: 'text' }, { key: 'rating', name: 'Rating', type: 'number', required: false }] }, phases: CUSTOM_DOC.phases.map((p) => (p.kind === 'routine' ? { ...p, brief: 'Build a routine that I start by hand. datatable add_row into "{{table.name}}" (id {{table.id}}) with {{field.datum}}, {{field.leverancier}}.' } : p.kind === 'app' ? { ...p, brief: 'Build an app on "{{table.name}}" with {{field.datum}}. Finish with app_finalize.' } : p)) };
    let pb = (await api('POST', '/', { body: { recipe: doc, options: { tableMode: 'existing', datatableId: 'tbl_ex', inputs: { folderPath: '/L' } } } })).body.playbook;
    pb = (await api('POST', `/${pb.id}/phases/table/run`)).body.playbook;
    assert.equal(phase(pb, 'table').status, 'awaiting', JSON.stringify(phase(pb, 'table')));
    assert.deepEqual(phase(pb, 'table').artifacts.mapping, { datum: 'datum', leverancier: 'leverancier' });
    for (const step of [['table', 'done'], ['inlezen', 'running', { automationId: 'a1' }], ['inlezen', 'awaiting', { automationId: 'a1' }], ['inlezen', 'done'], ['fill', null], ['fill', 'done'], ['design', null], ['design', 'done'], ['app', 'running'], ['app', 'awaiting'], ['app', 'done']]) {
        if (step[1] === null) { pb = (await api('POST', `/${pb.id}/phases/${step[0]}/run`)).body.playbook; continue; }
        const r = await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: step[0], status: step[1], ...(step[2] ? { artifacts: step[2] } : {}) }] } });
        assert.equal(r.status, 200, `${step.join(' ')}: ${JSON.stringify(r.body)}`);
        pb = r.body.playbook;
    }
    assert.equal(phase(pb, 'rating_turn').status, 'skipped');
    assert.equal(phase(pb, 'rating_turn').error, 'no_rating_column');
    // A composed recipe gets the access phase too — it is the server's, not
    // something every recipe document has to remember to ask for.
    assert.equal(phase(pb, 'access').status, 'ready');
    for (const status of ['running', 'awaiting', 'done']) {
        pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'access', status }] } })).body.playbook;
    }
    pb = (await api('POST', `/${pb.id}/phases/compliance/run`)).body.playbook;
    pb = (await api('PATCH', `/${pb.id}`, { body: { expectedVersion: pb.version, phases: [{ key: 'compliance', status: 'done' }] } })).body.playbook;
    assert.equal(pb.status, 'done');
});

