/**
 * Unit tests for the App Studio builder tools (appStudio/builderTools.js).
 *
 * The stores (studioAppStore, automationStore, userStore) are mocked via the
 * Module._resolveFilename harness (same pattern as routes/studioApps.test.js)
 * so no DB pool is opened; componentSpecs / canonicalize / validate /
 * definitionOps run for real.
 *
 * Run: node --test appStudio/builderTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// ── Mock stores ─────────────────────────────────────────────────────

const state = {
    apps: new Map(),
    nextApp: 0,
    conflictOnce: false,   // first saveDefinition call conflicts, then succeeds
    conflictAlways: false, // every saveDefinition call conflicts
    tooLarge: false,       // saveDefinition throws code='definition_too_large'
    metaSyncs: [],
};

const mockStudioAppStore = {
    async createStudioApp({ userId, organizationId, name, description, icon, definition } = {}) {
        const id = `app-${++state.nextApp}`;
        const app = {
            id, userId,
            organizationId: organizationId || null,
            name: name || 'Untitled app',
            description: description || '',
            icon: icon || null,
            definition: clone(definition),
            definitionVersion: 1,
        };
        state.apps.set(id, app);
        return clone(app);
    },
    async getStudioApp(id) {
        const a = state.apps.get(id);
        return a ? clone(a) : null;
    },
    async saveDefinition(id, ownerId, definition, { expectedVersion = null } = {}) {
        if (state.tooLarge) {
            const err = new Error('too big');
            err.code = 'definition_too_large';
            throw err;
        }
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return { ok: false, notFound: true };
        if (state.conflictAlways || state.conflictOnce) {
            state.conflictOnce = false;
            // Simulate a concurrent writer: bump the stored version so the
            // caller's expectedVersion no longer matches.
            a.definitionVersion += 1;
            return { ok: false, conflict: true, currentVersion: a.definitionVersion, definition: clone(a.definition) };
        }
        if (expectedVersion != null && a.definitionVersion !== expectedVersion) {
            return { ok: false, conflict: true, currentVersion: a.definitionVersion, definition: clone(a.definition) };
        }
        a.definition = clone(definition);
        a.definitionVersion += 1;
        return { ok: true, version: a.definitionVersion };
    },
    async updateStudioApp(id, updates = {}, ownerId) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return null;
        state.metaSyncs.push({ id, ...updates });
        for (const k of ['name', 'description', 'icon']) {
            if (updates[k] !== undefined) a[k] = updates[k];
        }
        return clone(a);
    },
};

const AUTOMATIONS = [
    {
        id: 'auto-1', userId: 'u1', title: 'Find customer', description: 'Searches the CRM.',
        isActive: true, triggerType: 'agent_call',
        definition: { trigger: { kind: 'agent_call', parametersSchema: { type: 'object', properties: { query: { type: 'string' } } } } },
    },
    {
        id: 'auto-2', userId: 'u1', title: 'Daily digest', description: '',
        isActive: false, triggerType: 'schedule',
        definition: { trigger: { kind: 'schedule', schedule: { cron: '0 9 * * *', tz: 'Europe/Amsterdam' } } },
    },
    {
        id: 'auto-other', userId: 'someone-else', title: 'Not yours',
        isActive: true, triggerType: 'manual', definition: { trigger: { kind: 'manual' } },
    },
];

const mockAutomationStore = {
    getAutomationsForUser: async (userId) => clone(AUTOMATIONS.filter((a) => a.userId === userId)),
    getAutomation: async (id) => clone(AUTOMATIONS.find((a) => a.id === id) || null),
};

const mockUserStore = {
    getUser: async (id) => ({ id, organizationId: 'org-backfilled' }),
};

// ── Mock data stores (Wave 3A — the data engine's Postgres/SQLite edges).
//    The appStudio layer (dataModel, actionExecutor incl. the REAL
//    writeRecord, queryCompiler, rlsGateway, datasetCache, studioAppQuota)
//    runs for real on top of these. ─────────────────────────────────

const dataState = {
    metaByApp: new Map(),   // appId → { model, version }
    rowCounts: {},          // keyed by table KEY (like the real store)
    datasets: new Map(),    // id → dataset row
    nextDataset: 0,
    conflictOnce: false,    // next saveDataModel call conflicts once
    conflictAlways: false,  // every saveDataModel call conflicts
    saveCalls: [],
    execCalls: [],
    queryRows: [],          // what studioAppDbStore.query returns
    dbSize: 0,
};

const mockStudioAppDataStore = {
    async getDataModel(appId) {
        const meta = dataState.metaByApp.get(appId);
        if (!meta) return null;
        return { model: clone(meta.model), modelVersion: meta.version, dataVersions: {}, rowCounts: clone(dataState.rowCounts) };
    },
    async saveDataModel(appId, ownerId, model, { expectedVersion = null } = {}) {
        dataState.saveCalls.push({ appId, expectedVersion, model: clone(model) });
        const { validateDataModel, emptyDataModel } = require('./dataModel');
        const { errors } = validateDataModel(model);
        if (errors.length) return { ok: false, invalid: true, errors };
        const cur = dataState.metaByApp.get(appId) || { model: emptyDataModel(), version: 0 };
        if (dataState.conflictAlways || dataState.conflictOnce) {
            dataState.conflictOnce = false;
            return { ok: false, conflict: true, currentVersion: cur.version, model: clone(cur.model) };
        }
        if (expectedVersion != null && cur.version !== expectedVersion) {
            return { ok: false, conflict: true, currentVersion: cur.version, model: clone(cur.model) };
        }
        dataState.metaByApp.set(appId, { model: clone(model), version: cur.version + 1 });
        return { ok: true, version: cur.version + 1 };
    },
    async getRowCounts() { return clone(dataState.rowCounts); },
    async bumpRowCount(appId, tableKey, delta) {
        dataState.rowCounts[tableKey] = Math.max(0, (parseInt(dataState.rowCounts[tableKey], 10) || 0) + delta);
        return clone(dataState.rowCounts);
    },
    async bumpDataVersion() { return 1; },
    async getMemberRole() { return null; },
    async createDataset(appId, ownerId, { name, tableId, descriptor, cacheTtlSeconds } = {}) {
        const id = `ds_test${++dataState.nextDataset}`;
        const row = { id, appId, name: name || 'Untitled dataset', tableId: tableId || null, descriptor: clone(descriptor || {}), cacheTtlSeconds: cacheTtlSeconds ?? 60 };
        dataState.datasets.set(id, row);
        return clone(row);
    },
    async updateDataset(id, appId, ownerId, updates = {}) {
        const row = dataState.datasets.get(id);
        if (!row || row.appId !== appId) return null;
        Object.assign(row, clone(updates));
        return clone(row);
    },
    async getDataset(id, appId) {
        const row = dataState.datasets.get(id);
        return row && row.appId === appId ? clone(row) : null;
    },
    async deleteDataset(id) { return dataState.datasets.delete(id); },
    async getCache() { return null; },
    async putCache() { return { ok: true }; },
};

const mockStudioAppDbStore = {
    async exec(ownerId, appId, sql, params) {
        dataState.execCalls.push({ ownerId, appId, sql, params });
        return { changes: 1 };
    },
    async query(ownerId, appId, sql, params) {
        dataState.execCalls.push({ ownerId, appId, sql, params, read: true });
        return { columns: [], rows: clone(dataState.queryRows), truncated: false };
    },
    async sizeBytes() { return dataState.dbSize; },
};

// Captured templates (app_save_as_template). Records what was handed to the
// store so the tests can assert on the PAYLOAD, which is the part that has to
// be right — it is what somebody else's app gets built from.
const templateState = { saved: [], rows: [], failWith: null, nextId: 0 };
const mockStudioAppTemplateStore = {
    isCapturedTemplateId: (id) => typeof id === 'string' && id.startsWith('utpl_'),
    canRead: () => true,
    async saveTemplate(args) {
        if (templateState.failWith) throw new Error(templateState.failWith);
        templateState.saved.push(clone(args));
        return { ...args, id: args.id || `utpl_${++templateState.nextId}`, version: args.id ? 2 : 1 };
    },
    async listTemplatesFor() { return templateState.rows; },
    async getTemplateById(id) { return templateState.rows.find((r) => r.id === id) || null; },
};

// ── Require-cache injection (before builderTools loads) ─────────────

const MOCKS = {
    '../../stores/documentStore': {listTemplates:async()=>[],getDocument:async()=>null,getDocumentVersion:async()=>null},
    // request strings as issued from appStudio/* (actionExecutor, datasetCache,
    // templateCapture, …) AND from the appStudio/builderTools/* tool modules
    '../stores/studioAppStore': mockStudioAppStore,
    '../../stores/studioAppStore': mockStudioAppStore,
    '../stores/automationStore': mockAutomationStore,
    '../../stores/automationStore': mockAutomationStore,
    '../stores/userStore': mockUserStore,
    '../../stores/userStore': mockUserStore,
    '../stores/studioAppDataStore': mockStudioAppDataStore,
    '../../stores/studioAppDataStore': mockStudioAppDataStore,
    '../stores/studioAppDbStore': mockStudioAppDbStore,
    '../../stores/studioAppDbStore': mockStudioAppDbStore,
    '../stores/studioAppTemplateStore': mockStudioAppTemplateStore,
    '../../stores/studioAppTemplateStore': mockStudioAppTemplateStore,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const { applyToolCall, persistDraft, MUTATING_TOOLS, TOOL_SCHEMAS, boundPlanArtifact } = require('./builderTools');
const { emptyDefinition } = require('./componentSpecs');
const { validateAppDefinition } = require('./validate');
const ops = require('./definitionOps');

function freshWrap() {
    return { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_test', def: emptyDefinition('Test app') };
}

function homeSectionId(wrap) {
    return wrap.def.screens[0].sections[0].id;
}

// ── Meta / theme ────────────────────────────────────────────────────

test('app_set_meta merges name/description/icon', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_set_meta', { name: 'Lookup console', icon: 'Search' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(wrap.def.meta.name, 'Lookup console');
    assert.strictEqual(wrap.def.meta.icon, 'Search');
    assert.strictEqual(wrap.def.meta.description, '', 'untouched fields keep their value');
    const r2 = await applyToolCall('app_set_meta', {}, wrap);
    assert.ok(r2.error, 'empty patch is rejected');
});

test('app_set_theme applies knobs and surfaces canonicalize repairs as _hints', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_set_theme', { primary: '#B45309', radius: 'gigantic' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(wrap.def.theme.primary, '#B45309');
    assert.strictEqual(wrap.def.theme.radius, 'md', 'invalid enum defaulted by canonicalize');
    assert.ok(Array.isArray(r._hints) && r._hints.some((h) => h.includes('theme.radius')), 'repair hint mentions the defaulted knob');
});

test('app_set_theme applies a PRESET as one materialized look (theme + design + nav)', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_set_theme', { preset: 'cloud' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(wrap.def.theme.primary, '#1D4ED8');
    assert.strictEqual(wrap.def.theme.radius, 'lg');
    assert.strictEqual(wrap.def.design.preset, 'cloud');
    assert.strictEqual(wrap.def.design.font, 'satoshi');
    assert.strictEqual(wrap.def.design.surface, 'soft');
    assert.strictEqual(wrap.def.nav.style, 'sidebar');
    // The preset is MATERIALIZED, not referenced: later edits to the preset
    // definition can never silently restyle an app that was already built.
    assert.deepStrictEqual(Object.keys(wrap.def.design).sort(),
        ['accentEdge', 'chartPalette', 'font', 'logoUrl', 'motion', 'preset', 'surface'].sort());
});

test('app_set_theme: explicit knobs win over the preset, and diverging marks the look custom', async () => {
    const wrap = freshWrap();
    await applyToolCall('app_set_theme', { preset: 'cloud', primary: '#B91C1C' }, wrap);
    assert.strictEqual(wrap.def.theme.primary, '#B91C1C', 'explicit knob beats the preset');
    assert.strictEqual(wrap.def.design.preset, 'cloud', 'one call with a preset still records its provenance');

    const r = await applyToolCall('app_set_theme', { surface: 'elevated' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(wrap.def.design.surface, 'elevated');
    assert.strictEqual(wrap.def.design.preset, 'custom', 'changing a knob afterwards makes it the author’s own look');
});

test('app_set_theme: navStyle alone, unknown preset refused, empty call refused', async () => {
    const wrap = freshWrap();
    const nav = await applyToolCall('app_set_theme', { navStyle: 'sidebar' }, wrap);
    assert.ok(!nav.error, JSON.stringify(nav));
    assert.strictEqual(wrap.def.nav.style, 'sidebar');
    assert.ok(!wrap.def.design, 'navStyle alone does not invent a design block');

    const bad = await applyToolCall('app_set_theme', { preset: 'neon' }, wrap);
    assert.match(bad.error, /Unknown preset/);
    const empty = await applyToolCall('app_set_theme', {}, wrap);
    assert.ok(empty.error, 'an empty call is still rejected');
});

// ── Screens & sections ──────────────────────────────────────────────

test('app_add_screen returns screenId + sectionId and applies settings', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_screen', { name: 'Search', icon: 'Search', showInNav: false, maxWidth: 'narrow' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const screen = ops.findScreen(wrap.def, r.screenId);
    assert.ok(screen, 'screen exists in the draft');
    assert.strictEqual(screen.name, 'Search');
    assert.strictEqual(screen.icon, 'Search');
    assert.strictEqual(screen.showInNav, false);
    assert.strictEqual(screen.maxWidth, 'narrow');
    assert.strictEqual(screen.sections[0].id, r.sectionId, 'sectionId is the screen\'s first section');
});

test('app_add_screen is capped by the screen count the person asked for: the first add renames Home, the next is refused with the screen to build on', async () => {
    const { deriveScreenConstraints } = require('../core/llm/screenConstraints');
    const wrap = freshWrap();
    wrap._screenConstraint = deriveScreenConstraints('In the app I want only a data insight dashboard.');
    const first = await applyToolCall('app_add_screen', { name: 'Dashboard' }, wrap);
    assert.ok(!first.error, JSON.stringify(first));
    assert.strictEqual(first.reusedHome, true, 'renaming the untouched Home does not add a screen');
    const second = await applyToolCall('app_add_screen', { name: 'Invoice detail' }, wrap);
    assert.match(second.error, /exactly 1 screen \("only a data insight dashboard"\) and the app already has 1: "Dashboard" \(scr_[a-z0-9]+\)\. A screen "Invoice detail" was not added\./);
    assert.match(second._fixHint, /Put what this screen was for ON "Dashboard" \(scr_[a-z0-9]+\)/);
    assert.match(second._fixHint, /SCREENS \(binding/);
    assert.strictEqual(second.screenLimit, 1);
    assert.strictEqual(wrap.def.screens.length, 1);
    // A later turn that asks for the detail page lifts the rule (the route re-derives it per turn).
    wrap._screenConstraint = deriveScreenConstraints('Add a detail page for one invoice.');
    const third = await applyToolCall('app_add_screen', { name: 'Invoice detail' }, wrap);
    assert.ok(!third.error, JSON.stringify(third));
    assert.strictEqual(wrap.def.screens.length, 2);
    // No constraint, no ceiling.
    const free = freshWrap();
    await applyToolCall('app_add_screen', { name: 'A' }, free);
    const more = await applyToolCall('app_add_screen', { name: 'B' }, free);
    assert.ok(!more.error);
});

test('app_update_screen renames + makeHome; unknown screen rejects with hint', async () => {
    const wrap = freshWrap();
    const { screenId } = await applyToolCall('app_add_screen', { name: 'Second' }, wrap);
    const r = await applyToolCall('app_update_screen', { screenId, name: 'Renamed', makeHome: true }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.screen.name, 'Renamed');
    assert.strictEqual(wrap.def.homeScreenId, screenId);

    const bad = await applyToolCall('app_update_screen', { screenId: 'scr_nope99', name: 'x' }, wrap);
    assert.ok(bad.error && bad._fixHint, 'unknown screen rejected with a fix hint');
});

test('app_remove_screen refuses the last screen, repoints home otherwise', async () => {
    const wrap = freshWrap();
    const only = wrap.def.screens[0].id;
    const refused = await applyToolCall('app_remove_screen', { screenId: only }, wrap);
    assert.ok(refused.error && /at least one screen/i.test(refused.error));

    // The FIRST screen a build adds takes the empty default Home's place (2026-09-14) —
    // so "Second" here is the renamed Home; a real second screen is the next add.
    const first = await applyToolCall('app_add_screen', { name: 'Second' }, wrap);
    assert.strictEqual(first.screenId, only, 'the untouched Home is reused, not left blank');
    assert.strictEqual(first.reusedHome, true);
    assert.deepStrictEqual(wrap.def.screens.map((s) => s.name), ['Second']);
    const { screenId } = await applyToolCall('app_add_screen', { name: 'Third' }, wrap);
    await applyToolCall('app_update_screen', { screenId, makeHome: true }, wrap);
    const r = await applyToolCall('app_remove_screen', { screenId }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.removed, screenId);
    assert.strictEqual(wrap.def.homeScreenId, only, 'home repointed to the remaining screen');
});

test('app_add_section adds a section and clamps style via canonicalize', async () => {
    const wrap = freshWrap();
    const screenId = wrap.def.screens[0].id;
    const r = await applyToolCall('app_add_section', { screenId, style: { padding: 99, background: 'tint' } }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const found = ops.findSection(wrap.def, r.sectionId);
    assert.ok(found, 'section exists');
    assert.strictEqual(found.section.style.padding, 6, 'padding clamped to the knob max');
    assert.strictEqual(found.section.style.background, 'tint');
    assert.ok(r._hints.some((h) => /clamped/i.test(h)), 'clamp surfaced as a hint');
});

// ── Components ──────────────────────────────────────────────────────

test('app_update_section restyles in place; unknown id and an empty patch reject', async () => {
    // The gap this closes: a section could be styled at creation and never
    // again, so a section emptied by app_move_node kept its padding and
    // rendered as a band of empty space nothing could close.
    const wrap = freshWrap();
    const added = await applyToolCall('app_add_section', {
        screenId: wrap.def.screens[0].id, style: { padding: 4, gap: 3 },
    }, wrap);
    const sectionId = added.sectionId;

    const r = await applyToolCall('app_update_section', { sectionId, style: { padding: 0 } }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const section = wrap.def.screens[0].sections.find((s) => s.id === sectionId);
    assert.strictEqual(section.style.padding, 0);
    // A patch, not a replacement: the keys left out keep their values.
    assert.strictEqual(section.style.gap, 3);

    const unknown = await applyToolCall('app_update_section', { sectionId: 'sec_nope', style: { padding: 0 } }, wrap);
    assert.ok(unknown.error && /Unknown sectionId/.test(unknown.error));
    const empty = await applyToolCall('app_update_section', { sectionId, style: {} }, wrap);
    assert.ok(empty.error && /Nothing to change/.test(empty.error));
});

test('app_add_components: batch with nested container resolves tempIds (nested too)', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'heading', props: { text: 'Lookup', level: 1 } },
            {
                tempId: 'frm', type: 'form', props: { name: 'search', submitLabel: 'Search' }, style: { span: 12 },
                children: [
                    { tempId: 'qry', type: 'input_text', props: { name: 'query', label: 'Query' }, style: { span: 8 } },
                ],
            },
            { type: 'table', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'name', label: 'Name' }] } },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.added.length, 4, 'nested children are reported too');
    assert.ok(r.ids.frm && r.ids.qry, 'tempId map covers nested entries');

    const form = ops.findNode(wrap.def, r.ids.frm);
    assert.ok(form, 'form landed in the draft');
    assert.strictEqual(form.parent.id, parentId, 'form sits in the requested section');
    const input = ops.findNode(wrap.def, r.ids.qry);
    assert.ok(input, 'nested input landed');
    assert.strictEqual(input.parent.id, r.ids.frm, 'input is INSIDE the form');
    assert.strictEqual(input.node.props.label, 'Query');
});

test('app_add_components: canonicalize clamp is visible in result hints', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'h', type: 'heading', props: { text: 'Big' }, style: { span: 99 } }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const node = ops.findNode(wrap.def, r.ids.h).node;
    assert.strictEqual(node.style.span, 12, 'span clamped to 12');
    assert.ok(r._hints.some((h) => /span/.test(h) && /clamped/i.test(h)), `hints mention the clamp: ${JSON.stringify(r._hints)}`);
});

test('app_add_components: unknown parentId rejected with _fixHint', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: 'sec_zzzzzz',
        components: [{ type: 'heading', props: { text: 'x' } }],
    }, wrap);
    assert.ok(r.error && /unknown parentid/i.test(r.error));
    assert.ok(r._fixHint, 'carries a fix hint');
});

// ── Partial apply (2026-09-17) ──────────────────────────────────────
//
// app_add_components was all-or-nothing: one bad entry voided the batch.
// The recorded dashboard turn (traces/2026-09-16-invoice-dashboard.json)
// shows what that cost — a whole screen refused for one broken card, then
// rebuilt one component at a time with the header last. Now every
// top-level entry is built on its own: the good ones land, each bad one is
// reported at its path with the resend it needs, and the identical batch
// resent builds only what failed.

test('app_add_components: a non-container parent still refuses the call; an unknown type fails ONLY its entry', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'h', type: 'heading', props: { text: 'x' } }],
    }, wrap);

    const notContainer = await applyToolCall('app_add_components', {
        parentId: ids.h,
        components: [{ type: 'text', props: { text: 'y' } }],
    }, wrap);
    assert.ok(notContainer.error && /not a container/i.test(notContainer.error));

    const badType = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [
            { type: 'text', props: { text: 'fine' } },
            { type: 'tabel', props: {} },
        ],
    }, wrap);
    assert.ok(!badType.error, JSON.stringify(badType));
    assert.deepStrictEqual(badType.added.map((a) => a.type), ['text'], 'the good entry landed');
    assert.strictEqual(badType.failed.length, 1);
    assert.deepStrictEqual([badType.failed[0].index, badType.failed[0].path], [1, 'components[1]']);
    assert.match(badType.failed[0].error, /unknown component type "tabel"/i);
    assert.ok(badType.failed[0].error.includes('"table"'), 'closest-match suggestion offered');
    assert.match(badType.failed[0]._fixHint, /Resend ONLY components\[1\] as its own app_add_components call \(parentId unchanged\)/);
    assert.ok(badType._hints.some((h) => /1 entry failed and was skipped; the rest landed/.test(h)), JSON.stringify(badType._hints));
    const types = ops.findSection(wrap.def, homeSectionId(wrap)).section.children.map((c) => c.type);
    assert.deepStrictEqual(types, ['heading', 'text'], 'only the good entry was inserted');

    // Every entry bad → a plain error led by the first failure, with failed[].
    const before = JSON.stringify(wrap.def);
    const allBad = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ type: 'tabel', props: {} }, { type: 'knop', props: {} }],
    }, wrap);
    assert.match(allBad.error, /unknown component type "tabel".*\(1 more entry failed — see failed\[\]\)/i);
    assert.strictEqual(allBad.failed.length, 2);
    assert.match(allBad._fixHint, /Legal component types:/);
    assert.strictEqual(JSON.stringify(wrap.def), before, 'nothing was inserted');
});

test('app_add_components: the identical batch resent after a partial apply builds only what failed; the landed subset alone is Nothing new', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const batch = { parentId, components: [{ type: 'heading', props: { text: 'Hi' } }, { type: 'tabel', props: {} }, { type: 'text', props: { text: 'body' } }] };
    const first = await applyToolCall('app_add_components', batch, wrap);
    assert.deepStrictEqual(first.added.map((a) => a.type), ['heading', 'text']);
    assert.strictEqual(first.failed[0].index, 1);
    // The same batch again: the heading and the text are NOT minted twice;
    // the failed entry is tried again (and fails again, on its own).
    const again = await applyToolCall('app_add_components', JSON.parse(JSON.stringify(batch)), wrap);
    assert.ok(again.error, JSON.stringify(again));
    assert.match(again.error, /unknown component type "tabel"/i);
    assert.ok((again._hints || []).some((h) => /2 of 3 entries already landed from this exact batch .* and were skipped — only the 1 that failed before was applied/.test(h)), JSON.stringify(again._hints));
    // The retried entry is reported where the model SENT it — components[1],
    // not components[0] of the retried subset (a hint that said "resend
    // components[0]" would point at the heading).
    assert.deepStrictEqual([again.failed[0].index, again.failed[0].path], [1, 'components[1]']);
    assert.match(again.error, /^components\[1\]:/);
    assert.strictEqual(ops.findSection(wrap.def, parentId).section.children.length, 2, 'no duplicates');
    // Fixed and resent alone: lands.
    const fixed = await applyToolCall('app_add_components', { parentId, components: [{ type: 'table', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'a', label: 'A' }] } }] }, wrap);
    assert.ok(!fixed.error, JSON.stringify(fixed));
    assert.strictEqual(ops.findSection(wrap.def, parentId).section.children.length, 3);
    // Just the landed subset resent: the classic duplicate answer.
    const subset = await applyToolCall('app_add_components', { parentId, components: [{ type: 'heading', props: { text: 'Hi' } }, { type: 'text', props: { text: 'body' } }] }, wrap);
    assert.match(String(subset.error), /Nothing new/);
    assert.strictEqual(ops.findSection(wrap.def, parentId).section.children.length, 3);
});

test('app_add_components: the WHOLE batch resent with the failed entry corrected builds only that entry — the landed ones are not minted twice', async () => {
    // The habit the all-or-nothing years trained ("nothing was applied —
    // resend"): a different signature, so the identical-batch net never
    // sees it; before this net the resend doubled the header and the text.
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const first = await applyToolCall('app_add_components', {
        parentId,
        components: [{ type: 'page_header', props: { title: 'Dash' } }, { type: 'tabel', props: {} }, { type: 'text', props: { text: 'body' } }],
    }, wrap);
    assert.deepStrictEqual(first.added.map((a) => a.type), ['page_header', 'text']);
    assert.strictEqual(first.failed[0].index, 1);
    const corrected = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { tempId: 'hd', type: 'page_header', props: { title: 'Dash' } },
            { tempId: 'tb', type: 'table', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'a', label: 'A' }] } },
            { type: 'text', props: { text: 'body' } },
        ],
    }, wrap);
    assert.ok(!corrected.error, JSON.stringify(corrected));
    assert.deepStrictEqual(corrected.added.map((a) => a.type), ['table'], 'only the corrected entry is built');
    assert.strictEqual(corrected.ids.hd, first.added[0].id, 'a tempId on a landed twin resolves to the twin');
    assert.ok((corrected._hints || []).some((h) => /2 entries already landed from an earlier batch this turn \(components\[0\] = page_header cmp_\w+, components\[2\] = text cmp_\w+\) and were skipped/.test(h)), JSON.stringify(corrected._hints));
    const children = ops.findSection(wrap.def, parentId).section.children;
    assert.deepStrictEqual(children.map((c) => c.type), ['page_header', 'table', 'text'], 'three components, the table where the resend put it');
    // The corrected batch sent yet again: the classic duplicate answer.
    const again = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'page_header', props: { title: 'Dash' } },
            { type: 'table', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'a', label: 'A' }] } },
            { type: 'text', props: { text: 'body' } },
        ],
    }, wrap);
    assert.match(String(again.error), /Nothing new/);
    assert.strictEqual(ops.findSection(wrap.def, parentId).section.children.length, 3);
    // A clean batch that never failed is NOT a dedupe source: a second body
    // text the model asks for on purpose is built.
    const clean = freshWrap();
    const cleanParent = homeSectionId(clean);
    const one = await applyToolCall('app_add_components', { parentId: cleanParent, components: [{ type: 'text', props: { text: 'body' } }] }, clean);
    assert.ok(!one.error && !one.failed);
    const two = await applyToolCall('app_add_components', { parentId: cleanParent, components: [{ type: 'heading', props: { text: 'More' } }, { type: 'text', props: { text: 'body' } }] }, clean);
    assert.ok(!two.error, JSON.stringify(two));
    assert.deepStrictEqual(two.added.map((a) => a.type), ['heading', 'text']);
});

test('app_add_components: a card resent with its dropped child fixed adds ONLY that child under the landed card', async () => {
    // The dropped-child repair the model reaches for instead of the
    // failed[]._fixHint resend: the whole card again, one stat corrected.
    // Its shell matches the card that landed, so the card is not built a
    // second time; the stat goes under the landed card's id, where the
    // resend placed it.
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const first = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'page_header', props: { title: 'Summary' } },
            { tempId: 'cd', type: 'card', props: { title: 'Totals' }, children: [
                { type: 'stat', props: { label: 'Total', value: 1 } },
                { type: 'sttat', props: { label: 'VAT', value: 2 } },
                { type: 'stat', props: { label: 'Count', value: 3 } },
            ] },
        ],
    }, wrap);
    assert.ok(!first.error, JSON.stringify(first));
    assert.strictEqual(first.failed[0].path, 'components[1].children[1]');
    const cardId = first.ids.cd;
    const fixed = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'page_header', props: { title: 'Summary' } },
            { tempId: 'cd', type: 'card', props: { title: 'Totals' }, children: [
                { type: 'stat', props: { label: 'Total', value: 1 } },
                { tempId: 'vat', type: 'stat', props: { label: 'VAT', value: 2 } },
                { type: 'stat', props: { label: 'Count', value: 3 } },
            ] },
        ],
    }, wrap);
    assert.ok(!fixed.error, JSON.stringify(fixed));
    assert.deepStrictEqual(fixed.added.map((a) => a.type), ['stat'], 'only the fixed stat is new');
    assert.strictEqual(fixed.ids.cd, cardId, 'the card tempId resolves to the landed card');
    assert.ok((fixed._hints || []).some((h) => /already landed from an earlier batch this turn/.test(h) && /1 new child was added under the container that had landed/.test(h)), JSON.stringify(fixed._hints));
    const section = ops.findSection(wrap.def, parentId).section;
    assert.deepStrictEqual(section.children.map((c) => c.type), ['page_header', 'card'], 'no second header, no second card');
    const card = ops.findNode(wrap.def, cardId).node;
    assert.deepStrictEqual(card.children.map((c) => c.props.label), ['Total', 'VAT', 'Count'], 'the stat sits where the resend put it');
    assert.strictEqual(ops.findNode(wrap.def, fixed.ids.vat).parent.id, cardId);
    // A child that is STILL wrong on the resend is reported under the card's real id.
    const stillBad = await applyToolCall('app_add_components', {
        parentId,
        components: [{ type: 'card', props: { title: 'Totals' }, children: [{ type: 'stat', props: { label: 'Total', value: 1 } }, { type: 'sttat', props: { label: 'Avg', value: 9 } }] }],
    }, wrap);
    assert.match(String(stillBad.error), /unknown component type "sttat"/i);
    assert.strictEqual(stillBad.failed[0].path, 'components[0].children[1]');
    assert.match(stillBad.failed[0]._fixHint, new RegExp(`with parentId "${cardId}" \\(its container, already built\\)`));
    assert.strictEqual(ops.findNode(wrap.def, cardId).node.children.length, 3, 'nothing doubled');
});

test('app_add_components: a bad child inside a card is dropped and reported at its path while the card lands', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [{
            tempId: 'cd', type: 'card', props: { title: 'Summary' },
            children: [
                { type: 'stat', props: { label: 'Total', value: 1 } },
                { type: 'sttat', props: { label: 'VAT', value: 2 } },
                { type: 'stat', props: { label: 'Count', value: 3 } },
            ],
        }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const card = ops.findNode(wrap.def, r.ids.cd).node;
    assert.deepStrictEqual(card.children.map((c) => c.props.label), ['Total', 'Count'], 'the card landed with its two good children');
    assert.strictEqual(r.failed.length, 1);
    assert.deepStrictEqual([r.failed[0].index, r.failed[0].path], [0, 'components[0].children[1]']);
    assert.match(r.failed[0].error, /unknown component type "sttat"/i);
    assert.match(r.failed[0]._fixHint, new RegExp(`Resend ONLY components\\[0\\]\\.children\\[1\\] as its own app_add_components call with parentId "${r.ids.cd}"`));
});

test('app_add_components: two content-identical entries are told apart by POSITION on the identical resend', async () => {
    // The batch record remembers the paths that failed, not their content:
    // two entries that are byte-equal (a duplicate-tempId pair) share a
    // content signature, and a content match retried BOTH — minting the one
    // that had landed a second time.
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const pair = { parentId, components: [{ tempId: 'k', type: 'button', props: { label: '1' } }, { tempId: 'k', type: 'button', props: { label: '1' } }] };
    const first = await applyToolCall('app_add_components', JSON.parse(JSON.stringify(pair)), wrap);
    assert.strictEqual(first.added.length, 1);
    assert.deepStrictEqual([first.failed[0].index, first.failed[0].path], [1, 'components[1]']);
    assert.match(first.failed[0].error, /duplicate tempId "k"/);
    const again = await applyToolCall('app_add_components', JSON.parse(JSON.stringify(pair)), wrap);
    assert.ok(!again.error, JSON.stringify(again));
    assert.strictEqual(again.added.length, 1, 'only the entry that failed is built');
    assert.ok((again._hints || []).some((h) => /1 of 2 entries already landed/.test(h)), JSON.stringify(again._hints));
    assert.strictEqual(ops.findSection(wrap.def, parentId).section.children.length, 2);
    // A third identical send: the whole batch has landed by now.
    const third = await applyToolCall('app_add_components', JSON.parse(JSON.stringify(pair)), wrap);
    assert.match(String(third.error), /Nothing new/);
    assert.strictEqual(ops.findSection(wrap.def, parentId).section.children.length, 2);
});

test('app_add_components: a child dropped two containers deep resends under the INNERMOST container\'s real id', async () => {
    // card > form > bad input — the FORM_SAVE few-shot's own shape. The hint
    // must name the form: an input resent under the section (or the card)
    // sits outside the form and never reaches the submit payload.
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'page_header', props: { title: 'Contacts' } },
            {
                tempId: 'cd', type: 'card', props: { title: 'New contact' },
                children: [{
                    tempId: 'frm', type: 'form', props: { name: 'contact_form' },
                    children: [
                        { type: 'input_text', props: { name: 'name', label: 'Name' } },
                        { type: 'input_txt', props: { name: 'email', label: 'Email' } },
                    ],
                }],
            },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.added.map((a) => a.type), ['page_header', 'card', 'form', 'input_text']);
    assert.strictEqual(r.failed.length, 1);
    assert.deepStrictEqual([r.failed[0].index, r.failed[0].path], [1, 'components[1].children[0].children[1]']);
    assert.match(r.failed[0]._fixHint, new RegExp(`with parentId "${r.ids.frm}" \\(its container, already built\\)`));
    assert.ok(!r.failed[0]._fixHint.includes('parentId unchanged'));
    const form = ops.findNode(wrap.def, r.ids.frm).node;
    assert.deepStrictEqual(form.children.map((c) => c.props.name), ['name'], 'the form landed with its one good input');
    // The identical batch again: the card (with its form) is not minted
    // twice; nothing is retried because the failed child belongs under the
    // form's id, which failed[]._fixHint names.
    const again = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'page_header', props: { title: 'Contacts' } },
            { tempId: 'cd', type: 'card', props: { title: 'New contact' }, children: [{ tempId: 'frm', type: 'form', props: { name: 'contact_form' }, children: [{ type: 'input_text', props: { name: 'name', label: 'Name' } }, { type: 'input_txt', props: { name: 'email', label: 'Email' } }] }] },
        ],
    }, wrap);
    assert.match(String(again.error), /Nothing new/);
});

test('app_add_components: a type written with a space is the underscore type; a merely wrong name gets the did-you-mean, never the debris refusal', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'data grid', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'a', label: 'A' }] } },
            { type: 'input txt', props: { name: 'x' } },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.added.map((a) => a.type), ['data_grid']);
    assert.ok(r._hints.some((h) => /type "data grid" read as "data_grid"/.test(h)), JSON.stringify(r._hints));
    assert.strictEqual(r.failed.length, 1);
    assert.match(r.failed[0].error, /unknown component type "input txt"\. Did you mean "input_text"\?/);
    assert.ok(!/arrived corrupted/.test(r.failed[0].error), 'a space is not JSON debris');
    // Real debris — a type that swallowed its neighbour — is still refused as such.
    const debris = await applyToolCall('app_add_components', {
        parentId,
        components: [{ type: 'chart},{props:{chartType:', props: {} }],
    }, wrap);
    assert.match(String(debris.error), /arrived corrupted — its "type" arrived as JSON debris/);
});

test('app_add_components: a style-only type-less wrapper is lifted', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [{ style: { span: 12 }, children: [{ tempId: 'a', type: 'stat', props: { label: 'Total', value: 1 } }, { tempId: 'b', type: 'stat', props: { label: 'VAT', value: 2 } }] }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(ops.findSection(wrap.def, parentId).section.children.map((c) => c.type), ['stat', 'stat']);
    assert.ok((r._hints || []).some((h) => /lifted in place/.test(h)));
});

test('app_add_components: keys that are not keys are debris — stripped from a group, fatal for a typed entry, counted once', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'heading', props: { text: 'Ok' } },
            // A group that lost its type to garbling: its debris key is its lost tail.
            { children: [{ type: 'stat', props: { label: 'A', value: 1 } }], '"style"': 0 },
            // A typed entry with debris inside: corrupted, not applied.
            { type: 'text', props: { text: 'x' }, '"style"': 0 },
            // Pure fragments.
            { '"type"': 0 },
            'bar',
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.added.map((a) => a.type), ['heading', 'stat']);
    assert.strictEqual(r.failed.length, 1);
    assert.deepStrictEqual([r.failed[0].index, r.failed[0].path], [2, 'components[2]']);
    assert.match(r.failed[0].error, /arrived corrupted — its JSON broke inside it/);
    assert.ok(r._hints.some((h) => /The call's JSON arrived corrupted \(3 keys that are not a key, 2 fragments dropped\)/.test(h)), JSON.stringify(r._hints));
});

// ── "section" and friends are the model's word for a container ──────
//
// Measured 2026-09-16: in one dashboard build, type "section" was refused
// three times in a row — a whole batch each time. It is not a component type
// (a section is a definition-level slot), but what the model means by it is a
// container, and a titled one is a card.

test('app_add_components: type "section" is read as a container, titled as a card', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { tempId: 'grp', type: 'section', children: [{ type: 'stat', props: { label: 'Total', value: 1 } }] },
            { tempId: 'ttl', type: 'section', props: { title: 'Summary' }, children: [{ type: 'stat', props: { label: 'VAT', value: 2 } }] },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(ops.findNode(wrap.def, r.ids.grp).node.type, 'container', 'a bare group is a container');
    const titled = ops.findNode(wrap.def, r.ids.ttl).node;
    assert.strictEqual(titled.type, 'card', 'a titled group is a card');
    assert.strictEqual(titled.props.title, 'Summary', 'and it keeps its title');
    assert.strictEqual(titled.children.length, 1, 'its children came along');
});

// ── Node fields that landed inside props ────────────────────────────
//
// Measured 2026-09-16 on a live "Candidate Dashboard" build: a list arrived as
// {props:{columns, source, look, style:{span:12}, type:"list"}} — valid JSON,
// one level too deep. The entry had no type, so it was refused as "the call's
// JSON is broken", which is both untrue and unfollowable; the model resent it
// unchanged three times and the build stopped. No component has a prop named
// type/style/children/tempId, so this nesting can be read.

test('app_add_components: type and style inside props are lifted out', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [{
            props: {
                columns: [{ key: 'candidate_name', label: 'Candidate Name' }],
                emptyText: 'No candidates found.',
                source: { kind: 'static', value: [] },
                style: { span: 12 },
                type: 'table',
            },
        }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const node = ops.findSection(wrap.def, parentId).section.children[0];
    assert.strictEqual(node.type, 'table', 'the type was read');
    assert.strictEqual(node.style.span, 12, 'and the style went where style goes');
    assert.ok(!('type' in node.props) && !('style' in node.props), 'neither stayed behind in props');
    assert.ok((r._hints || []).some((h) => /inside props — moved out/.test(h)), `the move is reported: ${JSON.stringify(r._hints)}`);
});

test('app_add_components: a tempId nested in props still resolves', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ props: { text: 'Hello', type: 'heading', tempId: 'hd' } }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r.ids.hd, 'the handle came out of props too');
    assert.strictEqual(ops.findNode(wrap.def, r.ids.hd).node.type, 'heading');
});

test('app_add_components: an entry-level value wins over one nested in props', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'x', type: 'heading', props: { text: 'Hi', type: 'text' } }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(ops.findNode(wrap.def, r.ids.x).node.type, 'heading', 'the entry said heading; props does not override it');
});

test('app_add_components: a real prop that merely looks structural is left alone', async () => {
    // filter_bar's fields carry their OWN `type` — nested one level down, not
    // a node field, and the lift must not reach into it.
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'fb', type: 'filter_bar', props: { fields: [{ name: 'status', label: 'Status', type: 'select' }] } }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const node = ops.findNode(wrap.def, r.ids.fb).node;
    assert.strictEqual(node.props.fields[0].type, 'select', 'the field keeps its own type');
});

// ── A group the model wrapped in a type-less entry ──────────────────
//
// The dominant defect in 12 measured dashboard builds (2026-09-16): the model
// groups components in `{children:[…]}` — no type, sometimes a parentId — and
// the whole batch was refused for "has no type". components[] is the group;
// the wrapper is lifted and the model is told.

test('app_add_components: a type-less {children} wrapper is lifted in place', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'page_header', props: { title: 'Invoices' } },
            // parentId beside children is the exact shape the live trace refused.
            { parentId: 'sec_c5b20l', children: [{ tempId: 'a', type: 'stat', props: { label: 'Total', value: 1 } }, { tempId: 'b', type: 'stat', props: { label: 'VAT', value: 2 } }] },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const types = ops.findSection(wrap.def, parentId).section.children.map((c) => c.type);
    assert.deepStrictEqual(types, ['page_header', 'stat', 'stat'], 'the wrapped components land as siblings');
    assert.ok(r.ids.a && r.ids.b, 'their tempIds still resolve');
    assert.ok((r._hints || []).some((h) => /no `type`/.test(h) && /lifted/.test(h)), `the lift is reported: ${JSON.stringify(r._hints)}`);
});

test('app_add_components: a wrapper nested inside a card is lifted too', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [{
            tempId: 'cd', type: 'card', props: { title: 'Summary' },
            children: [{ children: [{ type: 'stat', props: { label: 'Total', value: 1 } }, { children: [{ type: 'stat', props: { label: 'VAT', value: 2 } }] }] }],
        }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const card = ops.findNode(wrap.def, r.ids.cd).node;
    assert.deepStrictEqual(card.children.map((c) => c.type), ['stat', 'stat'], 'two levels of wrapper collapse into the card');
});

test('app_add_components: an entry with props but no type is still an error', async () => {
    // A component that LOST its type is a different mistake: lifting its
    // children would throw away the card it was meant to be.
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ props: { title: 'Summary' }, children: [{ type: 'stat', props: { label: 'Total', value: 1 } }] }],
    }, wrap);
    assert.ok(r.error && /type/i.test(r.error), `names the missing type: ${JSON.stringify(r)}`);
});

test('app_add_components: an empty wrapper is not treated as a group', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ children: [] }],
    }, wrap);
    assert.ok(r.error, 'nothing to lift, nothing to add');
});

// ── A page header renders where it was added ────────────────────────
//
// Components render in arrival order. A build that recovers from a failed
// batch adds them one at a time, and the header — usually the last thing the
// model gets back to — then sits at the BOTTOM of the page. Measured
// 2026-09-16 on a live dashboard build: six components added singly, title
// last, title at the bottom. The tool puts a leading page_header on top.

test('app_add_components: a page_header added after the rest is hoisted to the top', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    await applyToolCall('app_add_components', {
        parentId,
        components: [{ type: 'stat', props: { label: 'Total', value: 4 } }, { type: 'text', props: { text: 'body' } }],
    }, wrap);

    const r = await applyToolCall('app_add_components', {
        parentId,
        components: [{ tempId: 'hd', type: 'page_header', props: { title: 'Invoices' } }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));

    const children = ops.findSection(wrap.def, parentId).section.children;
    assert.strictEqual(children[0].type, 'page_header', `header first: ${children.map((c) => c.type).join(', ')}`);
    assert.deepStrictEqual(children.map((c) => c.type), ['page_header', 'stat', 'text'], 'the rest keeps its order');
    assert.ok((r._hints || []).some((h) => /page_header placed at the TOP/.test(h)), `the move is reported: ${JSON.stringify(r._hints)}`);
});

test('app_add_components: the whole batch moves with its header, in order', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    await applyToolCall('app_add_components', {
        parentId, components: [{ type: 'data_grid', props: { source: { kind: 'static', value: [] }, columns: [{ key: 'a', label: 'A' }] } }],
    }, wrap);

    await applyToolCall('app_add_components', {
        parentId,
        components: [
            { type: 'page_header', props: { title: 'Invoices' } },
            { type: 'stat', props: { label: 'Total', value: 1 } },
            { type: 'stat', props: { label: 'VAT', value: 2 } },
        ],
    }, wrap);

    const types = ops.findSection(wrap.def, parentId).section.children.map((c) => c.type);
    assert.deepStrictEqual(types, ['page_header', 'stat', 'stat', 'data_grid']);
});

test('app_add_components: an explicit index wins, and a second header is left alone', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    await applyToolCall('app_add_components', {
        parentId, components: [{ type: 'page_header', props: { title: 'Invoices' } }, { type: 'text', props: { text: 'body' } }],
    }, wrap);

    // A section that ALREADY has a header: a second one is the model's layout, not a slip.
    const second = await applyToolCall('app_add_components', {
        parentId, components: [{ type: 'page_header', props: { title: 'Archive' } }],
    }, wrap);
    assert.ok(!second.error, JSON.stringify(second));
    assert.ok(!(second._hints || []).some((h) => /placed at the TOP/.test(h)), 'no hoist reported');

    // And an explicit position is honoured as asked.
    const wrap2 = freshWrap();
    const p2 = homeSectionId(wrap2);
    await applyToolCall('app_add_components', { parentId: p2, components: [{ type: 'text', props: { text: 'a' } }, { type: 'text', props: { text: 'b' } }] }, wrap2);
    await applyToolCall('app_add_components', { parentId: p2, index: 1, components: [{ type: 'page_header', props: { title: 'Mid' } }] }, wrap2);
    const types2 = ops.findSection(wrap2.def, p2).section.children.map((c) => c.type);
    assert.deepStrictEqual(types2, ['text', 'page_header', 'text'], 'index 1 means index 1');

    const types = ops.findSection(wrap.def, parentId).section.children.map((c) => c.type);
    assert.deepStrictEqual(types, ['page_header', 'text', 'page_header'], 'the second header stays where it was sent');
});

test('app_add_components: a header into a card is the card\'s own layout', async () => {
    const wrap = freshWrap();
    const parentId = homeSectionId(wrap);
    const first = await applyToolCall('app_add_components', {
        parentId,
        components: [{ tempId: 'cd', type: 'card', props: { title: 'Summary' }, children: [{ type: 'text', props: { text: 'inside' } }] }],
    }, wrap);
    const cardId = first.ids.cd;

    const r = await applyToolCall('app_add_components', {
        parentId: cardId, components: [{ type: 'page_header', props: { title: 'Nope' } }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const card = ops.findNode(wrap.def, cardId).node;
    assert.deepStrictEqual(card.children.map((c) => c.type), ['text', 'page_header'], 'inside a container nothing is reordered');
});

test('app_update_component merges props/style and toggles visible', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'h', type: 'heading', props: { text: 'Old', level: 3 }, style: { span: 6 } }],
    }, wrap);
    const r = await applyToolCall('app_update_component', { id: ids.h, props: { text: 'New' }, style: { align: 'center' }, visible: false }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const node = ops.findNode(wrap.def, ids.h).node;
    assert.strictEqual(node.props.text, 'New');
    assert.strictEqual(node.props.level, 3, 'untouched prop survives the merge');
    assert.strictEqual(node.style.span, 6, 'untouched style knob survives the merge');
    assert.strictEqual(node.style.align, 'center');
    assert.strictEqual(node.visible, false);

    const bad = await applyToolCall('app_update_component', { id: 'cmp_zzzzzz', props: { text: 'x' } }, wrap);
    assert.ok(bad.error, 'unknown id rejected');
    const noop = await applyToolCall('app_update_component', { id: ids.h }, wrap);
    assert.ok(noop.error, 'patchless call rejected');
});

test('app_move_node reparents between sections; refuses moving into own subtree', async () => {
    const wrap = freshWrap();
    const screenId = wrap.def.screens[0].id;
    const secA = homeSectionId(wrap);
    const { sectionId: secB } = await applyToolCall('app_add_section', { screenId }, wrap);
    const { ids } = await applyToolCall('app_add_components', {
        parentId: secA,
        components: [{ tempId: 'card', type: 'card', children: [{ tempId: 'txt', type: 'text', props: { text: 'hi' } }] }],
    }, wrap);

    const r = await applyToolCall('app_move_node', { id: ids.txt, toParentId: secB }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(ops.findNode(wrap.def, ids.txt).parent.id, secB);

    const bad = await applyToolCall('app_move_node', { id: ids.card, toParentId: ids.card }, wrap);
    assert.ok(bad.error && /into itself/i.test(bad.error));
});

test('app_remove_node deletes a subtree; unknown id rejects', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'card', type: 'card', children: [{ tempId: 'txt', type: 'text', props: { text: 'hi' } }] }],
    }, wrap);
    const r = await applyToolCall('app_remove_node', { id: ids.card }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(ops.findNode(wrap.def, ids.card), null);
    assert.strictEqual(ops.findNode(wrap.def, ids.txt), null, 'children removed with the container');
    // A second removal is the outcome already there — a soft answer, so a
    // model deleting ids it invented does not loop (measured 2026-09-14).
    const again = await applyToolCall('app_remove_node', { id: ids.card }, wrap);
    assert.ok(!again.error, JSON.stringify(again));
    assert.strictEqual(again.alreadyAbsent, ids.card);
    assert.match(again.note, /is not in the app \(nothing to remove\)\. Components that exist:/);
    assert.ok((await applyToolCall('app_remove_node', {}, wrap)).error, 'no id at all still rejects');
});

// ── Actions ─────────────────────────────────────────────────────────

test('app_set_action creates, updates in place, and rejects unknown kinds', async () => {
    const wrap = freshWrap();
    const home = wrap.def.screens[0].id;
    const r = await applyToolCall('app_set_action', { action: { kind: 'navigate', screenId: home } }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r.actionId && wrap.def.actions[r.actionId], 'action stored under the returned id');
    assert.strictEqual(r.created, true);

    const upd = await applyToolCall('app_set_action', { actionId: r.actionId, action: { kind: 'toast', message: 'Hi' } }, wrap);
    assert.ok(!upd.error);
    assert.strictEqual(upd.actionId, r.actionId, 'in-place update keeps the id');
    assert.strictEqual(wrap.def.actions[r.actionId].kind, 'toast');

    const bad = await applyToolCall('app_set_action', { action: { kind: 'navigat', screenId: home } }, wrap);
    assert.ok(bad.error && bad.error.includes('navigate'), 'unknown kind rejected with a suggestion');

    const phantom = await applyToolCall('app_set_action', { actionId: 'act_ghost1', action: { kind: 'toast', message: 'x' } }, wrap);
    assert.ok(!phantom.error);
    assert.notStrictEqual(phantom.actionId, 'act_ghost1', 'non-existent actionId creates a NEW id');
    assert.ok((phantom._hints || []).some((h) => h.includes('act_ghost1')), 'hint explains the re-key');
});

test('app_bind_action wires events, validates support + resolution; app_remove_action unwires', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [
            { tempId: 'btn', type: 'button', props: { label: 'Go' } },
            { tempId: 'hd', type: 'heading', props: { text: 'T' } },
        ],
    }, wrap);
    const { actionId } = await applyToolCall('app_set_action', { action: { kind: 'toast', message: 'Hello' } }, wrap);

    const unknownAction = await applyToolCall('app_bind_action', { nodeId: ids.btn, event: 'onClick', actionId: 'act_zzzzzz' }, wrap);
    assert.ok(unknownAction.error && unknownAction._fixHint, 'unknown action rejected');

    const unsupported = await applyToolCall('app_bind_action', { nodeId: ids.hd, event: 'onClick', actionId }, wrap);
    assert.ok(unsupported.error && /does not support onClick/.test(unsupported.error));

    const r = await applyToolCall('app_bind_action', { nodeId: ids.btn, event: 'onClick', actionId }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(ops.findNode(wrap.def, ids.btn).node.onClick, actionId);

    const removed = await applyToolCall('app_remove_action', { actionId }, wrap);
    assert.ok(!removed.error);
    assert.strictEqual(ops.findNode(wrap.def, ids.btn).node.onClick, undefined, 'event unwired with the action');

    const clear = await applyToolCall('app_bind_action', { nodeId: ids.btn, event: 'onClick', actionId: null }, wrap);
    assert.ok(!clear.error, 'clearing an unwired event is a no-op success');
});

// ── Read-only tools ─────────────────────────────────────────────────

test('app_get_draft renders an ID-bearing tree', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'h', type: 'heading', props: { text: 'Hello' } }],
    }, wrap);
    const r = await applyToolCall('app_get_draft', {}, wrap);
    assert.ok(typeof r.draft === 'string');
    assert.ok(r.draft.includes(ids.h), 'component id appears in the rendering');
    assert.ok(r.draft.includes(wrap.def.screens[0].id), 'screen id appears');
});

test('app_list_automations lists the owner\'s automations with agent_call params', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_list_automations', {}, wrap);
    assert.ok(Array.isArray(r.automations));
    assert.strictEqual(r.automations.length, 2, 'only the owner\'s automations');
    const find = r.automations.find((a) => a.id === 'auto-1');
    assert.strictEqual(find.trigger, 'agent_call');
    assert.deepStrictEqual(find.params, ['query']);
    const digest = r.automations.find((a) => a.id === 'auto-2');
    assert.strictEqual(digest.trigger, 'schedule');
    assert.strictEqual(digest.isActive, false);
});

test('app_inspect_automation is owner-scoped and returns the parametersSchema', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_inspect_automation', { automationId: 'auto-1' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r.automation.parametersSchema.properties), ['query']);

    const notMine = await applyToolCall('app_inspect_automation', { automationId: 'auto-other' }, wrap);
    assert.ok(notMine.error, 'someone else\'s automation is invisible');
    const missing = await applyToolCall('app_inspect_automation', { automationId: 'auto-zzz' }, wrap);
    assert.ok(missing.error);
});

// ── persistDraft ────────────────────────────────────────────────────

test('persistDraft creates the row on first mutation (org backfilled), then CAS-updates', async () => {
    const wrap = freshWrap();
    await applyToolCall('app_set_meta', { name: 'Persist me' }, wrap);

    const first = await persistDraft(wrap);
    assert.ok(first.ok, JSON.stringify(first));
    assert.ok(first.created);
    assert.ok(wrap.appId, 'appId adopted');
    assert.strictEqual(wrap.version, 1);
    const row = await mockStudioAppStore.getStudioApp(wrap.appId);
    assert.strictEqual(row.name, 'Persist me', 'row name comes from meta');
    assert.strictEqual(row.organizationId, 'org-backfilled', 'org resolved from the user record');

    await applyToolCall('app_set_meta', { description: 'Updated.' }, wrap);
    const second = await persistDraft(wrap);
    assert.ok(second.ok, JSON.stringify(second));
    assert.strictEqual(second.version, 2);
    assert.strictEqual(wrap.version, 2);
    const row2 = await mockStudioAppStore.getStudioApp(wrap.appId);
    assert.strictEqual(row2.definition.meta.description, 'Updated.');
    assert.strictEqual(row2.description, 'Updated.', 'card meta stays in sync');
});

test('persistDraft: one conflict is retried and adopted; persistent conflict errors', async () => {
    const wrap = freshWrap();
    await applyToolCall('app_set_meta', { name: 'Conflict app' }, wrap);
    await persistDraft(wrap);

    state.conflictOnce = true;
    await applyToolCall('app_set_meta', { description: 'v2' }, wrap);
    const retried = await persistDraft(wrap);
    assert.ok(retried.ok, `retry after one conflict succeeds: ${JSON.stringify(retried)}`);
    const row = await mockStudioAppStore.getStudioApp(wrap.appId);
    assert.strictEqual(row.definition.meta.description, 'v2', 'builder def won the retry');
    assert.strictEqual(wrap.version, row.definitionVersion, 'adopted the server version');

    state.conflictAlways = true;
    const stuck = await persistDraft(wrap);
    state.conflictAlways = false;
    assert.ok(stuck.error && /close other/i.test(stuck.error), 'persistent conflict surfaces the close-other-tabs error');
});

test('persistDraft maps definition_too_large to a friendly error result', async () => {
    const wrap = freshWrap();
    await applyToolCall('app_set_meta', { name: 'Huge app' }, wrap);
    await persistDraft(wrap);
    state.tooLarge = true;
    const r = await persistDraft(wrap);
    state.tooLarge = false;
    assert.ok(r.error && /size|byte/i.test(r.error));
});

// ── Finalize ────────────────────────────────────────────────────────

test('app_finalize is blocked while invalid, succeeds after the fix', async () => {
    const wrap = freshWrap();
    // A navigate to a screen that does not exist is refused at TOOL time now
    // (the validator's own rule, one round earlier) …
    const refused = await applyToolCall('app_set_action', { action: { kind: 'navigate', screenId: 'scr_nothere' } }, wrap);
    assert.match(refused.error, /This action would fail validation — nothing was created/);
    assert.match(refused.error, /scr_nothere/);
    assert.deepStrictEqual(Object.keys(wrap.def.actions || {}), [], 'nothing minted');
    // … so land the invalid action behind the tool's back to test finalize.
    const { actionId } = (() => {
        const ops2 = require('./definitionOps');
        const r = ops2.setAction(wrap.def, null, { kind: 'navigate', screenId: 'scr_nothere' });
        wrap.def = r.def;
        return r;
    })();
    const blocked = await applyToolCall('app_finalize', {}, wrap);
    assert.ok(blocked.error && /cannot finalize/i.test(blocked.error));
    assert.ok(Array.isArray(blocked.validation.errors) && blocked.validation.errors.length > 0);
    assert.ok(!wrap.finalized);
    assert.strictEqual(wrap.appId, null, 'blocked finalize does not persist');

    await applyToolCall('app_remove_action', { actionId }, wrap);
    const ok = await applyToolCall('app_finalize', {}, wrap);
    assert.ok(ok.finalized, JSON.stringify(ok));
    assert.ok(wrap.appId, 'finalize persisted the app');
    assert.ok(wrap.finalized);
    const row = await mockStudioAppStore.getStudioApp(wrap.appId);
    assert.strictEqual(validateAppDefinition(row.definition).ok, true, 'persisted definition validates');
});

// ── The naming net (2026-09-17) ─────────────────────────────────────
//
// A model that skips app_set_meta finalizes an "Untitled app"; the row, the
// card and the usage log then all say so. applyFinalize names the draft from
// the brief the route stored on the wrap, and says so in _hints.

test('app_finalize names an Untitled draft from draftWrap._turnMessage and says so in _hints; a named draft is untouched', async () => {
    const wrap = freshWrap();
    wrap.def = emptyDefinition();
    wrap._turnMessage = 'Build a professional invoice tracker for my team that lists all invoices.';
    assert.strictEqual(wrap.def.meta.name, 'Untitled app');
    const ok = await applyToolCall('app_finalize', {}, wrap);
    assert.ok(ok.finalized, JSON.stringify(ok));
    assert.strictEqual(ok.name, 'Invoice tracker');
    assert.strictEqual(wrap.def.meta.name, 'Invoice tracker');
    assert.ok(ok._hints.some((h) => h === 'The app was still "Untitled app" — named "Invoice tracker" from your brief; call app_set_meta to change it.'), JSON.stringify(ok._hints));
    // The row was created under the derived name, not "Untitled app".
    const row = await mockStudioAppStore.getStudioApp(wrap.appId);
    assert.strictEqual(row.name, 'Invoice tracker');
    // A draft the model named itself: no hint, nothing changed.
    const named = freshWrap();
    await applyToolCall('app_set_meta', { name: 'Facturen' }, named);
    named._turnMessage = 'App name "Something else"';
    const ok2 = await applyToolCall('app_finalize', {}, named);
    assert.ok(ok2.finalized, JSON.stringify(ok2));
    assert.strictEqual(ok2.name, 'Facturen');
    assert.ok(!(ok2._hints || []).some((h) => /was still "Untitled app"/.test(h)));
    // Nothing derivable: stays Untitled, no hint about naming.
    const bare = freshWrap();
    bare.def = emptyDefinition();
    bare._turnMessage = '';
    const ok3 = await applyToolCall('app_finalize', {}, bare);
    assert.ok(ok3.finalized, JSON.stringify(ok3));
    assert.strictEqual(ok3.name, 'Untitled app');
    assert.ok(!(ok3._hints || []).some((h) => /was still "Untitled app"/.test(h)));
});

test('app_finalize blocks a run_automation wired to an automation the owner does not have', async () => {
    const wrap = freshWrap();
    await applyToolCall('app_set_action', { action: { kind: 'run_automation', automationId: 'auto-not-owned' } }, wrap);
    const blocked = await applyToolCall('app_finalize', {}, wrap);
    assert.ok(blocked.error, 'finalize rejected');
    assert.ok(blocked.validation.errors.some((e) => e.code === 'action.automation_missing'), JSON.stringify(blocked.validation.errors));

    // An automation the owner DOES have — fine, even while inactive (draft-level
    // finalize only blocks on missing automations; publish gates activity).
    const fixed = await applyToolCall('app_set_action', {
        actionId: Object.keys(wrap.def.actions)[0],
        action: { kind: 'run_automation', automationId: 'auto-2' },
    }, wrap);
    assert.ok(!fixed.error);
    const ok = await applyToolCall('app_finalize', {}, wrap);
    assert.ok(ok.finalized, JSON.stringify(ok));
});

// ── Wave 2A: node logic pass-through + data-aware finalize ──────────

test('app_add_components passes visibleWhen/enabledWhen/visibleToRoles through to nodes', async () => {
    const wrap = freshWrap();
    wrap.def.roles = [{ id: 'admin', name: 'Admin' }];
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{
            tempId: 'h', type: 'heading', props: { text: 'Gated' },
            visibleWhen: "vars.show == true",
            enabledWhen: { kind: 'formula', expr: 'currentUser.id != null' },
            visibleToRoles: ['admin'],
        }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const node = ops.findNode(wrap.def, r.ids.h).node;
    assert.deepStrictEqual(node.visibleWhen, { kind: 'formula', expr: 'vars.show == true' }, 'string expr wrapped as formula');
    assert.deepStrictEqual(node.enabledWhen, { kind: 'formula', expr: 'currentUser.id != null' }, 'formula object kept');
    assert.deepStrictEqual(node.visibleToRoles, ['admin']);
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true, 'logic fields survive canonicalize + validate');

    const bad = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ type: 'heading', props: { text: 'x' }, visibleToRoles: 'admin' }],
    }, wrap);
    assert.ok(bad.error && /visibleToRoles/.test(bad.error), 'bad shape rejects the batch');
});

test('app_update_component sets and clears the logic fields in place', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'b', type: 'button', props: { label: 'Go' } }],
    }, wrap);

    const set = await applyToolCall('app_update_component', { id: ids.b, visibleWhen: "form.name != ''", enabledWhen: false }, wrap);
    assert.ok(!set.error, JSON.stringify(set));
    let node = ops.findNode(wrap.def, ids.b).node;
    assert.deepStrictEqual(node.visibleWhen, { kind: 'formula', expr: "form.name != ''" });
    assert.strictEqual(node.enabledWhen, false, 'boolean accepted');
    assert.strictEqual(node.props.label, 'Go', 'props untouched');

    const clear = await applyToolCall('app_update_component', { id: ids.b, visibleWhen: null }, wrap);
    assert.ok(!clear.error, JSON.stringify(clear));
    node = ops.findNode(wrap.def, ids.b).node;
    assert.strictEqual(node.visibleWhen, undefined, 'null clears the field');
    assert.strictEqual(node.enabledWhen, false, 'other logic field survives');

    const bad = await applyToolCall('app_update_component', { id: ids.b, enabledWhen: 42 }, wrap);
    assert.ok(bad.error && /enabledWhen/.test(bad.error));
});

test('app_finalize cross-checks data references when the route loaded a data model', async () => {
    const wrap = freshWrap();
    wrap.dataModel = {
        modelVersion: 1,
        tables: [{
            id: 'tbl_task01', key: 'tasks', name: 'Tasks',
            fields: [{ id: 'fld_t1', key: 'title', type: 'text', required: true, unique: false }],
            access: { default: 'app', roles: {}, rowFilters: {} },
        }],
        roles: [], roleMapping: { default: 'app', byGroup: {} },
    };
    wrap.datasetIds = [];

    // With the model loaded, a binding to a table the app does not have is
    // refused at ADD time (bindingGuard) — one round earlier than finalize.
    const refused = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_ghost' } } }],
    }, wrap);
    assert.match(refused.error, /names table "tbl_ghost", which this app does not have/);
    assert.strictEqual(refused.failedIndex, 0);
    // Finalize still cross-checks: land the dangling binding while the model
    // is not known this turn (the guard has no opinion then), then check.
    const model = wrap.dataModel;
    wrap.dataModel = undefined;
    await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_ghost' } } }],
    }, wrap);
    wrap.dataModel = model;
    const blocked = await applyToolCall('app_finalize', {}, wrap);
    assert.ok(blocked.error, 'dangling table blocks finalize');
    assert.ok(blocked.validation.errors.some((e) => e.code === 'binding.unknown_table'), JSON.stringify(blocked.validation.errors));

    // Point the binding at the real table (+ a formula-valued filter) → clean.
    const gridId = ops.collectIds(wrap.def);
    const grid = [...gridId].find((x) => x.startsWith('cmp_'));
    const fixed = await applyToolCall('app_update_component', {
        id: grid,
        props: { source: { kind: 'records', tableId: 'tbl_task01', filter: [{ field: 'created_by', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }] } },
    }, wrap);
    assert.ok(!fixed.error, JSON.stringify(fixed));
    const ok = await applyToolCall('app_finalize', {}, wrap);
    assert.ok(ok.finalized, JSON.stringify(ok));
});

test('app_finalize skips data checks when no data model was loaded (dataModel undefined)', async () => {
    const wrap = freshWrap(); // no wrap.dataModel
    await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_ghost' } } }],
    }, wrap);
    const ok = await applyToolCall('app_finalize', {}, wrap);
    assert.ok(ok.finalized, JSON.stringify(ok));
});

// ── Wave 3A: data-engine tools ──────────────────────────────────────

const { DATA_LIMITS } = require('./dataModel');

function resetDataState() {
    dataState.metaByApp.clear();
    dataState.rowCounts = {};
    dataState.datasets.clear();
    dataState.nextDataset = 0;
    dataState.conflictOnce = false;
    dataState.conflictAlways = false;
    dataState.saveCalls.length = 0;
    dataState.execCalls.length = 0;
    dataState.queryRows = [];
    dataState.dbSize = 0;
}

/** A wrap that already loaded the (empty) data side, like the route does. */
function dataWrap() {
    const wrap = freshWrap();
    wrap.dataModel = null;
    wrap.dataModelVersion = 0;
    wrap.rowCounts = {};
    wrap.datasetIds = [];
    return wrap;
}

async function upsertTasksTable(wrap, extra = {}) {
    return applyToolCall('app_upsert_table', {
        key: 'tasks', name: 'Tasks',
        fields: [
            { key: 'title', type: 'text', required: true },
            { key: 'status', type: 'select', options: ['todo', 'done'] },
        ],
        ...extra,
    }, wrap);
}

test('app_upsert_table creates a table (app row auto-created), mints stable ids and adopts the model', async () => {
    resetDataState();
    const wrap = dataWrap();
    const r = await upsertTasksTable(wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(wrap.appId, 'first data mutation created the studio_apps row');
    assert.match(r.tableId, /^tbl_[a-z0-9]{6}$/);
    assert.strictEqual(r.key, 'tasks');
    assert.strictEqual(r.fields.length, 2);
    assert.ok(r.fields.every((f) => /^fld_[a-z0-9]{6}$/.test(f.fieldId)));
    assert.strictEqual(r.modelVersion, 1);
    assert.strictEqual(wrap.dataModelVersion, 1, 'version adopted onto the wrap');
    assert.strictEqual(wrap.dataModel.tables.length, 1, 'model adopted onto the wrap');
    assert.ok(/CREATE TABLE/.test(r.migration), `migration summary: ${r.migration}`);
    const saved = dataState.metaByApp.get(wrap.appId);
    assert.ok(saved && saved.model.tables[0].key === 'tasks', 'model persisted through the CAS store');
});

test('app_upsert_table derives the table key and field keys from names when omitted; a field without type is still refused', async () => {
    // Measured 2026-09-13: the prompt teaches {name, fields}; the fast local
    // model never adds a `key` it was not shown, and "key is required" cost a
    // round for a value the server can spell itself.
    resetDataState();
    const wrap = dataWrap();
    const r = await applyToolCall('app_upsert_table', {
        name: 'Suppliers',
        fields: [
            { name: 'Company', type: 'text', required: true },
            { label: 'Contact Email', type: 'text' },
            { key: 'category', name: 'Category', type: 'select', options: ['hardware', 'software'] },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.key, 'suppliers');
    assert.deepStrictEqual(r.fields.map((f) => f.key), ['company', 'contact_email', 'category']);
    const table = wrap.dataModel.tables[0];
    assert.strictEqual(table.fields[1].name, 'Contact Email', 'label read as name');
    assert.ok(r._hints.some((h) => /key derived from name: "Suppliers" → suppliers/.test(h)), JSON.stringify(r._hints));
    assert.ok(r._hints.some((h) => /field keys derived from names: "Company" → company, "Contact Email" → contact_email/.test(h)), JSON.stringify(r._hints));

    // A second table named the same gets a distinct key rather than a collision.
    const again = await applyToolCall('app_upsert_table', { name: 'Suppliers', fields: [{ key: 'x', type: 'text' }] }, wrap);
    assert.ok(!again.error, JSON.stringify(again));
    assert.strictEqual(again.key, 'suppliers_2');

    // No name, no key → still the honest refusal; a field without a type is never guessed.
    const noKey = await applyToolCall('app_upsert_table', { fields: [{ key: 'x', type: 'text' }] }, wrap);
    assert.match(noKey.error, /key is required when creating a table/);
    const noType = await applyToolCall('app_upsert_table', { name: 'Invoices', fields: [{ name: 'Amount' }] }, wrap);
    assert.match(noType.error, /fields\[0\]\.type undefined is not a field type/);
});

test('app_upsert_table keeps a computed field STORED — an unrelated edit must not downgrade it', async () => {
    resetDataState();
    const wrap = dataWrap();
    // A stored computed column is a real column: it can be filtered, sorted
    // and aggregated on. A read-time one cannot. The difference decides
    // whether a "how many need attention" stat works or errors out.
    const made = await applyToolCall('app_upsert_table', {
        key: 'lines', name: 'Lines',
        fields: [
            { key: 'title', type: 'text' },
            { key: 'note', type: 'text' },
            { key: 'check', type: 'computed', computed: { type: 'text', stored: true, expr: "CASE WHEN note IS NULL THEN 'todo' ELSE 'ok' END" } },
        ],
    }, wrap);
    assert.ok(!made.error, JSON.stringify(made));
    const stored = () => dataState.metaByApp.get(wrap.appId).model.tables[0].fields.find((f) => f.key === 'check');
    assert.strictEqual(stored().computed.stored, true, 'the tool can author a stored computed column at all');

    // Now edit a DIFFERENT field and re-send the list without saying anything
    // about `stored` — the shape a round-trip through app_get_data_model
    // produces. Silence must not mean "downgrade".
    const evolved = await applyToolCall('app_upsert_table', {
        tableId: made.tableId,
        fields: [
            { key: 'title', type: 'text', required: false, name: 'Title' },
            { key: 'note', type: 'text' },
            { key: 'check', type: 'computed', computed: { type: 'text', expr: "CASE WHEN note IS NULL THEN 'todo' ELSE 'ok' END" } },
        ],
    }, wrap);
    assert.ok(!evolved.error, JSON.stringify(evolved));
    assert.strictEqual(stored().computed.stored, true, 'stored survived an edit that never mentioned it');

    // …and an explicit false is still obeyed: inheritance is a default, not a lock.
    const down = await applyToolCall('app_upsert_table', {
        tableId: made.tableId,
        fields: [
            { key: 'title', type: 'text' },
            { key: 'note', type: 'text' },
            { key: 'check', type: 'computed', computed: { type: 'text', stored: false, expr: "CASE WHEN note IS NULL THEN 'todo' ELSE 'ok' END" } },
        ],
    }, wrap);
    assert.ok(!down.error, JSON.stringify(down));
    assert.ok(!stored().computed.stored, 'an explicit stored:false downgrades on purpose');
});
test('app_upsert_table evolves in place: same-key fields keep ids, omitted fields drop with a hint, type change rejects', async () => {
    resetDataState();
    const wrap = dataWrap();
    const first = await upsertTasksTable(wrap);
    const titleId = first.fields.find((f) => f.key === 'title').fieldId;

    // Evolve: keep title (by key), drop status, add priority.
    const r = await applyToolCall('app_upsert_table', {
        tableId: first.tableId,
        fields: [
            { key: 'title', type: 'text', required: true },
            { key: 'priority', type: 'number' },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.tableId, first.tableId, 'table id is stable');
    assert.strictEqual(r.fields.find((f) => f.key === 'title').fieldId, titleId, 'same key keeps the field id (rename-proof)');
    assert.ok(!r.fields.some((f) => f.key === 'status'), 'omitted field dropped');
    assert.ok((r._hints || []).some((h) => /dropped field/i.test(h) && h.includes('status')), `drop hint present: ${JSON.stringify(r._hints)}`);
    assert.strictEqual(r.modelVersion, 2);

    // Type conversion is a DDL-v1 limit — reject with a teaching hint.
    const bad = await applyToolCall('app_upsert_table', {
        tableId: first.tableId,
        fields: [
            { key: 'title', type: 'number' },
            { key: 'priority', type: 'number' },
        ],
    }, wrap);
    assert.ok(bad.error && /cannot convert/i.test(bad.error), JSON.stringify(bad));
    assert.ok(bad._fixHint && /new field/i.test(bad._fixHint));

    // Unknown tableId rejects with suggestions.
    const ghost = await applyToolCall('app_upsert_table', { tableId: 'tbl_ghost1', fields: [{ key: 'x', type: 'text' }] }, wrap);
    assert.ok(ghost.error && /unknown tableid/i.test(ghost.error));
});

test('app_upsert_table: relations must point at existing tables; parent-first flow works', async () => {
    resetDataState();
    const wrap = dataWrap();
    const dangling = await applyToolCall('app_upsert_table', {
        key: 'tasks', fields: [{ key: 'owner', type: 'relation', relation: { tableId: 'tbl_nothere' } }],
    }, wrap);
    assert.ok(dangling.error && /unknown table/i.test(dangling.error));
    assert.ok(dangling._fixHint && /parent table first/i.test(dangling._fixHint));

    const people = await applyToolCall('app_upsert_table', { key: 'people', fields: [{ key: 'name', type: 'text' }] }, wrap);
    assert.ok(!people.error, JSON.stringify(people));
    const tasks = await applyToolCall('app_upsert_table', {
        key: 'tasks',
        fields: [
            { key: 'title', type: 'text' },
            { key: 'owner', type: 'relation', relation: { tableId: people.tableId, displayFieldKey: 'name' } },
        ],
    }, wrap);
    assert.ok(!tasks.error, JSON.stringify(tasks));
    const saved = wrap.dataModel.tables.find((t) => t.id === tasks.tableId);
    const rel = saved.fields.find((f) => f.key === 'owner');
    assert.strictEqual(rel.relation.table, people.tableId, 'tool arg tableId mapped to the model\'s relation.table');
    assert.strictEqual(rel.relation.displayField, 'name');
});

test('app_upsert_table: system-column keys and bad keys reject; select without options rejects', async () => {
    resetDataState();
    const wrap = dataWrap();
    const sys = await applyToolCall('app_upsert_table', { key: 'tasks', fields: [{ key: 'created_by', type: 'text' }] }, wrap);
    assert.ok(sys.error && /system column/i.test(sys.error));
    const badKey = await applyToolCall('app_upsert_table', { key: 'Tasks!', fields: [{ key: 'a', type: 'text' }] }, wrap);
    assert.ok(badKey.error && /snake_case/i.test(badKey.error));
    const noOpts = await applyToolCall('app_upsert_table', { key: 'tasks', fields: [{ key: 's', type: 'select' }] }, wrap);
    assert.ok(noOpts.error && /options/i.test(noOpts.error));
});

test('app_upsert_table reads a string `default` by the field type — "false" on a bool is false, never DEFAULT TRUE', async () => {
    // The schema types `default` as a string, so a model that follows it
    // writes "false"; stored verbatim, the DDL's truthiness read rendered it
    // as DEFAULT TRUE (caught in review 2026-09-18).
    resetDataState();
    const wrap = dataWrap();
    const r = await applyToolCall('app_upsert_table', {
        key: 'tasks', name: 'Tasks',
        fields: [
            { key: 'done', type: 'bool', required: true, default: 'false' },
            { key: 'flag', type: 'bool', default: '1' },
            { key: 'priority', type: 'number', default: '3' },
            { key: 'due', type: 'date', default: '2026-01-01' },
            { key: 'note', type: 'text', default: 'none' },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const fields = Object.fromEntries(wrap.dataModel.tables[0].fields.map((f) => [f.key, f]));
    assert.strictEqual(fields.done.default, false);
    assert.strictEqual(fields.flag.default, true);
    assert.strictEqual(fields.priority.default, 3);
    assert.strictEqual(fields.due.default, '2026-01-01', 'a date keeps the string');
    assert.strictEqual(fields.note.default, 'none');
    const { columnDef } = require('../core/dataEngine/dataModel/ddl');
    assert.match(columnDef(fields.done, {}, 'pg'), /NOT NULL DEFAULT FALSE$/);
    assert.match(columnDef(fields.done, {}, 'sqlite'), /NOT NULL DEFAULT 0$/);
    assert.match(columnDef(fields.priority, {}, 'pg'), /DEFAULT 3$/);
    // What cannot be read is refused, not stored.
    const badBool = await applyToolCall('app_upsert_table', { tableId: r.tableId, fields: [{ key: 'done', type: 'bool', default: 'maybe' }] }, wrap);
    assert.match(String(badBool.error), /fields\[0\]\.default "maybe" is not a boolean/);
    const badNum = await applyToolCall('app_upsert_table', { tableId: r.tableId, fields: [{ key: 'priority', type: 'number', default: 'high' }] }, wrap);
    assert.match(String(badNum.error), /fields\[0\]\.default "high" is not a number/);
});

test('app_upsert_table holds access.rowFilters to the SAME gate as the human schema save', async () => {
    resetDataState();
    const wrap = dataWrap();
    const outsideSubset = 'upper(record.title) == "x"'; // a function call — not translatable
    const { validateRowFilter } = require('./rlsGateway');
    assert.strictEqual(
        validateRowFilter(outsideSubset, { fields: [{ key: 'title', type: 'text' }] }).ok, false,
        'the human PUT /:id/schema gate rejects this filter',
    );

    const bad = await upsertTasksTable(wrap, {
        access: { default: 'role', roles: { staff: { read: 'all' } }, rowFilters: { staff: outsideSubset } },
    });
    assert.ok(bad.error && /rowFilters/.test(bad.error), JSON.stringify(bad));
    assert.ok((bad.errors || []).some((e) => /staff/.test(e)), JSON.stringify(bad.errors));
    assert.strictEqual(dataState.saveCalls.length, 0, 'the AI-authored filter never reached the store');
    assert.strictEqual(wrap.dataModel, null, 'model untouched');

    // An expressible filter still lands.
    const good = await upsertTasksTable(wrap, {
        access: { default: 'role', roles: { staff: { read: 'all' } }, rowFilters: { staff: 'record.title == viewer.name' } },
    });
    assert.ok(!good.error, JSON.stringify(good));
    assert.strictEqual(wrap.dataModel.tables[0].access.rowFilters.staff, 'record.title == viewer.name');
});

test('persistDataModel rebases ONCE on a CAS conflict (concurrent table survives); persistent conflict errors clean', async () => {
    resetDataState();
    const wrap = dataWrap();
    await upsertTasksTable(wrap);

    // A concurrent tab added another table server-side (version bumped to 2).
    const serverModel = clone(dataState.metaByApp.get(wrap.appId).model);
    serverModel.tables.push({
        id: 'tbl_other1', key: 'other', name: 'Other', icon: null,
        fields: [{ id: 'fld_oth001', key: 'label', type: 'text', required: false, unique: false, name: 'label' }],
        access: { default: 'app', roles: {}, rowFilters: {} },
    });
    dataState.metaByApp.set(wrap.appId, { model: serverModel, version: 2 });
    // wrap still believes version 1 → first save conflicts → rebase → retry.
    const r = await applyToolCall('app_upsert_table', {
        tableId: wrap.dataModel.tables[0].id,
        fields: [
            { key: 'title', type: 'text', required: true },
            { key: 'status', type: 'select', options: ['todo', 'done'] },
            { key: 'due', type: 'date' },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(wrap.dataModelVersion, 3, 'adopted the post-rebase version');
    const keys = wrap.dataModel.tables.map((t) => t.key).sort();
    assert.deepStrictEqual(keys, ['other', 'tasks'], 'the concurrent tab\'s table SURVIVED the rebase');
    assert.ok(wrap.dataModel.tables.find((t) => t.key === 'tasks').fields.some((f) => f.key === 'due'), 'our evolution landed too');

    dataState.conflictAlways = true;
    const stuck = await applyToolCall('app_upsert_table', {
        tableId: r.tableId, fields: [{ key: 'title', type: 'text' }],
    }, wrap);
    dataState.conflictAlways = false;
    assert.ok(stuck.error && /another tab/i.test(stuck.error), `clean conflict error: ${JSON.stringify(stuck)}`);
});

test('app_remove_table refuses while the definition references it, removes cleanly after', async () => {
    resetDataState();
    const wrap = dataWrap();
    const { tableId } = await upsertTasksTable(wrap);

    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'grid', type: 'data_grid', props: { source: { kind: 'records', tableId } } }],
    }, wrap);
    const { actionId } = await applyToolCall('app_set_action', {
        action: { kind: 'sequence', steps: [{ kind: 'create_record', tableId, values: { title: { kind: 'static', value: 'x' } } }] },
    }, wrap);

    const refused = await applyToolCall('app_remove_table', { tableId }, wrap);
    assert.ok(refused.error && /still references/i.test(refused.error), JSON.stringify(refused));
    assert.ok(refused.error.includes(`component ${ids.grid}`), 'names the referencing component');
    assert.ok(refused.error.includes(`action ${actionId}`), 'names the referencing action');
    assert.ok(wrap.dataModel.tables.length === 1, 'nothing removed');

    await applyToolCall('app_remove_node', { id: ids.grid }, wrap);
    await applyToolCall('app_remove_action', { actionId }, wrap);
    const removed = await applyToolCall('app_remove_table', { tableId }, wrap);
    assert.ok(!removed.error, JSON.stringify(removed));
    assert.strictEqual(removed.removed, tableId);
    assert.strictEqual(wrap.dataModel.tables.length, 0);
    assert.strictEqual(dataState.metaByApp.get(wrap.appId).model.tables.length, 0, 'persisted');
});

test('app_set_roles writes the data model AND mirrors definition.roles in lockstep', async () => {
    resetDataState();
    const wrap = dataWrap();
    const r = await applyToolCall('app_set_roles', {
        roles: [{ key: 'manager', label: 'Manager' }, { key: 'agent' }],
        roleMapping: { default: 'agent', byGroup: { Sales: 'manager' } },
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.roles, ['manager', 'agent']);
    assert.deepStrictEqual(wrap.dataModel.roles, [{ key: 'manager', label: 'Manager' }, { key: 'agent', label: 'agent' }]);
    assert.deepStrictEqual(wrap.dataModel.roleMapping, { default: 'agent', byGroup: { Sales: 'manager' } });
    assert.deepStrictEqual(wrap.def.roles, [{ id: 'manager', name: 'Manager' }, { id: 'agent', name: 'agent' }], 'definition mirror');
    const persisted = dataState.metaByApp.get(wrap.appId).model;
    assert.strictEqual(persisted.roles.length, 2, 'model persisted through the store');

    const badDefault = await applyToolCall('app_set_roles', {
        roles: [{ key: 'viewer' }], roleMapping: { default: 'ghost' },
    }, wrap);
    assert.ok(badDefault.error && /roleMapping.default/.test(badDefault.error));
    const badKey = await applyToolCall('app_set_roles', { roles: [{ key: 'Not Valid' }] }, wrap);
    assert.ok(badKey.error && /snake_case/i.test(badKey.error));
});

test('app_seed_records inserts through the REAL writeRecord (RLS + quotas), returns rec_ ids, bumps counts', async () => {
    resetDataState();
    const wrap = dataWrap();
    const { tableId } = await upsertTasksTable(wrap);

    const r = await applyToolCall('app_seed_records', {
        tableId,
        records: [
            { title: 'Fix login bug', status: 'todo' },
            { title: 'Ship v2', status: 'done' },
            { title: 'Write docs' },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.inserted, 3);
    assert.strictEqual(r.ids.length, 3);
    assert.ok(r.ids.every((id) => id.startsWith('rec_')), 'real record ids returned for relation seeding');
    assert.strictEqual(r.rowCount, 3);
    assert.strictEqual(wrap.rowCounts[tableId], 3, 'draft rowCounts bumped (id-keyed)');
    const inserts = dataState.execCalls.filter((c) => /INSERT INTO "tasks"/.test(c.sql));
    assert.strictEqual(inserts.length, 3, 'every row went through the SQL choke point');
    assert.strictEqual(inserts[0].ownerId, 'u1', 'writes run as the app owner');
    assert.ok(inserts[0].params.includes('u1'), 'created_by stamped with the owner id');

    const badRows = await applyToolCall('app_seed_records', {
        tableId,
        records: [{ title: 'ok row' }, { nope_field: 'x' }],
    }, wrap);
    assert.ok(!badRows.error, 'partial success is not a tool error');
    assert.strictEqual(badRows.inserted, 1);
    assert.strictEqual(badRows.failed.length, 1);
    assert.strictEqual(badRows.failed[0].index, 1);
    assert.match(badRows.failed[0].error, /nope_field|unknown/i);

    const tooMany = await applyToolCall('app_seed_records', {
        tableId, records: Array.from({ length: 26 }, (_, i) => ({ title: `t${i}` })),
    }, wrap);
    assert.ok(tooMany.error && /max 25/i.test(tooMany.error));
});

test('app_seed_records surfaces a per-row quota_exceeded 409 without throwing', async () => {
    resetDataState();
    const wrap = dataWrap();
    const { tableId } = await upsertTasksTable(wrap);
    // One row of headroom under the per-table cap: row 1 inserts, row 2 409s.
    dataState.rowCounts.tasks = DATA_LIMITS.MAX_ROWS_PER_TABLE - 1;

    const r = await applyToolCall('app_seed_records', {
        tableId,
        records: [{ title: 'fits' }, { title: 'quota' }, { title: 'skipped' }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.inserted, 1);
    assert.ok(r.failed.some((f) => f.code === 'quota_exceeded'), JSON.stringify(r.failed));
    assert.ok(r.failed.some((f) => /skipped after the quota error/i.test(f.error)), 'remaining rows reported as skipped');
});

test('app_upsert_dataset persists, runs once and returns a grounded preview; bad descriptor self-repairs', async () => {
    resetDataState();
    const wrap = dataWrap();
    const { tableId } = await upsertTasksTable(wrap);
    dataState.queryRows = [{ status: 'todo', n: 2 }, { status: 'done', n: 1 }];

    const r = await applyToolCall('app_upsert_dataset', {
        name: 'By status', tableId,
        descriptor: { groupBy: [{ field: 'status' }], aggregates: [{ fn: 'count', as: 'n' }] },
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r.datasetId, 'dataset id returned');
    assert.strictEqual(r.rowCount, 2);
    assert.deepStrictEqual(r.preview[0], { status: 'todo', n: 2 }, 'preview grounds the model');
    assert.deepStrictEqual(wrap.datasetIds, [{ id: r.datasetId, name: 'By status' }], 'draft dataset list adopted');
    const aggregate = dataState.execCalls.find((c) => c.read && /GROUP BY/i.test(c.sql));
    assert.ok(aggregate, 'the descriptor compiled through the real queryCompiler');

    // Update in place.
    dataState.queryRows = [{ status: 'todo', n: 5 }];
    const upd = await applyToolCall('app_upsert_dataset', {
        datasetId: r.datasetId, tableId,
        descriptor: { groupBy: [{ field: 'status' }], aggregates: [{ fn: 'count', as: 'n' }], filters: [{ field: 'status', op: 'eq', value: 'todo' }] },
    }, wrap);
    assert.ok(!upd.error, JSON.stringify(upd));
    assert.strictEqual(upd.datasetId, r.datasetId);
    assert.strictEqual(wrap.datasetIds.length, 1, 'update does not duplicate the entry');

    // A descriptor over a nonexistent field fails the implicit dry-run; a
    // CREATED dataset is rolled back.
    const before = dataState.datasets.size;
    const bad = await applyToolCall('app_upsert_dataset', {
        name: 'Broken', tableId,
        descriptor: { groupBy: [{ field: 'ghost_field' }], aggregates: [{ fn: 'count', as: 'n' }] },
    }, wrap);
    assert.ok(bad.error && /did not compile/i.test(bad.error), JSON.stringify(bad));
    assert.ok(bad._fixHint && bad._fixHint.includes('title'), 'hint lists the real field keys');
    assert.strictEqual(dataState.datasets.size, before, 'failed create rolled back');

    const noAgg = await applyToolCall('app_upsert_dataset', { name: 'x', tableId, descriptor: {} }, wrap);
    assert.ok(noAgg.error && /aggregates/i.test(noAgg.error));
});

test('app_query_data reads rows owner-scoped and never mutates; app_get_data_model renders the data block', async () => {
    resetDataState();
    const wrap = dataWrap();
    const { tableId } = await upsertTasksTable(wrap);
    await applyToolCall('app_seed_records', { tableId, records: [{ title: 'a' }, { title: 'b' }] }, wrap);
    dataState.queryRows = [
        { id: 'rec_1', title: 'a', status: 'todo' },
        { id: 'rec_2', title: 'b', status: 'todo' },
    ];

    const writesBefore = dataState.execCalls.filter((c) => !c.read).length;
    const r = await applyToolCall('app_query_data', {
        tableId, filter: [{ field: 'status', op: 'eq', value: 'todo' }], limit: 5,
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.rowCount, 2);
    assert.strictEqual(r.rows[0].title, 'a');
    assert.strictEqual(dataState.execCalls.filter((c) => !c.read).length, writesBefore, 'read-only — no writes issued');
    const read = dataState.execCalls.filter((c) => c.read).pop();
    assert.match(read.sql, /SELECT \* FROM "tasks"/);

    const badFilter = await applyToolCall('app_query_data', {
        tableId, filter: [{ field: 'ghost', op: 'eq', value: 1 }],
    }, wrap);
    assert.ok(badFilter.error && badFilter._fixHint, 'compile failure returns a repairable error');

    const dm = await applyToolCall('app_get_data_model', {}, wrap);
    assert.ok(typeof dm.data === 'string' && dm.data.startsWith('data:'), dm.data);
    assert.ok(dm.data.includes(tableId), 'real table id present');
    assert.ok(dm.data.includes('rows=2'), `row counts present: ${dm.data}`);
    assert.strictEqual(dm.modelVersion, wrap.dataModelVersion);
});

test('app_dry_run wraps appDryRun through the real read path and never throws', async () => {
    resetDataState();
    const wrap = dataWrap();
    const { tableId } = await upsertTasksTable(wrap);
    // A grid bound to the (empty) table.
    await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ type: 'table', props: { source: { kind: 'records', tableId, sort: [{ field: 'created_at', dir: 'desc' }] } } }],
    }, wrap);

    // Empty table → clean static pass, a 0-rows warning, never an error/throw.
    dataState.queryRows = [];
    const empty = await applyToolCall('app_dry_run', {}, wrap);
    assert.ok(empty && typeof empty === 'object' && !empty.error, JSON.stringify(empty));
    assert.strictEqual(empty.ok, true, 'zero rows never blocks finalize');
    assert.deepStrictEqual(empty.static.errors, []);
    assert.strictEqual(empty.bindings.length, 1);
    assert.strictEqual(empty.bindings[0].rowCount, 0);
    assert.deepStrictEqual(empty.emptyTables, [tableId]);
    assert.ok(Array.isArray(empty._hints) && empty._hints.some((h) => /0 rows/.test(h)), JSON.stringify(empty._hints));

    // Seed the table → the same dry-run now sees rows and reports no empties.
    dataState.queryRows = [{ id: 'rec_1', title: 'a' }];
    const seeded = await applyToolCall('app_dry_run', { screenId: wrap.def.screens[0].id }, wrap);
    assert.strictEqual(seeded.ok, true);
    assert.strictEqual(seeded.bindings[0].rowCount, 1);
    assert.deepStrictEqual(seeded.emptyTables, []);
    // Read-only: dry-run issues no writes.
    assert.ok(dataState.execCalls.filter((c) => c.read).length >= 1, 'a read query ran');
});

test('app_bind_action wires catalog events beyond onClick/onSubmit (kanban onCardMove)', async () => {
    resetDataState();
    const wrap = dataWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'kb', type: 'kanban', props: { source: { kind: 'static', value: [] }, groupByField: 'status' } }],
    }, wrap);
    const { actionId } = await applyToolCall('app_set_action', {
        action: { kind: 'toast', message: 'Moved' },
    }, wrap);
    const r = await applyToolCall('app_bind_action', { nodeId: ids.kb, event: 'onCardMove', actionId }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(ops.findNode(wrap.def, ids.kb).node.onCardMove, actionId);
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true, 'onCardMove survives canonicalize + validate');

    const clear = await applyToolCall('app_bind_action', { nodeId: ids.kb, event: 'onCardMove', actionId: null }, wrap);
    assert.ok(!clear.error);
    assert.strictEqual(ops.findNode(wrap.def, ids.kb).node.onCardMove, undefined);

    const unsupported = await applyToolCall('app_bind_action', { nodeId: ids.kb, event: 'onSubmit', actionId }, wrap);
    assert.ok(unsupported.error && /does not support onSubmit/.test(unsupported.error));
});

// ── Wave 5: plan-first, phases & templates ──────────────────────────

test('boundPlanArtifact caps lengths + array sizes and drops junk fields', () => {
    const bad = boundPlanArtifact('nope');
    assert.ok(bad.error, 'non-object rejected');
    const empty = boundPlanArtifact({});
    assert.ok(empty.error, 'a plan with nothing substantive is rejected');

    const { plan, error } = boundPlanArtifact({
        title: 'x'.repeat(400),
        summary: 'y'.repeat(900),
        tables: Array.from({ length: 40 }, (_, i) => ({
            key: `t${i}`, name: `Table ${i}`,
            fields: Array.from({ length: 80 }, (_, j) => ({ key: `f${j}`, type: 'text', options: ['a', 'b'], relationTo: 'other' })),
            seedCount: 999,
        })),
        roles: [{ key: 'admin', label: 'Admin' }, { junk: 1 }],
        screens: [{ name: 'Home', purpose: 'p'.repeat(500), contents: ['a', 42, 'b'], forRoles: ['admin'] }],
        datasets: [{ name: 'D1', tableKey: 't0', purpose: 'agg' }],
        actions: [{ name: 'Create', kind: 'sequence', description: 'makes a row' }],
        phases: Array.from({ length: 30 }, (_, i) => ({ label: `Phase ${i}`, covers: ['x'] })),
        openQuestions: ['who owns records?'],
        baseTemplateId: 'app-request-form',
        evil: 'dropped',
    });
    assert.ok(!error, JSON.stringify({ error }));
    assert.ok(plan.title.length <= 120 && plan.summary.length <= 400, 'title/summary capped');
    assert.strictEqual(plan.tables.length, 20, 'tables capped to 20');
    assert.strictEqual(plan.tables[0].fields.length, 40, 'fields capped to 40 per table');
    assert.strictEqual(plan.tables[0].seedCount, 50, 'seedCount clamped to 50');
    assert.strictEqual(plan.roles.length, 1, 'keyless role dropped');
    assert.ok(plan.screens[0].purpose.length <= 200, 'purpose capped');
    assert.deepStrictEqual(plan.screens[0].contents, ['a', 'b'], 'non-string content dropped');
    assert.strictEqual(plan.phases.length, 12, 'phases capped to 12');
    assert.strictEqual(plan.baseTemplateId, 'app-request-form');
    assert.strictEqual(plan.evil, undefined, 'unknown keys dropped');
});

test('app_apply_template refuses a non-fresh draft and requires a real templateId', async () => {
    // Fresh draft (single empty screen) but no templateId → clear error.
    const fresh = freshWrap();
    const noId = await applyToolCall('app_apply_template', {}, fresh);
    assert.ok(noId.error && /templateId is required/i.test(noId.error), JSON.stringify(noId));

    // Add a component → the draft is no longer untouched → refused before any
    // template lookup or install.
    const started = freshWrap();
    const add = await applyToolCall('app_add_components', {
        parentId: homeSectionId(started),
        components: [{ type: 'heading', props: { text: 'Hi' } }],
    }, started);
    assert.ok(!add.error, JSON.stringify(add));
    const refused = await applyToolCall('app_apply_template', { templateId: 'app-request-form' }, started);
    assert.ok(refused.error && /fresh, untouched draft/i.test(refused.error), JSON.stringify(refused));
    assert.ok(refused._fixHint, 'refusal carries a fix hint');

    // Fresh draft + unknown template id → unknown-template error (past the guard).
    const unknown = await applyToolCall('app_apply_template', { templateId: 'no-such-template' }, freshWrap());
    assert.ok(unknown.error && /Unknown templateId/i.test(unknown.error), JSON.stringify(unknown));
});

test('app_apply_template lands the template\'s SCREENS, not just its tables', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_apply_template', { templateId: 'app-request-form' }, wrap);
    assert.ok(!r.error, JSON.stringify(r));

    // The regression this pins: the tool installed the data side and then
    // re-read the app's definition — which on the fresh draft it requires is
    // still one empty screen. Applying a template over MCP produced an app with
    // every table and nothing to look at.
    const { getTemplate } = require('./templates');
    const expected = getTemplate('app-request-form').definition.screens.length;
    assert.strictEqual(wrap.def.screens.length, expected, 'every template screen reached the draft');
    assert.strictEqual(r.screens, expected, 'and the result says so');
    assert.ok(Object.keys(wrap.def.actions || {}).length > 0, 'the template\'s actions came too');

    // The draft was persisted, so a follow-up tool call reads the template.
    const stored = await mockStudioAppStore.getStudioApp(wrap.appId);
    assert.strictEqual(stored.definition.screens.length, expected);
});

test('app_list_templates returns compact gallery rows', async () => {
    const r = await applyToolCall('app_list_templates', {}, freshWrap());
    assert.ok(Array.isArray(r.templates) && r.templates.length > 0, JSON.stringify(r));
    for (const t of r.templates) {
        assert.ok(t.id && t.name, 'each row has an id + name');
        assert.strictEqual(typeof t.screens, 'number');
        assert.strictEqual(typeof t.tables, 'number');
    }
});

// ── app_save_as_template (capture this app as a reusable template) ──

test('app_save_as_template needs a saved app and a title', async () => {
    const unsaved = await applyToolCall('app_save_as_template', { title: 'X' }, freshWrap());
    assert.ok(unsaved.error && /Save this app first/i.test(unsaved.error), JSON.stringify(unsaved));

    const wrap = freshWrap();
    await persistDraft(wrap);
    const noTitle = await applyToolCall('app_save_as_template', {}, wrap);
    assert.ok(noTitle.error && /title is required/i.test(noTitle.error), JSON.stringify(noTitle));
});

test('app_save_as_template captures the app and reports what must be re-wired', async () => {
    templateState.saved = [];
    const wrap = freshWrap();
    wrap.def.actions = { act_run: { kind: 'run_automation', automationId: 'auto-live-1' } };
    await persistDraft(wrap);

    const r = await applyToolCall('app_save_as_template', {
        title: 'Intake starter', description: 'Mail in, quote out', category: 'Sales', tags: ['mail'],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r.templateId.startsWith('utpl_'), 'captured ids are distinguishable from built-in ones');
    // persistDraft backfills the owner's org onto the draft, so a template made
    // from a real app is shared with that org — private is the exception.
    assert.strictEqual(r.scope, 'organisation');
    assert.strictEqual(templateState.saved[0].organizationId, wrap.orgId);

    const [saved] = templateState.saved;
    assert.strictEqual(saved.title, 'Intake starter');
    assert.strictEqual(saved.sourceAppId, wrap.appId, 'provenance is recorded');
    // Looked up by value: the canonicalizer re-keys authored action ids.
    const actions = Object.values(saved.payload.definition.actions);
    assert.strictEqual(actions.length, 1);
    assert.strictEqual(
        actions[0].automationId, null,
        'a live automation id must never be handed to whoever installs this',
    );
    assert.ok(r.requires.some((q) => q.kind === 'automation'), 'the cleared automation is reported, not hidden');
    assert.strictEqual(r.seededRows, 0, 'no rows travel unless a table was named');
    assert.ok(r._hints.some((h) => /seedTables/.test(h)), 'the empty seed is explained');

    // Reading the app is not editing it: no draft write, so no CAS bump.
    assert.ok(!MUTATING_TOOLS.has('app_save_as_template'));
});

test('app_save_as_template refuses seedTables that name no real table', async () => {
    const wrap = freshWrap();
    wrap.dataModel = { modelVersion: 1, tables: [{ id: 'tbl_real', key: 'items', name: 'Items', fields: [] }] };
    await persistDraft(wrap);
    const r = await applyToolCall('app_save_as_template', { title: 'T', seedTables: ['tbl_ghost'] }, wrap);
    assert.ok(r.error && /Unknown seedTables/i.test(r.error), JSON.stringify(r));
    assert.ok(/tbl_real/.test(r._fixHint), 'the hint names the ids that DO exist');
});

test('a store failure comes back as a tool error, never an exception', async () => {
    const wrap = freshWrap();
    await persistDraft(wrap);
    templateState.failWith = 'Template limit reached (100).';
    const r = await applyToolCall('app_save_as_template', { title: 'T' }, wrap);
    templateState.failWith = null;
    assert.ok(r.error && /Template limit reached/.test(r.error), JSON.stringify(r));
});

// ── Surface sanity ──────────────────────────────────────────────────

test('every declared tool schema has an implementation and vice versa', async () => {
    const names = TOOL_SCHEMAS.map((t) => t.function.name);
    assert.strictEqual(new Set(names).size, names.length, 'no duplicate tool names');
    for (const name of names) {
        const wrap = freshWrap();
        const r = await applyToolCall(name, {}, wrap);
        assert.ok(r && typeof r === 'object', `${name} returns an object`);
        assert.ok(!(r.error && /unknown app builder tool/i.test(r.error)), `${name} is dispatched`);
    }
    for (const name of MUTATING_TOOLS) {
        assert.ok(names.includes(name), `mutating tool ${name} is declared in TOOL_SCHEMAS`);
    }
    const unknown = await applyToolCall('app_frobnicate', {}, freshWrap());
    assert.ok(unknown.error && /unknown app builder tool/i.test(unknown.error));
});

// ── app_list_connectors (read, safe projection) ─────────────────────
test('app_list_connectors returns the safe projection — no fixedArgs / url / creds', async () => {
    const wrap = freshWrap();
    wrap.dataModel = {
        modelVersion: 1, tables: [],
        connectors: [
            { id: 'conn_rest01', kind: 'rest', name: 'Items', params: [{ key: 'q', type: 'text', required: false }], url: 'https://api.example.com/items?q={q}', fixedArgs: undefined, auth: { type: 'bearer', credentialProvider: 'example' }, headers: { 'X-Api-Version': '2' } },
            { id: 'conn_tool01', kind: 'integration_tool', name: 'Emails', tool: 'gmail_list', fixedArgs: { labelIds: ['INBOX'] } },
        ],
    };
    const r = await applyToolCall('app_list_connectors', {}, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.connectors.length, 2);
    const serialized = JSON.stringify(r);
    for (const leak of ['fixedArgs', 'INBOX', 'api.example.com', 'credentialProvider', 'gmail_list', 'X-Api-Version']) {
        assert.ok(!serialized.includes(leak), `must not leak ${leak}`);
    }
    assert.deepStrictEqual(Object.keys(r.connectors[0]).sort(), ['id', 'kind', 'name', 'params']);
    // Read-only — not a mutating tool, and no draft/data persistence.
    assert.ok(!MUTATING_TOOLS.has('app_list_connectors'));
});

test('app_list_connectors on a connectorless app returns an empty list with guidance', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_list_connectors', {}, wrap);
    assert.deepStrictEqual(r.connectors, []);
    assert.match(r.note, /Connectors tab/);
});

test('app_list_connectors is a schema-declared paramless tool', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === 'app_list_connectors');
    assert.ok(schema, 'schema present');
    assert.deepStrictEqual(schema.function.parameters, { type: 'object', properties: {} });
});

// ── Schema ↔ spec lockstep ──────────────────────────────────────────
//
// Every enum/value list the tool schemas expose must be DERIVED from the
// authoritative vocabulary exports — the section-background bug (componentSpecs
// grew "panel"/"gradient", the schema still said [none,surface,tint], so the
// model physically could not emit them) is the class of drift these pin down.
// The deepStrictEqual battery fails the moment someone re-hardcodes a list;
// the description checks fail when the prose stops teaching a value the spec
// (or an enforcement cap) has.

const {
    THEME_SPEC, DESIGN_SPEC, NAV_STYLES, STYLE_KNOBS, SCREEN_SPEC,
    EVENT_NAMES, ACTION_KINDS, STEP_KINDS, VARIABLE_TYPES, LIMITS, COMPONENT_SPECS,
} = require('./componentSpecs');
const { APP_DESIGN_PRESETS } = require('./appDesignPresets');
const { FIELD_TYPES, FILTER_OPS, AGG_FNS, DATE_BUCKETS, ACCESS_MODES } = require('./dataModel');
const {
    MAX_COMPONENTS_PER_CALL, MAX_SEED_RECORDS, TEMP_ID_MAX, TEMP_ID_RX, SECTION_HEIGHT_MODES,
} = require('./builderTools/schemas');
const { _test: builderInternals } = require('./builderTools');

function toolProps(name) {
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === name);
    assert.ok(schema, `schema for ${name} present`);
    return schema.function.parameters.properties;
}

test('schema enums are derived from the componentSpecs/appDesignPresets/dataModel vocabularies', () => {
    // app_set_theme — every knob enum mirrors its spec.
    const theme = toolProps('app_set_theme');
    assert.deepStrictEqual(theme.preset.enum, APP_DESIGN_PRESETS.map((p) => p.id));
    assert.deepStrictEqual(theme.radius.enum, [...THEME_SPEC.radius.values]);
    assert.deepStrictEqual(theme.density.enum, [...THEME_SPEC.density.values]);
    assert.deepStrictEqual(theme.fontScale.enum, [...THEME_SPEC.fontScale.values]);
    assert.deepStrictEqual(theme.appearance.enum, [...THEME_SPEC.appearance.values]);
    assert.deepStrictEqual(theme.navStyle.enum, [...NAV_STYLES]);
    assert.deepStrictEqual(theme.font.enum, [...DESIGN_SPEC.font.values]);
    assert.deepStrictEqual(theme.surface.enum, [...DESIGN_SPEC.surface.values]);
    assert.deepStrictEqual(theme.motion.enum, [...DESIGN_SPEC.motion.values]);
    assert.deepStrictEqual(theme.chartPalette.enum, [...DESIGN_SPEC.chartPalette.values]);
    // Completeness: every knob applySetTheme accepts is settable via the schema
    // (THEME_SPEC keys + DESIGN_SPEC keys minus the provenance-only `preset`).
    for (const k of Object.keys(THEME_SPEC)) assert.ok(theme[k], `theme knob ${k} declared`);
    for (const k of Object.keys(DESIGN_SPEC).filter((x) => x !== 'preset')) assert.ok(theme[k], `design knob ${k} declared`);

    // app_add_screen / app_update_screen — SCREEN_SPEC enums.
    for (const name of ['app_add_screen', 'app_update_screen']) {
        const p = toolProps(name);
        assert.deepStrictEqual(p.maxWidth.enum, [...SCREEN_SPEC.maxWidth.values], `${name}.maxWidth`);
        assert.deepStrictEqual(p.refreshInterval.enum, [...SCREEN_SPEC.refreshInterval.values], `${name}.refreshInterval`);
    }

    // app_add_section — the original bug: background/height must be the FULL
    // STYLE_KNOBS vocabulary, panel/gradient/xl included.
    const style = toolProps('app_add_section').style.properties;
    assert.deepStrictEqual(style.background.enum, [...STYLE_KNOBS.background.values]);
    assert.ok(style.background.enum.includes('panel') && style.background.enum.includes('gradient'),
        'the look-pass backgrounds are emittable');
    assert.deepStrictEqual(style.height.enum, [...STYLE_KNOBS.height.values]);
    assert.ok(style.height.enum.includes('xl'), 'the document-viewer height is emittable');

    // app_bind_action — the full event vocabulary (onChange was stranded once).
    assert.deepStrictEqual(toolProps('app_bind_action').event.enum, [...EVENT_NAMES]);
    assert.ok(toolProps('app_bind_action').event.enum.includes('onChange'), 'onChange is emittable');

    // Data-side enums.
    assert.deepStrictEqual(toolProps('app_upsert_table').access.properties.default.enum, [...ACCESS_MODES]);
    assert.deepStrictEqual(toolProps('app_set_variables').variables.items.properties.type.enum, [...VARIABLE_TYPES]);
});

test('schema descriptions spell out the closed vocabularies and caps they teach', () => {
    // Prose that enumerates values must cover every value the spec has.
    const theme = toolProps('app_set_theme');
    for (const id of APP_DESIGN_PRESETS.map((p) => p.id)) {
        assert.ok(theme.preset.description.includes(id), `preset description explains "${id}"`);
    }
    for (const nav of NAV_STYLES) {
        assert.ok(theme.navStyle.description.includes(nav), `navStyle description explains "${nav}"`);
    }

    const sectionStyle = toolProps('app_add_section').style;
    for (const v of STYLE_KNOBS.background.values) {
        assert.ok(sectionStyle.description.includes(`"${v}"`), `section style description teaches background "${v}"`);
    }

    // Since 2026-09-17 the action object declares its shape (an object with
    // no `properties` renders as an empty box on Gemma's template): the kinds
    // are the enum, not prose.
    const action = toolProps('app_set_action').action;
    assert.deepStrictEqual(action.properties.kind.enum, [...ACTION_KINDS], 'app_set_action teaches every kind as an enum');
    assert.deepStrictEqual(action.properties.steps.items.properties.kind.enum, [...STEP_KINDS]);
    assert.match(action.description, /SAVE A FORM/);

    const fieldType = toolProps('app_upsert_table').fields.items.properties.type;
    assert.deepStrictEqual(fieldType.enum, [...FIELD_TYPES], 'field types are the enum');
    const accessDesc = toolProps('app_upsert_table').access.description;
    for (const mode of ACCESS_MODES) {
        assert.ok(accessDesc.includes(`"${mode}"`), `access description explains "${mode}"`);
    }

    const descriptor = toolProps('app_upsert_dataset').descriptor.description;
    assert.ok(descriptor.includes(AGG_FNS.join('|')), 'every aggregate fn is taught (p50/p90 included)');
    assert.ok(descriptor.includes(DATE_BUCKETS.join('|')), 'every date bucket is taught (hour included)');
    assert.ok(descriptor.includes(FILTER_OPS.join(', ')), 'filter ops taught on the descriptor');
    assert.ok(toolProps('app_query_data').filter.description.includes(FILTER_OPS.join(', ')), 'filter ops taught on app_query_data');

    // Caps: the number the schema teaches is the number the tool enforces.
    const seedDesc = TOOL_SCHEMAS.find((t) => t.function.name === 'app_seed_records').function.description;
    assert.ok(seedDesc.includes(`1-${MAX_SEED_RECORDS} per call`), 'seed cap taught');
    const componentsProp = toolProps('app_add_components').components;
    assert.ok(componentsProp.description.includes(`max ${MAX_COMPONENTS_PER_CALL}`), 'component batch cap taught');
    assert.ok(componentsProp.items.properties.tempId.description.includes(`max ${TEMP_ID_MAX}`), 'tempId cap taught');
    assert.match('A'.repeat(TEMP_ID_MAX), TEMP_ID_RX, 'regex accepts the taught maximum');
    assert.doesNotMatch('A'.repeat(TEMP_ID_MAX + 1), TEMP_ID_RX, 'regex rejects one past the taught maximum');
    const variablesDesc = toolProps('app_set_variables').variables.description;
    assert.ok(variablesDesc.includes(`max ${LIMITS.MAX_VARIABLES}`), 'variables cap taught');
    // app_propose_plan seedCount prose ↔ the plan-bounding clamp.
    const seedCountDesc = toolProps('app_propose_plan').tables.items.properties.seedCount.description;
    assert.ok(seedCountDesc.includes(`0-${builderInternals.PLAN_LIMITS.MAX_SEED}`), 'plan seedCount cap taught');
    assert.ok(toolProps('app_propose_plan').summary.description.includes(`max ${builderInternals.PLAN_LIMITS.SUMMARY}`), 'plan summary cap taught');
    assert.ok(toolProps('app_query_data').limit.description.includes(`max ${builderInternals.MAX_QUERY_LIMIT}`), 'query row cap taught');
    assert.ok(toolProps('app_set_meta').name.description.includes(`max ${LIMITS.MAX_NAME_LEN}`), 'app name cap taught');
    for (const name of ['app_add_screen', 'app_update_screen']) {
        assert.ok(toolProps(name).description.description.includes(`${SCREEN_SPEC.description.maxLen}`), `${name} screen-description cap taught`);
    }
});

test('app_add_section can emit every spec background — panel/gradient land and validate', async () => {
    const wrap = freshWrap();
    const screenId = wrap.def.screens[0].id;
    for (const background of STYLE_KNOBS.background.values) {
        const r = await applyToolCall('app_add_section', { screenId, style: { background } }, wrap);
        assert.ok(!r.error, `background "${background}": ${JSON.stringify(r)}`);
        const { section } = ops.findSection(wrap.def, r.sectionId);
        assert.strictEqual(section.style.background, background, `background "${background}" stored untouched`);
    }
    const tall = await applyToolCall('app_add_section', { screenId, style: { background: 'gradient', height: 'xl' } }, wrap);
    assert.ok(!tall.error, JSON.stringify(tall));
    assert.strictEqual(ops.findSection(wrap.def, tall.sectionId).section.style.height, 'xl', 'height "xl" stored');
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true, 'every look-pass section validates');
});

// ── Advanced sizing on the tool surface ─────────────────────────────
//
// The four sizing knobs (widthMode/widthValue, heightMode/heightValue) are in
// STYLE_KNOBS but in NO type's `styleKnobs` list: componentSpecs.expandStyleKnobs
// derives the width pair from `span` and the height pair from `height`. A node
// `style` is a free-form object on this surface, so the pairs reached the model
// the moment canonicalize accepted them — but the SECTION style is the one place
// this file enumerates keys, so it is the one place the pair has to be DECLARED,
// and the one place a mode has to be SUBTRACTED ("pct" has nothing to measure
// against in the screen's auto-height stack). These pin both halves against the
// pipeline that actually enforces them.

test('the section style schema declares the height pair, derived, with pct subtracted', () => {
    const style = toolProps('app_add_section').style;
    assert.deepStrictEqual(style.properties.heightMode.enum, [...SECTION_HEIGHT_MODES]);
    assert.deepStrictEqual(
        SECTION_HEIGHT_MODES,
        STYLE_KNOBS.heightMode.values.filter((m) => m !== 'pct'),
        'the subtraction is exactly "pct" — every other mode componentSpecs grows reaches sections automatically',
    );
    assert.ok(style.properties.heightValue, 'the value knob is declared beside its mode');
    // Prose: every offered mode, and the unit window each one carries.
    for (const mode of SECTION_HEIGHT_MODES) {
        assert.ok(style.description.includes(`"${mode}"`), `section style description teaches heightMode "${mode}"`);
    }
    for (const [unit, range] of Object.entries(STYLE_KNOBS.heightValue.units)) {
        if (!SECTION_HEIGHT_MODES.includes(unit)) continue;
        assert.ok(style.description.includes(`${unit} ${range.min}-${range.max}`), `the ${unit} window is taught`);
    }
    assert.ok(/never take "pct"/.test(style.description), 'and the one exclusion is explained, not just omitted');
});

test('app_add_section emits every height mode the schema offers; pct is repaired, never stored', async () => {
    const wrap = freshWrap();
    const screenId = wrap.def.screens[0].id;
    for (const heightMode of SECTION_HEIGHT_MODES) {
        const range = STYLE_KNOBS.heightValue.units[heightMode];
        const r = await applyToolCall('app_add_section', {
            screenId,
            style: range ? { heightMode, heightValue: range.default } : { heightMode },
        }, wrap);
        assert.ok(!r.error, `heightMode "${heightMode}": ${JSON.stringify(r)}`);
        const { section } = ops.findSection(wrap.def, r.sectionId);
        assert.strictEqual(section.style.heightMode, heightMode, `heightMode "${heightMode}" stored untouched`);
        if (range) assert.strictEqual(section.style.heightValue, range.default, `the ${heightMode} value survives canonicalize`);
    }
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true, 'every offered section height validates');

    // The subtraction is not editorial: canonicalize resets pct on a section
    // with a reason, so offering it here would only produce undone calls.
    const pct = await applyToolCall('app_add_section', { screenId, style: { heightMode: 'pct', heightValue: 50 } }, wrap);
    assert.ok(!pct.error, JSON.stringify(pct));
    assert.strictEqual(
        ops.findSection(wrap.def, pct.sectionId).section.style.heightMode,
        STYLE_KNOBS.heightMode.default,
        'pct never lands on a section',
    );
});

test('app_add_components: the sizing pairs land on nodes, and span keeps owning placement', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [
            { tempId: 'rail', type: 'card', props: {}, style: { span: 3, widthMode: 'px', widthValue: 240 } },
            { tempId: 'tile', type: 'card', props: {}, style: { span: 4, widthMode: 'pct', widthValue: 50, heightMode: 'vh', heightValue: 40 } },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));

    const rail = ops.findNode(wrap.def, r.ids.rail).node;
    assert.strictEqual(rail.style.span, 3, 'the grid still owns placement — an exact width does not eat the span');
    assert.strictEqual(rail.style.widthMode, 'px');
    assert.strictEqual(rail.style.widthValue, 240);

    const tile = ops.findNode(wrap.def, r.ids.tile).node;
    assert.strictEqual(tile.style.widthMode, 'pct');
    assert.strictEqual(tile.style.heightMode, 'vh');
    assert.strictEqual(tile.style.heightValue, 40);

    const v = validateAppDefinition(wrap.def);
    assert.strictEqual(v.ok, true, `advanced sizing validates: ${JSON.stringify(v.errors)}`);
});

test('the derived availability the prompt teaches is the one the pipeline enforces', async () => {
    // `stat` has span but no height, so the rule says: width pair yes, height
    // pair no. If that ever stops being true, the ONE stated rule in the
    // catalog silently starts lying about 48 component types.
    assert.ok(COMPONENT_SPECS.stat.styleKnobs.includes('span') && !COMPONENT_SPECS.stat.styleKnobs.includes('height'),
        'sanity: stat is still a type that has span without height');
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{
            tempId: 'tb', type: 'stat', props: { label: 'Open' },
            style: { span: 6, widthMode: 'px', widthValue: 300, heightMode: 'px', heightValue: 200 },
        }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const style = ops.findNode(wrap.def, r.ids.tb).node.style;
    assert.strictEqual(style.widthMode, 'px', 'the width pair is legal on a type with span');
    assert.strictEqual(style.widthValue, 300);
    assert.strictEqual(style.heightMode, undefined, 'the height pair is refused on a type without height');
    assert.strictEqual(style.heightValue, undefined);
    // Refused LOUDLY: the drop is reported, so the model can correct itself.
    const hint = (r._hints || []).find((h) => /heightMode/.test(h));
    assert.ok(hint, `the dropped pair is hinted, not silent: ${JSON.stringify(r._hints)}`);
    assert.match(hint, /widthMode, widthValue/, 'and the hint lists the pair that WAS legal here');
});

test('app_update_component: the revert recipe the schema teaches leaves nothing inert', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'c', type: 'card', props: {}, style: { span: 6, widthMode: 'px', widthValue: 240 } }],
    }, wrap);

    // The trap the schema description exists to prevent: clearing the mode on
    // its own KEEPS the number (canonicalize never deletes an author's value)
    // and it sits there inert.
    const half = await applyToolCall('app_update_component', { id: ids.c, style: { widthMode: 'span' } }, wrap);
    assert.ok(!half.error, JSON.stringify(half));
    assert.strictEqual(ops.findNode(wrap.def, ids.c).node.style.widthValue, 240, 'the stranded value is real, not hypothetical');

    // The taught form clears both, in one patch, with no repair hint.
    const full = await applyToolCall('app_update_component', { id: ids.c, style: { widthMode: 'span', widthValue: null } }, wrap);
    assert.ok(!full.error, JSON.stringify(full));
    const style = ops.findNode(wrap.def, ids.c).node.style;
    assert.strictEqual(style.widthValue, undefined, 'the number is gone');
    assert.strictEqual(style.widthMode, 'span', 'and the component is back on its column span');
    assert.strictEqual(style.span, 6, 'which was never touched');
    assert.ok(!(full._hints || []).some((h) => /inert|widthValue/.test(h)),
        `the taught form is repair-free: ${JSON.stringify(full._hints)}`);

    // And the recipe in the description is the one that was just proved.
    const desc = toolProps('app_update_component').style.description;
    assert.match(desc, /widthMode: "span", widthValue: null/);
    assert.match(desc, /heightMode: "preset", heightValue: null/);
});

// ── Look-variant props (v2.2) flow through the generic props objects ─

test('app_add_components: look/accent props (stat look:"tile") land in the draft and validate', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [
            { tempId: 'kpi', type: 'stat', props: { label: 'Open tickets', value: { kind: 'static', value: 12 }, look: 'tile' } },
            { tempId: 'hd', type: 'heading', props: { text: 'Board', accent: 'bar' } },
            { tempId: 'crd', type: 'card', props: { look: 'accent' }, children: [{ type: 'text', props: { text: 'inside' } }] },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const stat = ops.findNode(wrap.def, r.ids.kpi).node;
    assert.strictEqual(stat.props.look, 'tile', 'stat look prop passed through untouched');
    assert.strictEqual(stat.props.label, 'Open tickets');
    assert.strictEqual(ops.findNode(wrap.def, r.ids.hd).node.props.accent, 'bar', 'heading accent passed through');
    assert.strictEqual(ops.findNode(wrap.def, r.ids.crd).node.props.look, 'accent', 'card look passed through');
    const v = validateAppDefinition(wrap.def);
    assert.strictEqual(v.ok, true, `look props validate: ${JSON.stringify(v.errors)}`);
});

test('app_update_component sets look props on existing nodes; illegal values are flagged, not stripped', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'kpi', type: 'stat', props: { label: 'Revenue' } }],
    }, wrap);
    assert.strictEqual(ops.findNode(wrap.def, ids.kpi).node.props.look, 'plain', 'spec default filled in');

    const r = await applyToolCall('app_update_component', { id: ids.kpi, props: { look: 'gradient' } }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    const node = ops.findNode(wrap.def, ids.kpi).node;
    assert.strictEqual(node.props.look, 'gradient', 'look updated in place');
    assert.strictEqual(node.props.label, 'Revenue', 'merge keeps the other props');
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true);

    // An out-of-vocabulary look is kept on the node (nothing silently strips
    // it) and validate names the legal values — the model can self-repair.
    const bad = await applyToolCall('app_update_component', { id: ids.kpi, props: { look: 'neon' } }, wrap);
    assert.ok(!bad.error, JSON.stringify(bad));
    const after = validateAppDefinition(wrap.def);
    assert.strictEqual(after.ok, false, 'illegal enum value is a validation error');
    assert.ok(after.errors.some((e) => e.code === 'prop.enum' && /look/.test(e.path)), JSON.stringify(after.errors));

    const fixed = await applyToolCall('app_update_component', { id: ids.kpi, props: { look: 'tile' } }, wrap);
    assert.ok(!fixed.error);
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true, 'repair restores a valid draft');
});

test('app_bind_action wires onChange on a discrete input (triage-bar pattern)', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{
            tempId: 'frm', type: 'form', props: { name: 'triage' },
            children: [{ tempId: 'sel', type: 'input_select', props: { name: 'status', label: 'Status', options: [{ value: 'todo' }, { value: 'done' }] } }],
        }],
    }, wrap);
    const { actionId } = await applyToolCall('app_set_action', { action: { kind: 'toast', message: 'Saved' } }, wrap);
    const r = await applyToolCall('app_bind_action', { nodeId: ids.sel, event: 'onChange', actionId }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(ops.findNode(wrap.def, ids.sel).node.onChange, actionId);
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true, 'onChange wiring validates');
});

// ── Node logic reachability: computed / validations / readOnly ───────
//
// These three lived in canonicalize, validate AND the renderer while appearing
// in no tool schema and no prompt — so nothing the model could send would ever
// store them, and the tool still answered "added". The consequence was not
// cosmetic: 22 of the component types have no binding-typed prop, so without
// `computed` every string on a heading/button/callout is static forever, and a
// session that tried to put a running value on one concluded — reasonably,
// from what it had been told — that live binding was architecturally limited.
// These tests are the round trip that was missing.

test('app_add_components stores computed/validations/readOnly, and they survive validate', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [
            {
                tempId: 'hd', type: 'heading', props: { text: 'Total' },
                computed: { text: { kind: 'formula', expr: "concat('Total: ', toStr(vars.total))" } },
                readOnly: true,
            },
            {
                tempId: 'frm', type: 'form', props: { name: 'signup' },
                children: [{
                    tempId: 'eml', type: 'input_text', props: { name: 'email', label: 'Email' },
                    validations: [{ type: 'required' }, { type: 'format', format: 'email', message: 'Enter a real email' }],
                    readOnly: { kind: 'formula', expr: 'vars.locked == true' },
                }],
            },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));

    const heading = ops.findNode(wrap.def, r.ids.hd).node;
    assert.deepStrictEqual(heading.computed, { text: { kind: 'formula', expr: "concat('Total: ', toStr(vars.total))" } },
        'computed reaches the stored node — the whole point');
    assert.strictEqual(heading.readOnly, true);
    const email = ops.findNode(wrap.def, r.ids.eml).node;
    assert.deepStrictEqual(email.validations, [
        { type: 'required' },
        { type: 'format', format: 'email', message: 'Enter a real email' },
    ]);
    assert.deepStrictEqual(email.readOnly, { kind: 'formula', expr: 'vars.locked == true' });

    const v = validateAppDefinition(wrap.def);
    assert.strictEqual(v.ok, true, `node logic validates: ${JSON.stringify(v.errors)}`);
});

test('computed accepts a bare expression string and wraps it, like the When-flags do', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'hd', type: 'heading', props: { text: '0' }, computed: { text: 'toStr(vars.n)' } }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(ops.findNode(wrap.def, r.ids.hd).node.computed,
        { text: { kind: 'formula', expr: 'toStr(vars.n)' } }, 'bare string wrapped as a formula');
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true);
});

test('app_update_component sets, echoes and clears computed/validations/readOnly in place', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'b', type: 'button', props: { label: 'Go' } }],
    }, wrap);

    const set = await applyToolCall('app_update_component', {
        id: ids.b,
        computed: { label: 'concat("Pay ", toStr(vars.total))' },
        readOnly: 'vars.locked == true',
    }, wrap);
    assert.ok(!set.error, JSON.stringify(set));
    let node = ops.findNode(wrap.def, ids.b).node;
    assert.deepStrictEqual(node.computed, { label: { kind: 'formula', expr: 'concat("Pay ", toStr(vars.total))' } });
    assert.deepStrictEqual(node.readOnly, { kind: 'formula', expr: 'vars.locked == true' });
    // The echo has to SHOW them, or the model cannot tell they landed.
    assert.deepStrictEqual(set.component.computed, node.computed, 'result echoes the stored computed');
    assert.deepStrictEqual(set.component.readOnly, node.readOnly, 'result echoes the stored readOnly');
    assert.strictEqual(node.props.label, 'Go', 'props untouched');

    const clear = await applyToolCall('app_update_component', { id: ids.b, computed: null, readOnly: null }, wrap);
    assert.ok(!clear.error, JSON.stringify(clear));
    node = ops.findNode(wrap.def, ids.b).node;
    assert.strictEqual(node.computed, undefined, 'null clears computed');
    assert.strictEqual(node.readOnly, undefined, 'null clears readOnly');
    assert.strictEqual('computed' in clear.component, false, 'a node without them echoes exactly what it always did');
});

test('bad node-logic shapes reject with the legal shape spelled out', async () => {
    const wrap = freshWrap();
    const sectionId = homeSectionId(wrap);
    const badComputed = await applyToolCall('app_add_components', {
        parentId: sectionId,
        components: [{ type: 'heading', props: { text: 'x' }, computed: ['nope'] }],
    }, wrap);
    assert.ok(badComputed.error && /computed must be an object/.test(badComputed.error), JSON.stringify(badComputed));

    const badEntry = await applyToolCall('app_add_components', {
        parentId: sectionId,
        components: [{ type: 'heading', props: { text: 'x' }, computed: { text: 42 } }],
    }, wrap);
    assert.ok(badEntry.error && /computed\.text/.test(badEntry.error), JSON.stringify(badEntry));

    const badRule = await applyToolCall('app_add_components', {
        parentId: sectionId,
        components: [{ type: 'input_text', props: { name: 'a' }, validations: [{ type: 'require' }] }],
    }, wrap);
    assert.ok(badRule.error && /Did you mean "required"/.test(badRule.error), JSON.stringify(badRule));

    const notArray = await applyToolCall('app_update_component', { id: 'x', validations: { type: 'required' } }, wrap);
    assert.ok(notArray.error, JSON.stringify(notArray));
    assert.strictEqual(wrap.def.screens[0].sections[0].children.length, 0, 'no partial node landed');
});

/**
 * The validation-type list is copied into builderTools/schemas.js because
 * validate.js declares but does not export it. This is the lockstep: every
 * type the copy claims must be accepted by the validator, and a type it does
 * not claim must be refused with a hint enumerating exactly the copy.
 */
test('NODE_VALIDATION_TYPES stays in lockstep with the validator that enforces it', async () => {
    const { NODE_VALIDATION_TYPES } = require('./builderTools/schemas');
    const rules = {
        required: { type: 'required' },
        minLength: { type: 'minLength', value: 3 },
        format: { type: 'format', format: 'email' },
        formula: { type: 'formula', expr: "vars.x != ''" },
    };
    for (const type of NODE_VALIDATION_TYPES) {
        const wrap = freshWrap();
        const r = await applyToolCall('app_add_components', {
            parentId: homeSectionId(wrap),
            components: [{
                tempId: 'i', type: 'input_text', props: { name: 'f', label: 'F' },
                validations: [rules[type]],
            }],
        }, wrap);
        assert.ok(!r.error, `validation type ${type}: ${JSON.stringify(r)}`);
        const v = validateAppDefinition(wrap.def);
        assert.strictEqual(v.ok, true, `validation type ${type} rejected by validate: ${JSON.stringify(v.errors)}`);
    }
    // And the validator's own message names exactly this list.
    const wrap = freshWrap();
    wrap.def.screens[0].sections[0].children = [{
        id: 'cmp_v00001', type: 'input_text', visible: true, style: {},
        props: { name: 'f', label: 'F' }, validations: [{ type: 'nonsense' }],
    }];
    const v = validateAppDefinition(wrap.def);
    const err = v.errors.find((e) => e.code === 'validation.type_invalid');
    assert.ok(err, JSON.stringify(v.errors));
    assert.strictEqual(err.hint, `Use one of: ${NODE_VALIDATION_TYPES.join(', ')}.`,
        'the copy in schemas.js drifted from validate.js VALIDATION_TYPES');
});

// ── Unknown ENTRY keys are taught, not swallowed ─────────────────────
//
// canonicalize teaches unknown PROP and STYLE keys ("Dropped unknown prop
// keys: fullWidth. Legal keys for button: …") but never sees entry-level keys —
// buildComponentNode discards them first. So `computed`, `onClick` and a
// typo'd `visibleIf` all returned _hints:null, error:null: the model was told
// the add SUCCEEDED. That silence is the delivery mechanism for every
// entry-key typo, and it is what kept the node-logic gap invisible.

test('app_add_components reports dropped entry keys in the canonicalizer\'s own wording', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'h', type: 'heading', props: { text: 'x' }, onClick: 'act_x', visibleIf: 'vars.a' }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(Array.isArray(r._hints) && r._hints.length, 'the drop is reported at all');
    const hint = r._hints.join('\n');
    assert.match(hint, /Dropped unknown entry keys:/);
    assert.match(hint, /onClick/);
    assert.match(hint, /visibleIf \(did you mean "visibleWhen"\?\)/, 'a near miss gets a suggestion');
    assert.match(hint, /Legal keys: type, props, style, children, tempId,/);
    assert.match(hint, /app_bind_action/, 'an event key is pointed at the tool that wires it');
    // Only near misses get a suggestion: pickClosestId's "any real id beats
    // none" fallback would answer onClick with `type`, which teaches nothing.
    assert.doesNotMatch(hint, /onClick \(did you mean/);
});

test('entry-key hints reach into nested children, and a clean entry stays hint-free', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{
            type: 'card', props: { title: 'Box' },
            children: [{ type: 'text', props: { text: 'in' }, style: {}, bogus: 1 }],
        }],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r._hints.some((h) => /components\[0\]\.children\[0\]: Dropped unknown entry keys: bogus/.test(h)), JSON.stringify(r._hints));

    const clean = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ type: 'text', props: { text: 'ok' }, computed: { text: 'vars.a' }, readOnly: false }],
    }, wrap);
    assert.strictEqual(clean._hints, undefined, 'the now-legal keys produce no drop hint');
});

// ── Echo-after-adoption ──────────────────────────────────────────────
//
// Every echoed field must be read off draftWrap.def AFTER adoptCanonical has
// reassigned it. Built as an argument instead, the echo describes the PREVIOUS
// definition — which is how app_set_variables came to return [] on call 1 and
// call 1's list on call 2, and how a model learned to distrust a tool that was
// working perfectly.

test('app_set_meta echoes the STORED meta, not the pre-canonicalize patch', async () => {
    const wrap = freshWrap();
    const long = 'N'.repeat(LIMITS.MAX_NAME_LEN + 20);
    const r = await applyToolCall('app_set_meta', { name: long }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.meta.name.length, LIMITS.MAX_NAME_LEN, 'the echo shows the truncation that happened');
    assert.strictEqual(r.meta.name, wrap.def.meta.name, 'echo === stored');

    const blank = await applyToolCall('app_set_meta', { name: '  ' }, wrap);
    assert.strictEqual(blank.meta.name, wrap.def.meta.name, 'a rejected name echoes the value that was kept');
});

test('app_remove_screen echoes the home screen the definition actually ended up with', async () => {
    const wrap = freshWrap();
    const first = wrap.def.screens[0].id;
    await applyToolCall('app_add_screen', { name: 'Second' }, wrap); // reuses the empty Home (same id)
    const { screenId: second } = await applyToolCall('app_add_screen', { name: 'Third' }, wrap);
    const r = await applyToolCall('app_remove_screen', { screenId: first }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.homeScreenId, wrap.def.homeScreenId, 'echo === stored');
    assert.strictEqual(r.homeScreenId, second, 'home repointed at the survivor');
});

// ── Batch forms on update / set_action / bind_action ─────────────────
//
// app_add_components has batched since day one; these three did not, so a plain
// calculator cost ~70 sequential calls. The single form stays verbatim; the
// array form is PARTIAL — one bad patch may not void the good ones, and the
// model has to be able to tell which failed.

test('app_update_component: batch form applies every patch and reports failures per index', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [
            { tempId: 'a', type: 'button', props: { label: 'A' } },
            { tempId: 'b', type: 'button', props: { label: 'B' } },
        ],
    }, wrap);

    const r = await applyToolCall('app_update_component', {
        updates: [
            { id: ids.a, style: { span: 4 } },
            { id: 'cmp_ghost', props: { label: 'nope' } },
            { id: ids.b, computed: { label: 'toStr(vars.n)' } },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.applied, 2);
    assert.deepStrictEqual(r.updated, [ids.a, ids.b]);
    assert.strictEqual(r.failed.length, 1);
    assert.strictEqual(r.failed[0].index, 1, 'the failure carries the index the model sent');
    assert.match(r.failed[0].error, /cmp_ghost/);
    assert.strictEqual(ops.findNode(wrap.def, ids.a).node.style.span, 4, 'the good patch before the bad one landed');
    assert.deepStrictEqual(ops.findNode(wrap.def, ids.b).node.computed, { label: { kind: 'formula', expr: 'toStr(vars.n)' } },
        'and the good patch AFTER the bad one landed too');
    assert.ok(r._hints.some((h) => /1 of 3 entries failed/.test(h)), JSON.stringify(r._hints));
});

test('app_set_action + app_bind_action batch a keypad in two calls, single form untouched', async () => {
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [
            { tempId: 'k1', type: 'button', props: { label: '1' } },
            { tempId: 'k2', type: 'button', props: { label: '2' } },
        ],
    }, wrap);

    const acts = await applyToolCall('app_set_action', {
        actions: [
            { action: { kind: 'toast', message: 'one' } },
            { action: { kind: 'toast', message: 'two' } },
        ],
    }, wrap);
    assert.ok(!acts.error, JSON.stringify(acts));
    assert.strictEqual(acts.applied, 2);
    assert.strictEqual(acts.actionId.length, 2, 'the ids come back in entry order');
    assert.ok(acts.actions.every((a) => a.created === true));

    const binds = await applyToolCall('app_bind_action', {
        bindings: [
            { nodeId: ids.k1, event: 'onClick', actionId: acts.actionId[0] },
            { nodeId: ids.k2, event: 'onClick', actionId: acts.actionId[1] },
        ],
    }, wrap);
    assert.ok(!binds.error, JSON.stringify(binds));
    assert.strictEqual(binds.applied, 2);
    assert.strictEqual(ops.findNode(wrap.def, ids.k1).node.onClick, acts.actionId[0]);
    assert.strictEqual(ops.findNode(wrap.def, ids.k2).node.onClick, acts.actionId[1]);
    assert.strictEqual(validateAppDefinition(wrap.def).ok, true, 'a batched build validates');

    // Back-compat: the single form is unchanged, scalars and all.
    const one = await applyToolCall('app_set_action', { action: { kind: 'toast', message: 'three' } }, wrap);
    assert.strictEqual(typeof one.actionId, 'string');
    assert.strictEqual(one.created, true);
    const bind1 = await applyToolCall('app_bind_action', { nodeId: ids.k1, event: 'onClick', actionId: one.actionId }, wrap);
    assert.deepStrictEqual(
        { nodeId: bind1.nodeId, event: bind1.event, actionId: bind1.actionId },
        { nodeId: ids.k1, event: 'onClick', actionId: one.actionId },
    );
});

test('batch forms: cap, empty, both-forms and all-failed are refused cleanly', async () => {
    const { MAX_BATCH_PATCHES_PER_CALL, MAX_COMPONENTS_PER_CALL } = require('./builderTools/schemas');
    assert.strictEqual(MAX_BATCH_PATCHES_PER_CALL, MAX_COMPONENTS_PER_CALL, 'ONE batching ceiling across the surface');
    const wrap = freshWrap();
    const { ids } = await applyToolCall('app_add_components', {
        parentId: homeSectionId(wrap),
        components: [{ tempId: 'a', type: 'button', props: { label: 'A' } }],
    }, wrap);

    const over = await applyToolCall('app_update_component', {
        updates: Array.from({ length: MAX_BATCH_PATCHES_PER_CALL + 1 }, () => ({ id: ids.a, style: { span: 3 } })),
    }, wrap);
    assert.match(over.error, new RegExp(`max ${MAX_BATCH_PATCHES_PER_CALL}`));

    assert.match((await applyToolCall('app_update_component', { updates: [] }, wrap)).error, /empty/);
    assert.match((await applyToolCall('app_bind_action', { bindings: 'nope' }, wrap)).error, /must be an array/);
    // Both forms naming the SAME component is read as the batch (2026-09-14); only a disagreement refuses.
    const both = await applyToolCall('app_update_component', { id: ids.a, updates: [{ id: ids.a, style: { span: 4 } }] }, wrap);
    assert.ok(!both.error, JSON.stringify(both));
    assert.ok(both._hints.some((h) => /both given — read as the updates batch/.test(h)));
    assert.match(
        (await applyToolCall('app_update_component', { id: ids.a, updates: [{ id: 'cmp_other_1' }] }, wrap)).error,
        /EITHER the single form/,
    );

    const allBad = await applyToolCall('app_update_component', { updates: [{ id: 'cmp_x' }, { id: 'cmp_y' }] }, wrap);
    assert.match(allBad.error, /All 2 component update\(s\) failed/);
    assert.strictEqual(allBad.failed.length, 2);
    assert.deepStrictEqual(allBad.failed.map((f) => f.index), [0, 1]);
});

test('the batch forms are declared in the schemas, capped in prose, and reachable', () => {
    const { MAX_BATCH_PATCHES_PER_CALL } = require('./builderTools/schemas');
    for (const [name, key] of [['app_update_component', 'updates'], ['app_set_action', 'actions'], ['app_bind_action', 'bindings']]) {
        const p = toolProps(name);
        assert.ok(p[key], `${name} declares its ${key} batch form`);
        assert.strictEqual(p[key].type, 'array');
        assert.ok(p[key].description.includes(`up to ${MAX_BATCH_PATCHES_PER_CALL}`), `${name} teaches the cap it enforces`);
        // The single form must stay legal, so the top level can no longer
        // require its scalar fields — the per-item shape carries them instead.
        const schema = TOOL_SCHEMAS.find((t) => t.function.name === name);
        assert.strictEqual(schema.function.parameters.required, undefined, `${name} accepts either form`);
        assert.ok(Array.isArray(p[key].items.required) && p[key].items.required.length, `${name} batch items still require their key fields`);
    }
});

/**
 * A patch batch is PARTIAL, and that has a consequence the flat id array cannot
 * express: with entry 1 rejected, `actionId` is [entry0, entry2] — position N is
 * no longer entry N. A model that reads it positionally to build the follow-up
 * app_bind_action batch wires the WRONG action onto the button, and every
 * validator passes because both ids are real. `actions[].index` is the honest
 * pairing; this pins both the shape and the schema text that points at it.
 */
test('app_set_action batch: ids are paired by index, and the schema says so', async () => {
    const wrap = freshWrap();
    const r = await applyToolCall('app_set_action', {
        actions: [
            { action: { kind: 'toast', message: 'first' } },
            { action: { kind: 'no_such_kind' } },
            { action: { kind: 'toast', message: 'third' } },
        ],
    }, wrap);

    assert.strictEqual(r.applied, 2);
    assert.deepStrictEqual(r.failed.map((f) => f.index), [1], 'the caller learns exactly which entry failed');
    // The flat array is the SUCCESSES packed together — not entry-aligned.
    assert.strictEqual(r.actionId.length, 2);
    assert.deepStrictEqual(r.actions.map((a) => a.index), [0, 2], 'the index survives the gap');
    assert.strictEqual(wrap.def.actions[r.actions[1].actionId].message, 'third',
        'the id filed under index 2 really is the third entry\'s action');
    assert.notStrictEqual(r.actionId[1], r.actions[0].actionId);

    // …and the tool description must not promise the alignment it cannot keep.
    const desc = toolProps('app_set_action').actions.description;
    assert.match(desc, /actions` array pairs every real id with the `index`/, 'the schema points at the index pairing');
    assert.ok(!/holds the real ids in that order/.test(desc), 'the old positional promise is gone');
});

test('the component-entry schema declares every field the tool layer accepts', () => {
    const { _test } = require('./builderTools');
    const item = toolProps('app_add_components').components.items.properties;
    for (const field of _test.NODE_AUTHORABLE_FIELDS) {
        assert.ok(item[field], `app_add_components entry declares ${field}`);
        assert.ok(toolProps('app_update_component')[field], `app_update_component declares ${field}`);
    }
    // The legal-key list the drop hint prints IS the schema's key list.
    assert.deepStrictEqual(
        [...Object.keys(item)].sort(),
        [..._test.COMPONENT_ENTRY_KEYS].sort(),
        'the schema and the accepted-entry-key set drifted',
    );
});

/**
 * The rest of the echo audit, as a test rather than a claim. The id-returning
 * tools build their echo from the PRE-canonicalize def, which is only safe
 * because ops mints ids that canonId keeps verbatim. Pin that: every id a
 * mutating tool hands back must resolve in the definition it adopted, or the
 * model is being given a handle to something that is not there.
 */
test('every id a mutating tool returns resolves in the ADOPTED definition', async () => {
    const wrap = freshWrap();

    const screen = await applyToolCall('app_add_screen', { name: 'Reports' }, wrap);
    assert.ok(ops.findScreen(wrap.def, screen.screenId), 'screenId resolves after adoption');
    assert.ok(ops.findSection(wrap.def, screen.sectionId), 'sectionId resolves after adoption');

    const section = await applyToolCall('app_add_section', { screenId: screen.screenId }, wrap);
    assert.ok(ops.findSection(wrap.def, section.sectionId), 'added sectionId resolves');

    const added = await applyToolCall('app_add_components', {
        parentId: section.sectionId,
        components: [{ tempId: 'c', type: 'card', children: [{ tempId: 'in', type: 'text', props: { text: 'x' } }] }],
    }, wrap);
    for (const [tempId, id] of Object.entries(added.ids)) {
        assert.ok(ops.findNode(wrap.def, id), `tempId ${tempId} → ${id} resolves`);
    }
    for (const row of added.added) assert.ok(ops.findNode(wrap.def, row.id), `added ${row.id} resolves`);

    const action = await applyToolCall('app_set_action', { action: { kind: 'toast', message: 'hi' } }, wrap);
    assert.ok(ops.findAction(wrap.def, action.actionId), 'actionId resolves');

    const moved = await applyToolCall('app_move_node', { id: added.ids.c, toParentId: screen.sectionId }, wrap);
    assert.ok(ops.findNode(wrap.def, moved.moved), 'moved id still resolves');
    assert.strictEqual(ops.findNode(wrap.def, moved.moved).parent.id, moved.toParentId, 'and it is where the echo says');
});

// ── Nav groups ──────────────────────────────────────────────────────
//
// The nav's headings (what "mega" renders as dropdowns) were editable in the
// Studio UI but reachable from no tool, so a builder could pick the STYLE and
// then not group anything — leaving screens loose beside the groups.

test('app_set_nav_groups groups screens, mints missing ids and keeps the order', async () => {
    const wrap = freshWrap();
    const a = await applyToolCall('app_add_screen', { name: 'Reports' }, wrap);
    const b = await applyToolCall('app_add_screen', { name: 'Shop floor' }, wrap);

    const r = await applyToolCall('app_set_nav_groups', {
        groups: [{ label: 'Insight', icon: 'BarChart3', screens: [a.screenId, b.screenId] }],
    }, wrap);

    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(wrap.def.nav.groups.length, 1);
    const group = wrap.def.nav.groups[0];
    assert.match(group.id, /^nvg_/, 'an id is minted when none is given');
    assert.strictEqual(group.label, 'Insight');
    assert.strictEqual(group.icon, 'BarChart3');
    assert.deepStrictEqual(group.screens, [a.screenId, b.screenId], 'the order given is the order shown');
});

test('app_set_nav_groups replaces the whole list, so moving a screen is ONE call', async () => {
    const wrap = freshWrap();
    const a = await applyToolCall('app_add_screen', { name: 'Reports' }, wrap);
    const b = await applyToolCall('app_add_screen', { name: 'Shop floor' }, wrap);
    await applyToolCall('app_set_nav_groups', {
        groups: [
            { id: 'nvg_insight', label: 'Insight', screens: [a.screenId] },
            { id: 'nvg_admin', label: 'Admin', screens: [b.screenId] },
        ],
    }, wrap);

    await applyToolCall('app_set_nav_groups', {
        groups: [{ id: 'nvg_insight', label: 'Insight', screens: [a.screenId, b.screenId] }],
    }, wrap);

    assert.strictEqual(wrap.def.nav.groups.length, 1, 'the emptied group is gone');
    assert.deepStrictEqual(wrap.def.nav.groups[0].screens, [a.screenId, b.screenId]);
    assert.strictEqual(wrap.def.nav.groups[0].id, 'nvg_insight', 'a supplied id is preserved across edits');
});

test('app_set_nav_groups names the screens left loose rather than failing on them', async () => {
    const wrap = freshWrap();
    const a = await applyToolCall('app_add_screen', { name: 'Reports' }, wrap);
    await applyToolCall('app_add_screen', { name: 'Forgotten' }, wrap);

    const r = await applyToolCall('app_set_nav_groups', {
        groups: [{ label: 'Insight', screens: [a.screenId] }],
    }, wrap);

    assert.ok(!r.error);
    assert.ok(Array.isArray(r.ungroupedScreens), 'the omission is reported');
    assert.ok(r.ungroupedScreens.length >= 1, 'the forgotten screen is named');
    assert.ok(!r.ungroupedScreens.includes(a.screenId));
});

test('app_set_nav_groups reports the canonicalizer repairs instead of silently applying them', async () => {
    const wrap = freshWrap();
    const a = await applyToolCall('app_add_screen', { name: 'Reports' }, wrap);
    const r = await applyToolCall('app_set_nav_groups', {
        groups: [
            { label: 'Insight', screens: [a.screenId, 'scr_nope'] },
            { label: 'Empty', screens: ['scr_alsonope'] },
            { label: 'Dup', screens: [a.screenId] },
        ],
    }, wrap);

    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(wrap.def.nav.groups.length, 1, 'groups left with nothing in them are dropped');
    assert.deepStrictEqual(wrap.def.nav.groups[0].screens, [a.screenId], 'a screen renders in ONE nav place');
    const hints = (r._hints || []).join(' ');
    assert.match(hints, /scr_nope/, 'the unknown screen is named');
    assert.match(hints, /more than one nav group|duplicate/i, 'and so is the duplicate');
});

test('app_set_nav_groups with null ungroups everything', async () => {
    const wrap = freshWrap();
    const a = await applyToolCall('app_add_screen', { name: 'Reports' }, wrap);
    await applyToolCall('app_set_nav_groups', { groups: [{ label: 'Insight', screens: [a.screenId] }] }, wrap);
    assert.ok(wrap.def.nav.groups);

    const r = await applyToolCall('app_set_nav_groups', { groups: null }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(!wrap.def.nav?.groups, 'no groups left');

    const bad = await applyToolCall('app_set_nav_groups', { groups: 'Insight' }, wrap);
    assert.ok(bad.error, 'anything but an array or null is rejected');
});

test('app_set_nav_groups is a mutating tool and is on the advertised schema list', () => {
    assert.ok(MUTATING_TOOLS.has('app_set_nav_groups'), 'a nav change must bump the draft like any other edit');
    const schema = TOOL_SCHEMAS.find((t) => t.function?.name === 'app_set_nav_groups');
    assert.ok(schema, 'the model can actually see the tool');
    assert.deepStrictEqual(schema.function.parameters.required, ['groups']);
});

// ── app_link_datatable + the linked-table guards ─────────────────────────
//
// A LINKED table keeps its rows in a Studio datatable (a Nextcloud mirror a
// automation fills). The link tool resolves it by name and copies its fields;
// every other data tool must refuse to seed / evolve / dataset it — a small
// model that can seed WILL seed a linked table, and on a readwrite link that
// is fictional invoices in the customer's Nextcloud.

const { applyLinkDatatable } = require('./builderTools/linkTools');
const { resolveLinkableDatatable, describeLinkedTables, overlayLinkedRowCounts, projectLinkedTable } = require('./linkedTables');

const FACTUREN_FIELDS = [
    { id: 'fld_nc1dat', key: 'datum', type: 'date', name: 'Datum' },
    { id: 'fld_nc2txt', key: 'leverancier', type: 'text', name: 'Leverancier' },
    { id: 'fld_nc3txt', key: 'factuurnummer', type: 'text', name: 'Factuurnummer' },
    { id: 'fld_nc4num', key: 'excl_btw', type: 'number', name: 'Excl. btw' },
    { id: 'fld_nc5num', key: 'btw', type: 'number', name: 'Btw' },
    { id: 'fld_nc6num', key: 'totaal', type: 'number', name: 'Totaal' },
];
const ORG = { kind: 'org', id: 'orgA' };
function fakeDatatables(rows) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
        datatableStore: {
            async listDatatablesForScope(scope) { return scope.kind === 'org' ? rows : []; },
            async getDatatable(id, scope) { return scope.kind === 'org' ? (byId.get(id) || null) : null; },
            async getTableMeta(scope, id) { const dt = byId.get(id); return dt ? { id, key: dt.key, name: dt.name, fields: dt._fields || [] } : null; },
            async listGrants() { return []; },
        },
        access: {
            async resolveDatatablePrincipalForUser(userId) { return { userId, orgId: 'orgA', organizationId: 'orgA', orgRole: 'member', groupIds: [] }; },
            datatableScopesFor: () => [ORG, { kind: 'user', id: 'u1' }],
            gradeForPrincipal: (table) => table._grade === undefined ? 'viewer' : table._grade,
            gradeAtLeast: (g, min) => ({ viewer: 0, editor: 1, owner: 2 }[g] ?? -1) >= ({ viewer: 0, editor: 1, owner: 2 }[min]),
        },
    };
}
const FACTUREN = { id: 'tbl_fact0001', key: 'facturen', name: 'Facturen', rowCount: 57, managedKind: 'nextcloud_table', syncState: { lastSyncAt: '2026-09-13T08:00:00Z', status: 'ok' }, _fields: FACTUREN_FIELDS, _grade: 'editor' };
const KLANTEN = { id: 'tbl_klant001', key: 'klanten', name: 'Klanten', rowCount: 3, managedKind: null, _fields: [{ id: 'fld_k1', key: 'naam', type: 'text' }] };

test('resolveLinkableDatatable: by id, key, title, title-as-key; ambiguity and misses list what is there', async () => {
    const deps = fakeDatatables([FACTUREN, KLANTEN, { ...KLANTEN, id: 'tbl_klant002', key: 'klanten_2', name: 'klanten' }]);
    assert.strictEqual((await resolveLinkableDatatable({ ownerId: 'u1', datatableId: 'tbl_fact0001' }, deps)).datatable.id, 'tbl_fact0001');
    assert.strictEqual((await resolveLinkableDatatable({ ownerId: 'u1', key: 'FACTUREN' }, deps)).datatable.id, 'tbl_fact0001');
    assert.strictEqual((await resolveLinkableDatatable({ ownerId: 'u1', name: ' facturen ' }, deps)).datatable.id, 'tbl_fact0001');
    assert.strictEqual((await resolveLinkableDatatable({ ownerId: 'u1', name: 'Klanten 2' }, deps)).datatable.id, 'tbl_klant002', 'the key a title would produce');
    const amb = await resolveLinkableDatatable({ ownerId: 'u1', name: 'Klanten' }, deps);
    assert.match(amb.error, /matches 2 Studio tables/);
    assert.strictEqual(amb.candidates.length, 2);
    const miss = await resolveLinkableDatatable({ ownerId: 'u1', name: 'Invoices' }, deps);
    assert.match(miss.error, /No Studio table called "Invoices"/);
    assert.match(miss.error, /"Facturen" \(id tbl_fact0001, key facturen, 57 rows, Nextcloud mirror\)/, 'the miss lists the tables — discovery for a model without a list tool');
    assert.match((await resolveLinkableDatatable({ ownerId: 'u1' }, deps)).error, /Name the Studio table/);
    assert.match((await resolveLinkableDatatable({ ownerId: 'u1', name: 'Facturen', mode: 'write' }, deps)).error, /mode must be one of read, readwrite/);
});

test('resolveLinkableDatatable: no grade → refused; readwrite needs editor; an unreadable identity is an availability error', async () => {
    const noAccess = fakeDatatables([{ ...FACTUREN, _grade: null }]);
    assert.match((await resolveLinkableDatatable({ ownerId: 'u1', name: 'Facturen' }, noAccess)).error, /no access to the Studio table/);
    const viewerOnly = fakeDatatables([{ ...FACTUREN, _grade: 'viewer' }]);
    assert.ok(!(await resolveLinkableDatatable({ ownerId: 'u1', name: 'Facturen', mode: 'read' }, viewerOnly)).error, 'read is fine for a viewer');
    assert.match((await resolveLinkableDatatable({ ownerId: 'u1', name: 'Facturen', mode: 'readwrite' }, viewerOnly)).error, /needs editor access/);
    const broken = fakeDatatables([FACTUREN]);
    broken.access.resolveDatatablePrincipalForUser = async () => { throw new Error('db down'); };
    assert.match((await resolveLinkableDatatable({ ownerId: 'u1', name: 'Facturen' }, broken)).error, /could not be read right now/);
});

test('projectLinkedTable copies field ids and keys verbatim, defaults access to app, and is idempotent on an existing link', () => {
    const model = { tables: [{ id: 'tbl_own', key: 'facturen', fields: [] }] };
    const { table } = projectLinkedTable({ model, datatable: FACTUREN, tableMeta: { fields: FACTUREN_FIELDS }, mode: 'read' });
    assert.match(table.id, /^tbl_/);
    assert.strictEqual(table.key, 'facturen_2', 'a key the app already uses gets a suffix');
    assert.deepStrictEqual(table.fields.map((f) => [f.id, f.key, f.type]), FACTUREN_FIELDS.map((f) => [f.id, f.key, f.type]));
    assert.deepStrictEqual(table.source, { kind: 'datatable', datatableId: 'tbl_fact0001', mode: 'read' });
    assert.deepStrictEqual(table.access, { default: 'app' }, 'mirror rows carry created_by = the linker, so owner scoping would show nothing');
    const again = projectLinkedTable({ model: { tables: [table] }, datatable: FACTUREN, tableMeta: { fields: FACTUREN_FIELDS.slice(0, 3) }, mode: 'readwrite', existing: table });
    assert.strictEqual(again.table.id, table.id, 'same table');
    assert.strictEqual(again.table.key, table.key);
    assert.strictEqual(again.table.fields.length, 3, 'fields refreshed from the source');
    assert.strictEqual(again.table.source.mode, 'readwrite');
});

test('app_link_datatable links Facturen by name, is idempotent, and the data block + counts say linked/live', async () => {
    resetDataState();
    const wrap = dataWrap();
    const deps = fakeDatatables([FACTUREN, KLANTEN]);
    const r = await applyLinkDatatable(wrap, { name: 'Facturen' }, deps);
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(wrap.appId, 'first data mutation created the studio_apps row');
    assert.strictEqual(r.table.key, 'facturen');
    assert.deepStrictEqual(r.table.fields.map((f) => f.key), ['datum', 'leverancier', 'factuurnummer', 'excl_btw', 'btw', 'totaal']);
    assert.deepStrictEqual(r.table.linked, { kind: 'nextcloud', mode: 'read', rowCount: 57 });
    assert.match(r._next, /never seed this table/);
    assert.strictEqual(wrap.dataModel.tables.length, 1);
    assert.deepStrictEqual(wrap.dataModel.tables[0].source, { kind: 'datatable', datatableId: 'tbl_fact0001', mode: 'read' });
    assert.strictEqual(wrap.rowCounts[r.table.id], 57, 'the live count overlays the per-app recount (0)');
    // The data block the model reads names the link's FACTS; the rules are
    // the LINKED TABLES bullet of the system prompt (since 2026-09-17 — the
    // per-table doctrine sentence cost ~200 chars per linked table per turn).
    const { renderDataBlock, buildSystemPrompt } = require('./builderPrompt');
    const block = renderDataBlock(wrap.dataModel, [], wrap.rowCounts, wrap.linkedTables);
    assert.match(block, /rows=57 access=app linked=nextcloud mode=read$/m);
    assert.ok(!block.includes('never app_seed_records'), 'no doctrine on the table line');
    assert.match(buildSystemPrompt({ toolset: 'core', catalogText: 'C' }), /never app_seed_records it, never rewrite its fields with app_upsert_table/);
    assert.match(block, /excl_btw/);
    // Same call again: no second table, fields refreshed, note says so.
    const r2 = await applyLinkDatatable(wrap, { name: 'facturen' }, deps);
    assert.ok(!r2.error, JSON.stringify(r2));
    assert.strictEqual(r2.table.id, r.table.id);
    assert.strictEqual(r2.note, 'already linked — fields refreshed');
    assert.strictEqual(wrap.dataModel.tables.length, 1, 'still one table');
    // Mode change only when asked.
    const r3 = await applyLinkDatatable(wrap, { datatableId: 'tbl_fact0001', mode: 'readwrite' }, deps);
    assert.strictEqual(r3.table.linked.mode, 'readwrite');
    assert.strictEqual(wrap.dataModel.tables[0].source.mode, 'readwrite');
    // The APP's own tbl_ id (read off the draft state on a second turn —
    // measured 2026-09-14 on every retry) names the same link, not a Studio table.
    const r4 = await applyLinkDatatable(wrap, { datatableId: r.table.id }, deps);
    assert.ok(!r4.error, JSON.stringify(r4));
    assert.strictEqual(r4.table.id, r.table.id);
    assert.strictEqual(wrap.dataModel.tables.length, 1, 'still one table');
    assert.ok(r4._hints.some((h) => new RegExp(`"${r.table.id}" is this app's own table for Studio table tbl_fact0001 — read as that link`).test(h)), JSON.stringify(r4._hints));
    const r5 = await applyLinkDatatable(wrap, { name: r.table.id, mode: 'readwrite' }, deps);
    assert.ok(!r5.error, JSON.stringify(r5));
    assert.strictEqual(r5.table.linked.mode, 'readwrite');
});

test('the linked-table guards: no seeding, no field edits, no datasets; name/icon edits still pass', async () => {
    resetDataState();
    const wrap = dataWrap();
    const deps = fakeDatatables([FACTUREN]);
    const link = await applyLinkDatatable(wrap, { name: 'Facturen' }, deps);
    const tableId = link.table.id;
    const seed = await applyToolCall('app_seed_records', { tableId, records: [{ leverancier: 'Fake BV', totaal: 1 }] }, wrap);
    assert.match(seed.error, /LINKED table — its rows live in the Studio table/);
    assert.match(seed._fixHint, /Bind components to/);
    assert.strictEqual(dataState.execCalls.length, 0, 'nothing was written anywhere');
    const evolve = await applyToolCall('app_upsert_table', { tableId, fields: [{ key: 'datum', type: 'date' }, { key: 'status', type: 'text' }] }, wrap);
    assert.match(evolve.error, /columns come from the Studio table/);
    assert.strictEqual(wrap.dataModel.tables[0].fields.length, 6, 'the copy did not drift');
    const rename = await applyToolCall('app_upsert_table', { tableId, name: 'Facturen (live)', icon: 'Receipt' }, wrap);
    assert.ok(!rename.error, JSON.stringify(rename));
    assert.strictEqual(wrap.dataModel.tables[0].name, 'Facturen (live)');
    assert.deepStrictEqual(wrap.dataModel.tables[0].source, { kind: 'datatable', datatableId: 'tbl_fact0001', mode: 'read' }, 'the link survives a rename');
    const ds = await applyToolCall('app_upsert_dataset', { tableId, name: 'Per maand', descriptor: { aggregates: [{ fn: 'sum', field: 'totaal', as: 'total' }] } }, wrap);
    assert.match(ds.error, /Saved datasets cannot read the LINKED table/);
    assert.match(ds._fixHint, /kind:"aggregate"/);
    const create = await applyToolCall('app_upsert_table', { key: 'orders', fields: [{ key: 'a', type: 'text' }], source: { kind: 'datatable', datatableId: 'tbl_guess', mode: 'read' } }, wrap);
    assert.match(create.error, /call app_link_datatable/);
});

test('describeLinkedTables / overlayLinkedRowCounts: live counts, a missing source is reported, own tables untouched', async () => {
    const deps = fakeDatatables([FACTUREN]);
    const model = { tables: [
        { id: 'tbl_a', key: 'facturen', name: 'Facturen', source: { kind: 'datatable', datatableId: 'tbl_fact0001', mode: 'read' }, fields: [] },
        { id: 'tbl_b', key: 'gone', name: 'Gone', source: { kind: 'datatable', datatableId: 'tbl_nope', mode: 'readwrite' }, fields: [] },
        { id: 'tbl_c', key: 'own', name: 'Own', fields: [] },
    ] };
    const linked = await describeLinkedTables(model, 'u1', deps);
    assert.deepStrictEqual([...linked.keys()], ['tbl_a', 'tbl_b']);
    assert.strictEqual(linked.get('tbl_a').rowCount, 57);
    assert.strictEqual(linked.get('tbl_a').managedKind, 'nextcloud_table');
    assert.strictEqual(linked.get('tbl_b').missing, true);
    const counts = overlayLinkedRowCounts({ tbl_a: 0, tbl_b: 0, tbl_c: 4 }, linked);
    assert.deepStrictEqual(counts, { tbl_a: 57, tbl_b: 0, tbl_c: 4 });
    const { renderDataBlock } = require('./builderPrompt');
    const block = renderDataBlock(model, [], counts, linked);
    assert.match(block, /table tbl_b "Gone" key=gone rows=0 access=app linked=MISSING/);
    assert.match(block, /table tbl_c "Own" key=own rows=4 access=app$/m, 'an own table prints exactly as before');
    assert.strictEqual(renderDataBlock(model, [], counts), renderDataBlock(model, [], counts, null), 'without the 4th argument the block is what it always was');
    assert.deepStrictEqual([...(await describeLinkedTables({ tables: [model.tables[2]] }, 'u1', deps)).keys()], [], 'no linked table → no store call, empty map');
});

test('the five data tools are on the small-model menu (18 tools); the link tool is mutating and data-side', () => {
    const { APP_CORE_TOOL_NAMES } = require('./builderModelProfiles');
    const { DATA_MODEL_TOOLS } = require('./builderTools');
    // 18 since 2026-09-17: app_inspect_catalog (the compact catalog's read tool).
    assert.strictEqual(APP_CORE_TOOL_NAMES.size, 18);
    assert.ok(APP_CORE_TOOL_NAMES.has('app_inspect_catalog'));
    for (const name of ['app_link_datatable', 'app_query_data', 'app_set_plan', 'app_upsert_table', 'app_seed_records']) {
        assert.ok(APP_CORE_TOOL_NAMES.has(name), `${name} on the core menu — 2026-09-13: without the creators a small model invented tbl_ ids for a whole turn`);
    }
    assert.ok(MUTATING_TOOLS.has('app_link_datatable') && DATA_MODEL_TOOLS.has('app_link_datatable'));
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === 'app_link_datatable');
    assert.match(schema.function.description, /Never seed a linked table/);
    assert.match(TOOL_SCHEMAS.find((t) => t.function.name === 'app_upsert_table').function.description, /app_link_datatable/);
});

test('app_inspect_catalog reads a type name the way app_add_components does: aliases and spaced spellings answer under the real type', async () => {
    // Before 2026-09-18 "datatable" got did-you-mean "table" (the static
    // one) while the add tool builds a data_grid from it — a round lost, and
    // a pointer to the wrong type.
    const wrap = freshWrap();
    const r = await applyToolCall('app_inspect_catalog', { components: ['data grid', 'datatable', 'page-header', 'nope'] }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r.components), ['data_grid', 'page_header'], 'keyed by the resolved type, once');
    assert.match(r.components.data_grid, /^data_grid \[Data\]/);
    assert.ok(r._hints.some((h) => /"datatable" is data_grid/.test(h) && /"data grid" is data_grid/.test(h) && /"page-header" is page_header/.test(h)), JSON.stringify(r._hints));
    assert.deepStrictEqual(r.unknown, ['nope is not a component type — did you mean "form"?'], 'the did-you-mean is for what does not resolve at all');
    const plain = await applyToolCall('app_inspect_catalog', { components: ['data_grid'] }, wrap);
    assert.ok(!plain._hints, 'a real type name is not read as anything');
});

// ── app_add_components: normalise → guard → build ───────────────────────
// The fast local model's near-misses, repaired before the build instead of
// costing a round: the root key app_add_screen's result uses (sectionId), a
// type name that is not a type (kpi), a prop beside props. Each repair is a
// note on the success result.
test('app_add_components repairs sectionId/kpi/stray props and says so; a real typo still gets the Dropped hint', async () => {
    const wrap = freshWrap();
    const sectionId = homeSectionId(wrap);
    const r = await applyToolCall('app_add_components', {
        sectionId,
        items: [
            { type: 'kpi', label: 'Totaal', props: { value: 12 }, style: { span: 3 } },
            { type: 'heading', props: { text: 'Hi' }, colour: 'red' },
        ],
    }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.added.map((a) => a.type), ['stat', 'heading']);
    const stat = ops.findNode(wrap.def, r.added[0].id).node;
    assert.strictEqual(stat.props.label, 'Totaal', 'the stray label was hoisted into props');
    assert.deepStrictEqual(stat.props.value, { kind: 'static', value: 12 }, 'the canonicalizer wraps the literal as always');
    const hints = r._hints.join('\n');
    assert.match(hints, /"sectionId" read as parentId/);
    assert.match(hints, /"items" read as components/);
    assert.match(hints, /components\[0\]: type "kpi" read as "stat"/);
    assert.match(hints, /components\[0\]: "label" was placed next to props — moved inside props/);
    assert.match(hints, /components\[1\]: Dropped unknown entry keys: colour/, 'a key no spec declares is still reported, never hoisted');
    // The batch shape rule stays: a garbled call names the corruption.
    const garbled = await applyToolCall('app_add_components', { parentId: sectionId, components: [{ type: 'text}}},props:{', props: {} }] }, wrap);
    assert.match(garbled.error, /components\[0\] arrived corrupted — its "type" arrived as JSON debris/);
    assert.match(garbled.error, /The call's JSON arrived corrupted \(punctuation inside a string value\)/);
});

test('app_update_component refuses a props patch that names a field the table does not have', async () => {
    const wrap = freshWrap();
    wrap.dataModel = { modelVersion: 1, tables: [{ id: 'tbl_t', key: 't', name: 'T', fields: [{ id: 'fld_a', key: 'amount', type: 'number', required: false, unique: false }], access: { default: 'app', roles: {}, rowFilters: {} } }], roles: [], roleMapping: { default: 'app', byGroup: {} } };
    const added = await applyToolCall('app_add_components', { parentId: homeSectionId(wrap), components: [{ type: 'data_grid', props: { data: { kind: 'records', tableId: 'tbl_t' } } }] }, wrap);
    assert.ok(!added.error, JSON.stringify(added));
    const bad = await applyToolCall('app_update_component', { id: added.added[0].id, props: { data: { kind: 'records', tableId: 'tbl_t', sort: [{ field: 'Amount' }] } } }, wrap);
    assert.match(bad.error, /names field "Amount", which table tbl_t \(t\) does not have/);
    assert.match(bad.error, /Did you mean "amount"\?/);
    const good = await applyToolCall('app_update_component', { id: added.added[0].id, props: { data: { kind: 'records', tableId: 'tbl_t', sort: [{ field: 'amount' }] } } }, wrap);
    assert.ok(!good.error, JSON.stringify(good));
});

test('app_set_action refuses an exact duplicate and points at the existing action', async () => {
    const wrap = freshWrap();
    const screen = await applyToolCall('app_add_screen', { name: 'Detail' }, wrap);
    const first = await applyToolCall('app_set_action', { action: { kind: 'navigate', screenId: screen.screenId } }, wrap);
    assert.ok(first.actionId && first.created, JSON.stringify(first));
    const dup = await applyToolCall('app_set_action', { action: { kind: 'navigate', screenId: screen.screenId } }, wrap);
    assert.match(dup.error, new RegExp(`already has action "${first.actionId}" with exactly this definition`));
    assert.strictEqual(dup.actionId, first.actionId);
    assert.strictEqual(Object.keys(wrap.def.actions).length, 1, 'no second copy');
    // A different action, or an update of the same one, is fine.
    const other = await applyToolCall('app_set_action', { action: { kind: 'toast', message: 'Hi' } }, wrap);
    assert.ok(!other.error, JSON.stringify(other));
    const upd = await applyToolCall('app_set_action', { actionId: first.actionId, action: { kind: 'navigate', screenId: screen.screenId, params: { id: { kind: 'formula', expr: 'item.id' } } } }, wrap);
    assert.ok(!upd.error && upd.updated, JSON.stringify(upd));
});

test('app_set_action refuses an automation the owner does not have when the route attached the list', async () => {
    const wrap = freshWrap();
    wrap._ownedAutomations = new Map([['auto-1', { isActive: true }]]);
    const bad = await applyToolCall('app_set_action', { action: { kind: 'run_automation', automationId: 'auto-guess' } }, wrap);
    assert.match(bad.error, /references automation "auto-guess" which the owner does not have/);
    const good = await applyToolCall('app_set_action', { action: { kind: 'run_automation', automationId: 'auto-1' } }, wrap);
    assert.ok(!good.error, JSON.stringify(good));
});

// ── The repeat ladder, rung 2: an identical resend gets the attached fix ──
// The small local model cannot edit one field of a call it already sent — it
// resends it byte-identical. When the rejection knew the exact fix (the
// binding guard's did-you-mean), the resend is repaired server-side.
test('a guard refusal carries a _suggestedPatch; the identical resend is repaired and lands', async () => {
    const wrap = freshWrap();
    wrap.dataModel = { modelVersion: 1, tables: [{ id: 'tbl_f', key: 'facturen', name: 'Facturen', fields: [{ id: 'fld_1', key: 'excl_btw', type: 'number', required: false, unique: false }, { id: 'fld_2', key: 'datum', type: 'date', required: false, unique: false }], access: { default: 'app', roles: {}, rowFilters: {} } }], roles: [], roleMapping: { default: 'app', byGroup: {} } };
    const args = {
        parentId: homeSectionId(wrap),
        components: [
            { type: 'stat', props: { label: 'Totaal', value: { kind: 'aggregate', tableId: 'tbl_f', aggregates: [{ fn: 'sum', field: 'Excl. btw', as: 'total' }], pick: { row: 'first', column: 'total' } } } },
            { type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_f', sort: [{ field: 'Datum', dir: 'desc' }] } } },
        ],
    };
    const first = await applyToolCall('app_add_components', structuredClone(args), wrap);
    assert.match(first.error, /2 data references in components would fail at run time/);
    assert.deepStrictEqual(first._suggestedPatch, {
        ops: [
            { op: 'set', path: 'components[0].props.value.aggregates[0].field', value: 'excl_btw' },
            { op: 'set', path: 'components[1].props.source.sort[0].field', value: 'datum' },
        ],
        why: 'the did-you-mean keys, applied in place',
    });
    assert.match(first._fixHint, /A ready-made patch is attached as _suggestedPatch/);
    assert.strictEqual(first._repeated, undefined);
    // The byte-identical resend (keys in another order still count as identical).
    const reordered = { components: structuredClone(args.components), parentId: args.parentId };
    const second = await applyToolCall('app_add_components', reordered, wrap);
    assert.ok(!second.error, JSON.stringify(second));
    assert.strictEqual(second.added.length, 2);
    assert.deepStrictEqual(second._autoRepaired, [
        'components[0].props.value.aggregates[0].field = "excl_btw"',
        'components[1].props.source.sort[0].field = "datum"',
    ]);
    assert.match(second._hints[0], /Your resend was identical, so the fix the error named was applied/);
    const stat = ops.findNode(wrap.def, second.added[0].id).node;
    assert.strictEqual(stat.props.value.aggregates[0].field, 'excl_btw', 'the landed node carries the repaired key');
    assert.strictEqual(wrap._lastRejected, null, 'a successful mutation clears the ladder');
});

test('a refusal without a mechanical fix climbs the plain ladder: named on the 2nd resend, stopped on the 3rd', async () => {
    const wrap = freshWrap();
    const bad = { parentId: 'sec_nope', components: [{ type: 'heading', props: { text: 'x' } }] };
    const r1 = await applyToolCall('app_add_components', structuredClone(bad), wrap);
    assert.match(r1.error, /Unknown parentId/);
    assert.strictEqual(r1._suggestedPatch, undefined);
    const r2 = await applyToolCall('app_add_components', structuredClone(bad), wrap);
    assert.strictEqual(r2._repeated, 2);
    assert.match(r2._fixHint, /SAME call as your previous attempt \(2 times now\)/);
    const r3 = await applyToolCall('app_add_components', structuredClone(bad), wrap);
    assert.strictEqual(r3._repeated, 3);
    assert.match(r3._fixHint, /Stop retrying: tell the user/);
});

test('an untouched default Home is reused by the first screen a build adds, and an empty Home left beside real screens is dropped at finalize', async () => {
    resetDataState();
    // Reuse: the first add renames Home; the app never shows a blank page.
    const wrap = freshWrap();
    const home = wrap.def.screens[0].id;
    const r1 = await applyToolCall('app_add_screen', { name: 'Overzicht', icon: 'Gauge' }, wrap);
    assert.strictEqual(r1.screenId, home);
    assert.strictEqual(r1.reusedHome, true);
    assert.match(r1._hints.join(' '), /The empty "Home" screen became "Overzicht"/);
    assert.deepStrictEqual(wrap.def.screens.map((s) => [s.name, s.icon]), [['Overzicht', 'Gauge']]);
    assert.strictEqual(wrap.def.homeScreenId, home);
    // Not reused once something sits on it, or when the add is itself "Home".
    const wrap2 = freshWrap();
    await applyToolCall('app_add_components', { parentId: wrap2.def.screens[0].sections[0].id, components: [{ type: 'heading', props: { text: 'x' } }] }, wrap2);
    const r2 = await applyToolCall('app_add_screen', { name: 'Overzicht' }, wrap2);
    assert.ok(!r2.reusedHome);
    assert.strictEqual(wrap2.def.screens.length, 2);
    // Finalize: an empty Home beside real screens goes (a pre-2026-09-14 draft, or a Home the model never touched).
    const { dropEmptyDefaultHome } = require('./builderTools/persistence');
    const def = { ...wrap2.def, screens: [{ ...wrap2.def.screens[0], sections: [{ id: 'sec_e', children: [] }] }, wrap2.def.screens[1]] };
    const dropped = dropEmptyDefaultHome(def);
    assert.strictEqual(dropped.removed.id, wrap2.def.screens[0].id);
    assert.deepStrictEqual(dropped.def.screens.map((s) => s.name), ['Overzicht']);
    assert.strictEqual(dropped.def.homeScreenId, wrap2.def.screens[1].id, 'home moves to the real screen');
    // …but never when an action navigates to it.
    const withNav = { ...def, actions: { act_1: { kind: 'navigate', screenId: def.screens[0].id } } };
    assert.strictEqual(dropEmptyDefaultHome(withNav).removed, null);
});
