/**
 * Unit tests for the App Studio screen renderer (services/appStudioRender.js).
 *
 * Every edge is injected — readBundle (fs), capture (browser), dbQuery /
 * runDataset / getDataset (DB) — so the tests run DB- and browser-free while
 * canonicalize / queryCompiler / rlsGateway / the shared expr engine run for
 * real. The capture fake records the document it was handed, so the happy path
 * asserts on the actual HTML the browser would render.
 *
 * Run: node --test services/appStudioRender.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { canonicalizeAppDefinition } = require('../appStudio/canonicalize');
const { canonicalizeDataModel } = require('../appStudio/dataModel');
const { ROLE_PROBE_VIEWER_ID } = require('../appStudio/appDryRun');
const { renderAppScreenshot, _test } = require('./appStudioRender');

// ── Fixtures ────────────────────────────────────────────────────────

// A real 1×1 PNG so the sharp bounding pass exercises the same buffer type the
// browser hands back.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);
const BUNDLE = { js: 'export async function mount() {}', css: '.bf-app-runtime{color:red}' };
const OWNER = 'owner-9';
const APP = { id: 'app1', userId: OWNER };

/** A one-screen app whose single component's `source` prop is the given binding. */
function appWith(source) {
    const raw = {
        meta: { name: 'Shot app' }, homeScreenId: 'scr_home01', theme: {},
        screens: [{
            id: 'scr_home01', name: 'Home',
            sections: [{ id: 'sec_main01', style: {}, children: [{ id: 'cmp_table1', type: 'table', props: { source } }] }],
        }],
        actions: {},
    };
    return canonicalizeAppDefinition(raw).def;
}

/** A model with a `tasks` table (default `owner` access) + a `member` role. */
function tasksModel(access = { default: 'owner' }) {
    return canonicalizeDataModel({
        tables: [{
            id: 'tbl_task01', key: 'tasks', name: 'Tasks', access,
            fields: [
                { id: 'fld_ti01', key: 'title', type: 'text' },
                { id: 'fld_st01', key: 'status', type: 'select', options: ['todo', 'done'] },
            ],
        }],
        roles: [{ key: 'member', label: 'Member' }],
        roleMapping: { default: 'member', byGroup: {} },
    }).model;
}

function baseDeps(overrides = {}) {
    return {
        readBundle: async () => BUNDLE,
        capture: async () => ({ png: PNG, mountError: null, consoleErrors: [], pageErrors: [] }),
        dbQuery: async () => ({ rows: [] }),
        runDataset: async () => ({ rows: [] }),
        getDataset: async () => null,
        ...overrides,
    };
}

/** A capture fake that records what it was handed and returns a PNG. */
function capturingCapture(store) {
    return async (args) => { store.push(args); return { png: PNG, mountError: null, consoleErrors: [], pageErrors: [] }; };
}

function extractPayload(doc) {
    const m = doc.match(/<script type="application\/json" id="bf-payload">(.*?)<\/script>/s);
    assert.ok(m, 'the payload script tag is present in the document');
    return JSON.parse(m[1]);
}

// ── Fail-soft contract ──────────────────────────────────────────────

test('missing bundle → unavailable with the contract reason', async () => {
    const r = await renderAppScreenshot({
        app: APP, definition: appWith({ kind: 'records', tableId: 'tbl_task01' }), model: tasksModel(),
        deps: baseDeps({ readBundle: async () => null }),
    });
    assert.deepStrictEqual(r, { ok: false, unavailable: true, reason: 'the app runtime bundle is not in this build' });
});

test('browser edge throwing → unavailable with a readable reason, never a throw', async () => {
    const r = await renderAppScreenshot({
        app: APP, definition: appWith({ kind: 'records', tableId: 'tbl_task01' }), model: tasksModel(),
        deps: baseDeps({ capture: async () => { throw new Error('Browser backend unavailable (Docker down)'); } }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.unavailable, true);
    assert.match(r.reason, /Browser backend unavailable/);
});

test('a hung capture hits the hard timeout → unavailable, not a hang', async () => {
    const r = await renderAppScreenshot({
        app: APP, definition: appWith({ kind: 'records', tableId: 'tbl_task01' }), model: tasksModel(),
        deps: baseDeps({ capture: () => new Promise(() => {}), hardTimeoutMs: 50 }),
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.unavailable, true);
    assert.match(r.reason, /timed out/);
});

test('no screens / unknown explicit screen → unavailable (never the wrong screen)', async () => {
    const none = await renderAppScreenshot({ app: APP, definition: { screens: [] }, deps: baseDeps() });
    assert.strictEqual(none.unavailable, true);

    const wrong = await renderAppScreenshot({
        app: APP, definition: appWith({ kind: 'records', tableId: 'tbl_task01' }), model: tasksModel(),
        screenId: 'scr_nope', deps: baseDeps(),
    });
    assert.strictEqual(wrong.ok, false);
    assert.match(wrong.reason, /scr_nope/);
});

test('a capture that produces no png → unavailable (mount error surfaced when known)', async () => {
    const r = await renderAppScreenshot({
        app: APP, definition: appWith({ kind: 'records', tableId: 'tbl_task01' }), model: tasksModel(),
        deps: baseDeps({ capture: async () => ({ png: null, mountError: 'mount is not a function' }) }),
    });
    assert.strictEqual(r.unavailable, true);
    assert.match(r.reason, /mount is not a function/);
});

// ── Happy path ──────────────────────────────────────────────────────

test('happy path: document carries the definition + real pre-resolved data, mount() is wired, PNG returned', async () => {
    const captured = [];
    const rows = [
        { id: 'r1', title: 'Fix the boiler', status: 'todo' },
        { id: 'r2', title: 'Order honey jars', status: 'done' },
    ];
    const def = appWith({ kind: 'records', tableId: 'tbl_task01' });
    const r = await renderAppScreenshot({
        app: APP, definition: def, model: tasksModel(),
        deps: baseDeps({ capture: capturingCapture(captured), dbQuery: async () => ({ rows }) }),
    });

    assert.strictEqual(r.ok, true);
    assert.ok(Buffer.isBuffer(r.png) && r.png.length > 0);
    assert.ok(r.dataUrl.startsWith('data:image/png;base64,'));
    assert.strictEqual(typeof r.width, 'number');
    assert.strictEqual(typeof r.height, 'number');

    assert.strictEqual(captured.length, 1);
    const { doc, assets, viewport } = captured[0];
    assert.deepStrictEqual(viewport, { width: 1280, height: 800 });
    assert.strictEqual(assets['app-runtime.mjs'].body, BUNDLE.js);
    assert.strictEqual(assets['app-runtime.css'].body, BUNDLE.css);
    assert.ok(doc.includes("import { mount } from '/app-runtime.mjs'"));
    assert.ok(doc.includes('href="/app-runtime.css"'));

    const payload = extractPayload(doc);
    // The definition travels verbatim EXCEPT for motion: a screenshot is a
    // still, so the capture must not catch a chart half-drawn (see below).
    assert.deepStrictEqual(payload.definition, { ...def, design: { ...(def.design || {}), motion: 'none' } });
    assert.strictEqual(payload.screenId, 'scr_home01');
    assert.strictEqual(payload.previewRole, null);
    assert.deepStrictEqual(payload.currentUser, { id: OWNER, name: 'App owner', email: null, roleKey: 'owner' });
    // Keyed exactly as the runtime DataContext looks it up (client dataCacheKey).
    const key = 'records:tbl_task01:{"filter":null,"limit":null,"sort":null}';
    assert.ok(payload.dataState[key], `dataState is keyed ${key}; got ${Object.keys(payload.dataState)}`);
    assert.strictEqual(payload.dataState[key].status, 'success');
    assert.deepStrictEqual(payload.dataState[key].result, rows);
});

test('app content containing </script> cannot break out of the payload tag', async () => {
    const captured = [];
    const def = appWith({ kind: 'static', value: '</script><script>alert(1)</script>' });
    const r = await renderAppScreenshot({
        app: APP, definition: def, model: tasksModel(),
        deps: baseDeps({ capture: capturingCapture(captured) }),
    });
    assert.strictEqual(r.ok, true);
    // The escaped JSON still round-trips to the exact original string.
    const payload = extractPayload(captured[0].doc);
    assert.deepStrictEqual(payload.definition, { ...def, design: { ...(def.design || {}), motion: 'none' } });
});

/*
 * A SCREENSHOT IS A STILL.
 *
 * The runtime animates charts in run mode (~1.5s of recharts draw); the capture
 * settles for a fraction of that. So every chart was photographed part-drawn,
 * its line stopping two-thirds of the way across — and a reviewer reading that
 * picture sees truncated data and "fixes" a binding that was never broken.
 */
test('the render forces motion off so charts are never captured half-drawn', async () => {
    const captured = [];
    const def = appWith({ kind: 'static', value: [] });
    def.design = { surface: 'soft', motion: 'full', chartPalette: 'brand' };
    await renderAppScreenshot({
        app: APP, definition: def, model: tasksModel(),
        deps: baseDeps({ capture: capturingCapture(captured) }),
    });
    const payload = extractPayload(captured[0].doc);
    assert.strictEqual(payload.definition.design.motion, 'none');
    // ...and only motion: the rest of the look must still be what will ship.
    assert.strictEqual(payload.definition.design.surface, 'soft');
    assert.strictEqual(payload.definition.design.chartPalette, 'brand');
    // The caller's object is not mutated — the definition it holds is the one
    // it will save.
    assert.strictEqual(def.design.motion, 'full');
});

test('an app with no design block still renders with motion off', async () => {
    const captured = [];
    const def = appWith({ kind: 'static', value: [] });
    delete def.design;
    await renderAppScreenshot({
        app: APP, definition: def, model: tasksModel(),
        deps: baseDeps({ capture: capturingCapture(captured) }),
    });
    assert.deepStrictEqual(extractPayload(captured[0].doc).definition.design, { motion: 'none' });
});

// ── asRole ──────────────────────────────────────────────────────────

test('asRole: rows are read with the ROLE probe viewer, never the owner', async () => {
    const captured = [];
    const queries = [];
    const r = await renderAppScreenshot({
        app: APP, definition: appWith({ kind: 'records', tableId: 'tbl_task01' }), model: tasksModel(),
        asRole: 'member',
        deps: baseDeps({
            capture: capturingCapture(captured),
            dbQuery: async (ownerScope, appId, sql, params) => { queries.push({ ownerScope, sql, params }); return { rows: [] }; },
        }),
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(queries.length, 1);
    // Default 'owner' access → member reads scope 'own' → created_by bound to
    // the synthetic non-owner probe, so owner-seeded rows can never leak in.
    assert.match(queries[0].sql, /created_by/);
    assert.ok(queries[0].params.includes(ROLE_PROBE_VIEWER_ID), JSON.stringify(queries[0].params));
    assert.ok(!queries[0].params.includes(OWNER));

    const payload = extractPayload(captured[0].doc);
    assert.strictEqual(payload.previewRole, 'member');
    assert.strictEqual(payload.currentUser.roleKey, 'member');
    assert.strictEqual(payload.currentUser.id, ROLE_PROBE_VIEWER_ID);
});

test('asRole not in the data model → unavailable (never a misleading owner render)', async () => {
    const r = await renderAppScreenshot({
        app: APP, definition: appWith({ kind: 'records', tableId: 'tbl_task01' }), model: tasksModel(),
        asRole: 'ghost', deps: baseDeps(),
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /"ghost"/);
});

// ── buildDataState (the truthfulness core) ──────────────────────────

function stateArgs(def, overrides = {}) {
    const currentUser = { id: OWNER, name: 'App owner', email: null, roleKey: 'owner' };
    return {
        definition: def, model: tasksModel(), app: APP, screen: def.screens[0],
        roleArg: 'owner', viewer: { id: OWNER, role: 'owner' }, currentUser,
        deps: baseDeps(), ...overrides,
    };
}

test('a formula filter resolves against the same scope mount() will build (currentUser.id → owner)', async () => {
    const queries = [];
    const def = appWith({
        kind: 'records', tableId: 'tbl_task01',
        filter: [{ field: 'created_by', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }],
    });
    const state = await _test.buildDataState(stateArgs(def, {
        deps: baseDeps({ dbQuery: async (o, a, sql, params) => { queries.push({ sql, params }); return { rows: [{ id: 'r1' }] } } }),
    }));
    const keys = Object.keys(state);
    assert.strictEqual(keys.length, 1);
    // The key carries the RESOLVED literal — the same key the renderer computes.
    assert.ok(keys[0].includes(`"value":${JSON.stringify(OWNER)}`), keys[0]);
    assert.ok(queries[0].params.includes(OWNER));
});

test('a formula referencing a per-instance root (item.*) is skipped — no entry, no query', async () => {
    const queries = [];
    const def = appWith({
        kind: 'records', tableId: 'tbl_task01',
        filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'item.status' } }],
    });
    const state = await _test.buildDataState(stateArgs(def, {
        deps: baseDeps({ dbQuery: async () => { queries.push(1); return { rows: [] }; } }),
    }));
    assert.deepStrictEqual(state, {});
    assert.strictEqual(queries.length, 0);
});

test('a required filter that resolves to nothing → no query, no entry (client parity)', async () => {
    const queries = [];
    const def = appWith({
        kind: 'records', tableId: 'tbl_task01',
        filter: [{ field: 'status', op: 'eq', required: true, value: { kind: 'formula', expr: 'vars.missing' } }],
    });
    const state = await _test.buildDataState(stateArgs(def, {
        deps: baseDeps({ dbQuery: async () => { queries.push(1); return { rows: [] }; } }),
    }));
    assert.deepStrictEqual(state, {});
    assert.strictEqual(queries.length, 0);
});

test('a failing binding becomes an error ENTRY (what the live screen shows), not a failed render', async () => {
    const def = appWith({ kind: 'records', tableId: 'tbl_task01' });
    const state = await _test.buildDataState(stateArgs(def, {
        deps: baseDeps({ dbQuery: async () => { throw new Error('relation "tasks" does not exist'); } }),
    }));
    const [entry] = Object.values(state);
    assert.strictEqual(entry.status, 'error');
    assert.match(entry.error, /does not exist/);
});

test('a record binding stores a single object; an unknown table degrades to empty like the live 404', async () => {
    const def = appWith({ kind: 'record', tableId: 'tbl_task01' });
    const state = await _test.buildDataState(stateArgs(def, {
        deps: baseDeps({ dbQuery: async () => ({ rows: [{ id: 'r1' }, { id: 'probe' }] }) }),
    }));
    const [entry] = Object.values(state);
    assert.deepStrictEqual(entry.result, { id: 'r1' }); // limit 1 → the probe row is dropped

    const ghost = appWith({ kind: 'records', tableId: 'tbl_ghost' });
    const ghostState = await _test.buildDataState(stateArgs(ghost));
    assert.deepStrictEqual(Object.values(ghostState)[0].result, []);
});

test('a dataset binding runs through the injected runner under its dataset:<id> key', async () => {
    const raw = {
        meta: { name: 'Shot app' }, homeScreenId: 'scr_home01', theme: {},
        screens: [{
            id: 'scr_home01', name: 'Home',
            sections: [{ id: 'sec_main01', style: {}, children: [{ id: 'cmp_stat01', type: 'stat', props: { label: 'Count', value: { kind: 'dataset', datasetId: 'ds_count01' } } }] }],
        }],
        actions: {},
    };
    const def = canonicalizeAppDefinition(raw).def;
    const state = await _test.buildDataState(stateArgs(def, {
        deps: baseDeps({
            getDataset: async (id) => ({ id, tableId: 'tbl_task01', descriptor: {} }),
            runDataset: async () => ({ rows: [{ n: 7 }] }),
        }),
    }));
    assert.deepStrictEqual(state['dataset:ds_count01'], {
        status: 'success', result: [{ n: 7 }], error: null, errorCode: null,
        errorProvider: null, tableId: null, datasetId: 'ds_count01', connectorId: null,
    });
});

// ── Client key lockstep guard ───────────────────────────────────────

test('dataCacheKey matches the client format byte-for-byte', () => {
    assert.strictEqual(
        _test.dataCacheKey({ kind: 'records', tableId: 'tbl_task01' }),
        'records:tbl_task01:{"filter":null,"limit":null,"sort":null}',
    );
    assert.strictEqual(_test.dataCacheKey({ kind: 'dataset', datasetId: 'ds1' }), 'dataset:ds1');
    // Sorted keys — insertion order must not leak into the key.
    assert.strictEqual(
        _test.dataCacheKey({ kind: 'aggregate', tableId: 't', aggregates: [{ fn: 'count' }], groupBy: 'status' }),
        'aggregate:t:{"aggregates":[{"fn":"count"}],"filter":null,"groupBy":"status","limit":null,"sort":null}',
    );
    assert.strictEqual(_test.dataCacheKey({ kind: 'formula', expr: '1' }), null);
});

test('renderAppScreenshot never throws, even on garbage input', async () => {
    const r = await renderAppScreenshot({});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.unavailable, true);
    assert.strictEqual(typeof r.reason, 'string');
});
