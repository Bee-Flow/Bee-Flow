/**
 * Builder discovery tools — app_get_draft projection, app_find_nodes, and the
 * screen-level visibleToRoles the tool layer used to hide.
 *
 * All three exist for the same reason: on a 500-node app the only way to answer
 * "where is this used" was to pull the whole tree, which is how a builder ends
 * up deleting a table and leaving four dangling bindings behind.
 *
 * Run: cd server && node --test appStudio/builderTools.discovery.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The tools only touch the stores when persisting; these calls are read-only or
// adopt in memory, so a thin stub is enough to keep a DB pool from opening.
const MOCKS = {
    '../../stores/studioAppStore': {
        createStudioApp: async () => ({ id: 'app-1', definitionVersion: 1 }),
        getStudioApp: async () => null,
        saveDefinition: async () => ({ ok: true, version: 2 }),
        syncAppMeta: async () => {},
    },
    '../../stores/automationStore': { getAutomationsForUser: async () => [] },
    '../../stores/userStore': { getUser: async () => ({ id: 'u1' }) },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:builderDiscovery:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /appStudio[\\/]builderTools[\\/][^\\/]+\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { applyToolCall, TOOL_SCHEMAS, MUTATING_TOOLS } = require('./builderTools');
const { emptyDefinition } = require('./componentSpecs');
const { renderDraftState } = require('./builderPrompt');
const ops = require('./definitionOps');

test.after(() => { Module._resolveFilename = originalResolve; });

function freshWrap() {
    return { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_test', def: emptyDefinition('Test app') };
}

/** A two-screen app with a table-bound grid, a chart, and an action on both. */
async function builtWrap() {
    const wrap = freshWrap();
    const home = wrap.def.screens[0];
    const homeSection = home.sections[0].id;

    const act = await applyToolCall('app_set_action', { action: { kind: 'toast', message: 'hi' } }, wrap);
    await applyToolCall('app_add_components', {
        parentId: homeSection,
        components: [
            { tempId: 'grid', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_meas' } } },
            { tempId: 'chart', type: 'chart', props: { source: { kind: 'records', tableId: 'tbl_meas' }, xKey: 'measured_at' } },
            { tempId: 'other', type: 'text', props: { text: 'plain' } },
        ],
    }, wrap);
    const second = await applyToolCall('app_add_screen', { name: 'Labs' }, wrap);
    const added2 = await applyToolCall('app_add_components', {
        parentId: second.sectionId,
        components: [{ tempId: 'labgrid', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_labs' } } }],
    }, wrap);
    await applyToolCall('app_bind_action', { nodeId: added2.ids.labgrid, event: 'onRowClick', actionId: act.actionId }, wrap);
    return { wrap, actionId: act.actionId, secondScreenId: second.screenId, homeScreenId: home.id };
}

// ── app_get_draft: reading part of a large draft ────────────────────

test('a bare app_get_draft renders exactly what it always did', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_get_draft', {}, wrap);
    // Byte-identical to the un-projected renderer — the turn-injected draft
    // state and this tool must never diverge.
    assert.strictEqual(r.draft, renderDraftState(wrap.def));
});

test('section:"actions" returns the actions and nothing else', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_get_draft', { section: 'actions' }, wrap);
    assert.match(r.draft, /^actions:/);
    assert.ok(!r.draft.includes('screen scr_'), 'no screen tree');
    assert.ok(!r.draft.includes('theme primary='), 'no meta');
});

test('section:"meta" returns the app and theme lines only', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_get_draft', { section: 'meta' }, wrap);
    assert.match(r.draft, /^app "Test app"/);
    assert.match(r.draft, /theme primary=/);
    assert.ok(!r.draft.includes('actions:'));
    assert.ok(!r.draft.includes('screen scr_'));
});

test('screenId returns one screen, and implies a screens-only read', async () => {
    const { wrap, secondScreenId } = await builtWrap();
    const r = await applyToolCall('app_get_draft', { screenId: secondScreenId }, wrap);
    assert.ok(r.draft.includes(secondScreenId), 'the asked-for screen is there');
    assert.ok(!r.draft.includes(wrap.def.screens[0].id), 'the other screen is not');
    // Asking for one screen and getting the whole action list back is not what
    // the caller meant.
    assert.ok(!r.draft.includes('actions:'));
});

test('an unknown screenId says so instead of returning an empty string', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_get_draft', { screenId: 'scr_nope' }, wrap);
    assert.match(r.draft, /no screen scr_nope/);
});

test('section:"tables" renders the data block the plain read leaves out', async () => {
    const { wrap } = await builtWrap();
    wrap.dataModel = { tables: [{ id: 'tbl_meas', key: 'measurements', name: 'Measurements', fields: [] }] };
    wrap.rowCounts = { tbl_meas: 12 };

    const r = await applyToolCall('app_get_draft', { section: 'tables' }, wrap);
    assert.match(r.draft, /table tbl_meas/);
    assert.match(r.draft, /rows=12/);
    // ...and the plain read is unchanged: the tables already arrive with the
    // turn-injected state, so adding them there would be pure duplication.
    const plain = await applyToolCall('app_get_draft', {}, wrap);
    assert.ok(!plain.draft.includes('table tbl_meas'));
});

test('an unknown section falls back to the full read rather than erroring', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_get_draft', { section: 'nonsense' }, wrap);
    assert.strictEqual(r.draft, renderDraftState(wrap.def));
});

// ── app_find_nodes ──────────────────────────────────────────────────

test('app_find_nodes is a read tool with an optional-only schema', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === 'app_find_nodes');
    assert.ok(schema, 'schema present');
    assert.ok(!schema.function.parameters.required);
    assert.ok(!MUTATING_TOOLS.has('app_find_nodes'), 'searching must never persist a draft');
});

test('finds every component of a type, across screens', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_find_nodes', { componentType: 'data_grid' }, wrap);
    assert.strictEqual(r.hitCount, 2);
    assert.ok(r.hits.every((h) => h.type === 'data_grid'));
    // Each hit carries enough to act on: the id to edit, and the screen to
    // look at.
    assert.ok(r.hits.every((h) => h.id && h.screenId && h.path));
});

test('finds every component bound to a table — the "safe to delete?" question', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_find_nodes', { tableId: 'tbl_meas' }, wrap);
    const types = r.hits.filter((h) => h.kind === 'component').map((h) => h.type).sort();
    assert.deepStrictEqual(types, ['chart', 'data_grid']);
    assert.ok(r.hits.every((h) => /bound via source/.test(h.why) || h.kind === 'action'));
});

test('finds the components that run an action', async () => {
    const { wrap, actionId } = await builtWrap();
    const r = await applyToolCall('app_find_nodes', { actionId }, wrap);
    const components = r.hits.filter((h) => h.kind === 'component');
    assert.strictEqual(components.length, 1);
    assert.match(components[0].why, /runs action/);
    // The action itself is reported too, so "what is act_x" is one call.
    assert.ok(r.hits.some((h) => h.kind === 'action' && h.id === actionId));
});

test('screenId narrows the search to one screen', async () => {
    const { wrap, secondScreenId } = await builtWrap();
    const all = await applyToolCall('app_find_nodes', { componentType: 'data_grid' }, wrap);
    const one = await applyToolCall('app_find_nodes', { componentType: 'data_grid', screenId: secondScreenId }, wrap);
    assert.strictEqual(all.hitCount, 2);
    assert.strictEqual(one.hitCount, 1);
    assert.strictEqual(one.hits[0].screenId, secondScreenId);
});

test('no matches is an answer, not an error — a speculative check costs nothing', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_find_nodes', { tableId: 'tbl_unused' }, wrap);
    assert.ok(!r.error);
    assert.strictEqual(r.hitCount, 0);
    assert.match(r.note, /Safe to remove/);
});

test('a query with no criteria is refused with a usable hint', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_find_nodes', {}, wrap);
    assert.match(r.error, /at least one of/);
    assert.ok(r._fixHint);
});

test('an unknown component type lists the valid ones instead of returning nothing', async () => {
    const { wrap } = await builtWrap();
    const r = await applyToolCall('app_find_nodes', { componentType: 'graph' }, wrap);
    assert.match(r.error, /Unknown component type/);
    assert.match(r._fixHint, /data_grid/);
});

test('finds an action that touches a table even when no component does', async () => {
    const wrap = freshWrap();
    await applyToolCall('app_set_action', {
        action: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 'tbl_orphan', values: {} }] },
    }, wrap);
    const r = await applyToolCall('app_find_nodes', { tableId: 'tbl_orphan' }, wrap);
    assert.strictEqual(r.hitCount, 1);
    assert.strictEqual(r.hits[0].kind, 'action');
    assert.match(r.hits[0].why, /touches table/);
});

// ── screen.visibleToRoles ───────────────────────────────────────────

test('app_add_screen can gate a screen by role at creation time', async () => {
    const wrap = freshWrap();
    await applyToolCall('app_set_roles', { roles: [{ key: 'admin', name: 'Admin' }, { key: 'member', name: 'Member' }] }, wrap)
        .catch(() => {}); // roles live on the data model; the definition list is what matters below
    const r = await applyToolCall('app_add_screen', { name: 'Admin', visibleToRoles: ['admin'] }, wrap);
    assert.ok(!r.error, JSON.stringify(r).slice(0, 300));
    const screen = ops.findScreen(wrap.def, r.screenId);
    // Canonicalize and validate have always accepted this field; until now no
    // tool could set it, so an admin-only screen was unbuildable by the AI.
    assert.deepStrictEqual(screen.visibleToRoles, ['admin']);
});

test('app_update_screen can set and clear the role gate', async () => {
    const wrap = freshWrap();
    const added = await applyToolCall('app_add_screen', { name: 'Reports' }, wrap);
    await applyToolCall('app_update_screen', { screenId: added.screenId, visibleToRoles: ['admin'] }, wrap);
    assert.deepStrictEqual(ops.findScreen(wrap.def, added.screenId).visibleToRoles, ['admin']);

    await applyToolCall('app_update_screen', { screenId: added.screenId, visibleToRoles: [] }, wrap);
    assert.deepStrictEqual(ops.findScreen(wrap.def, added.screenId).visibleToRoles, []);
});

test('visibleToRoles is declared on both screen tool schemas', () => {
    for (const name of ['app_add_screen', 'app_update_screen']) {
        const props = TOOL_SCHEMAS.find((t) => t.function.name === name).function.parameters.properties;
        assert.ok(props.visibleToRoles, `${name} is missing visibleToRoles`);
        assert.strictEqual(props.visibleToRoles.type, 'array');
    }
});
