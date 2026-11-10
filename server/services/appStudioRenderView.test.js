/**
 * app_screenshot's view (appStudioRenderView.mts): the request checked against the
 * definition and turned into what the data pass and the page need, and its way through
 * renderAppScreenshot (payload, document, capture target, data keys). Browser- and DB-free:
 * the capture and the reads are injected, like appStudioRender.test.js does.
 *
 * Run: node --test services/appStudioRenderView.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeAppDefinition } = require('../appStudio/canonicalize');
const { canonicalizeDataModel } = require('../appStudio/dataModel');
const { resolveRenderView, screenshotPayload, viewDefinition, screenNodes } = require('./appStudioRenderView.mts');
const { renderAppScreenshot, _test } = require('./appStudioRender');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const APP = { id: 'app1', userId: 'owner-9' };

function appDef() {
    return canonicalizeAppDefinition({
        meta: { name: 'View app' }, homeScreenId: 'scr_view01', theme: {},
        variables: [{ name: 'status', type: 'text', default: 'open' }, { name: 'limit', type: 'number', default: 5 }],
        screens: [{
            id: 'scr_view01', name: 'Home',
            sections: [{
                id: 'sec_view01', style: {}, children: [
                    { id: 'cmp_table1', type: 'table', props: { source: { kind: 'records', tableId: 'tbl_task01', filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.status' } }] } } },
                    { id: 'cmp_tabs01', type: 'tabs', props: {}, children: [
                        { id: 'cmp_tab001', type: 'tab', props: { label: 'One' }, children: [] },
                        { id: 'cmp_tab002', type: 'tab', props: { label: 'Two' }, children: [] },
                    ] },
                    { id: 'cmp_modal1', type: 'modal', props: { title: 'Edit' }, children: [{ id: 'cmp_mhead1', type: 'heading', props: { text: 'In' } }] },
                    { id: 'cmp_form01', type: 'form', props: { name: 'order' }, children: [{ id: 'cmp_input1', type: 'input_text', props: { name: 'customer', label: 'Customer' } }] },
                ],
            }],
        }],
        actions: {},
    }).def;
}

const MODEL = canonicalizeDataModel({
    tables: [{ id: 'tbl_task01', key: 'tasks', name: 'Tasks', access: { default: 'app' }, fields: [{ id: 'fld_st01', key: 'status', type: 'text' }] }],
    roles: [],
}).model;

const screenOf = (def) => def.screens[0];

test('no view, or an empty one, asks for nothing', () => {
    const def = appDef();
    const r = resolveRenderView({}, def, screenOf(def));
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { chrome: false, vars: null, forms: null, screenParams: null, initialUi: null, openModal: null, appearance: null, hostTheme: null, nodeId: null });
    assert.deepEqual(screenshotPayload(r.value), {});
});

test('state becomes the page start state: vars coerced, a tab group, an open modal, form values', () => {
    const def = appDef();
    const r = resolveRenderView({
        chrome: true,
        state: { vars: { status: 'done', limit: '12' }, screenParams: { id: 'r7' }, forms: { order: { customer: 'Acme' } }, openModal: 'cmp_modal1', activeTab: 'cmp_tab002' },
    }, def, screenOf(def));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value.vars, { status: 'done', limit: 12 });
    assert.deepEqual(r.value.initialUi, { cmp_form01: { values: { customer: 'Acme' } }, cmp_modal1: { open: true }, cmp_tabs01: { activeTab: 'cmp_tab002' } });
    assert.deepEqual(screenshotPayload(r.value), {
        chrome: true, initialUi: r.value.initialUi, vars: { status: 'done', limit: 12 }, forms: { order: { customer: 'Acme' } }, screenParams: { id: 'r7' },
    });
    assert.equal(r.value.openModal, 'cmp_modal1');
});

test('a wrong id, name or value is a sentence the caller can act on', () => {
    const def = appDef();
    const bad = (view) => resolveRenderView(view, def, screenOf(def));
    assert.match(bad({ state: { vars: { nope: 1 } } }).error, /not a declared variable \(declared: status, limit\)/);
    assert.match(bad({ state: { openModal: 'cmp_table1' } }).error, /not a modal on this screen \(modals here: cmp_modal1\)/);
    assert.match(bad({ state: { activeTab: ['cmp_tab001', 'cmp_zzz'] } }).error, /"cmp_zzz" is not a tab/);
    assert.match(bad({ state: { forms: { other: {} } } }).error, /not a form on this screen \(forms: order\)/);
    assert.match(bad({ state: { forms: { order: { customer: { deep: 1 } } } } }).error, /must be a short text/);
    assert.match(bad({ state: { screenParams: { id: 'x'.repeat(600) } } }).error, /screenParams.id must be/);
    assert.match(bad({ appearance: 'sepia' }).error, /appearance is one of light, dark, auto/);
    assert.match(bad({ hostTheme: 'glass' }).error, /hostTheme is one of light, dark, high-contrast/);
    assert.match(bad({ nodeId: 'cmp_gone' }).error, /not a component on this screen/);
    assert.match(bad({ state: 'open the modal' }).error, /state must be an object/);
});

test('screenNodes walks into containers, tabs and modals', () => {
    const def = appDef();
    const nodes = screenNodes(screenOf(def));
    assert.equal(nodes.get('cmp_mhead1').parent.id, 'cmp_modal1');
    assert.equal(nodes.get('cmp_tab002').parent.id, 'cmp_tabs01');
});

test('viewDefinition forces motion off and applies the appearance, never touching the input', () => {
    const def = appDef();
    const before = JSON.stringify(def);
    const out = viewDefinition(def, { appearance: 'dark' });
    assert.equal(out.design.motion, 'none');
    assert.equal(out.theme.appearance, 'dark');
    assert.equal(viewDefinition(def, null).theme, def.theme);
    assert.equal(JSON.stringify(def), before);
});

function deps(store, extra = {}) {
    return {
        readBundle: async () => ({ js: 'export async function mount() {}', css: '.x{}' }),
        capture: async (args) => { store.push(args); return { png: PNG, mountError: null, consoleErrors: [], pageErrors: [], cropNote: args.target && args.target.nodeId ? 'not visible' : null }; },
        dbQuery: async (_o, _a, _sql, params) => { store.push({ params }); return { rows: [] }; },
        runDataset: async () => ({ rows: [] }),
        getDataset: async () => null,
        ...extra,
    };
}

function payloadOf(doc) {
    const m = doc.match(/<script type="application\/json" id="bf-payload">(.*?)<\/script>/s);
    return JSON.parse(m[1]);
}

test('without a view the page still gets screenshot mode, the still style and a plain <html>', async () => {
    const store = [];
    const r = await renderAppScreenshot({ app: APP, definition: appDef(), model: MODEL, deps: deps(store) });
    assert.equal(r.ok, true);
    const cap = store.find((s) => s.doc);
    assert.ok(cap.doc.includes('\n<html>\n'), 'no data-theme without hostTheme (the pixel script adds its own)');
    assert.ok(cap.doc.includes('animation:none!important'));
    assert.deepEqual(payloadOf(cap.doc).screenshot, {});
    assert.equal(cap.target, null);
    assert.equal(typeof cap.fulfil, 'function');
    assert.ok(!('cropNote' in r));
});

test('a view reaches the document, the capture target and the data keys', async () => {
    const store = [];
    const r = await renderAppScreenshot({
        app: APP, definition: appDef(), model: MODEL, deps: deps(store),
        view: { hostTheme: 'high-contrast', appearance: 'light', nodeId: 'cmp_table1', state: { vars: { status: 'done' }, openModal: 'cmp_modal1' } },
    });
    assert.equal(r.ok, true, r.reason);
    const cap = store.find((s) => s.doc);
    assert.ok(cap.doc.includes('<html data-theme="high-contrast">'));
    const payload = payloadOf(cap.doc);
    assert.equal(payload.definition.theme.appearance, 'light');
    assert.deepEqual(payload.screenshot.vars, { status: 'done' });
    assert.deepEqual(payload.screenshot.initialUi, { cmp_modal1: { open: true } });
    assert.deepEqual(cap.target, { nodeId: 'cmp_table1', fullPage: true });
    // The filter `vars.status` was resolved against the VIEW's value, so the page finds the entry.
    assert.ok(store.some((s) => s.params && s.params.includes('done')), 'the read used state.vars');
    assert.ok(Object.keys(payload.dataState).some((k) => k.includes('"done"')));
    assert.equal(r.cropNote, 'not visible');
});

test('a bad view is refused before the browser is touched', async () => {
    const store = [];
    const r = await renderAppScreenshot({ app: APP, definition: appDef(), model: MODEL, deps: deps(store), view: { nodeId: 'cmp_nope' } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad_view');
    assert.match(r.reason, /not a component on this screen/);
    assert.equal(store.length, 0);
});

test('buildRenderScope lays the view over the seeded defaults', () => {
    const def = appDef();
    const scope = _test.buildRenderScope({ id: 'u' }, def.variables, screenOf(def), { vars: { status: 'x' }, forms: { order: { a: 1 } }, screenParams: { id: 'p' } });
    assert.deepEqual(scope.vars, { status: 'x', limit: 5 });
    assert.deepEqual(scope.forms, { order: { a: 1 } });
    assert.deepEqual(scope.screen.params, { id: 'p' });
});
