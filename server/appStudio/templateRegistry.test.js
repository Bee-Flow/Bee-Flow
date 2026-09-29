/**
 * App Studio — templateRegistry (built-in + captured templates, one list).
 *
 * The point of this module is that four call sites stop caring which KIND of
 * template they got. So the tests are about the seam: ids dispatch correctly,
 * a captured template is invisible to someone outside its organisation, and a
 * store that will not answer degrades to the built-in gallery instead of
 * taking the whole gallery down with it.
 *
 * The captured store is stubbed through the require cache (the house pattern —
 * see templateInstall.test.js) so none of this needs Postgres.
 *
 * Run: cd server && node --test appStudio/templateRegistry.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const state = {
    rows: [],
    byId: {},
    listThrows: false,
    getThrows: false,
};

const realStore = require('../stores/studioAppTemplateStore');

stub('../stores/studioAppTemplateStore', {
    // The two predicates are pure — use the real ones so the test cannot pass
    // against a prefix rule the store no longer has.
    isCapturedTemplateId: realStore.isCapturedTemplateId,
    canRead: realStore.canRead,
    async listTemplatesFor() {
        if (state.listThrows) throw new Error('store down');
        return state.rows;
    },
    async getTemplateById(id) {
        if (state.getThrows) throw new Error('store down');
        return state.byId[id] || null;
    },
});

const registry = require('./templateRegistry');
const builtIn = require('./templates');

const VIEWER = { userId: 'user-1', orgIds: ['org-1'] };

function capturedRow(over = {}) {
    return {
        id: 'utpl_abc123',
        version: 2,
        title: 'Aanvraag automatisering',
        description: 'Captured from a live app',
        category: 'Van je team',
        icon: 'ClipboardList',
        tags: [],
        source: 'captured',
        createdBy: 'user-1',
        organizationId: 'org-1',
        definition: { schemaVersion: 1, screens: [] },
        ...over,
    };
}

test.beforeEach(() => {
    state.rows = [];
    state.byId = {};
    state.listThrows = false;
    state.getThrows = false;
});

// ── The merged list ────────────────────────────────────────────────────────

test('the gallery is the built-ins plus this org\'s captures', async () => {
    state.rows = [capturedRow()];
    const list = await registry.listAvailableTemplates(VIEWER);
    assert.equal(list.length, builtIn.listTemplates().length + 1);
    assert.equal(list[0].source, 'builtin', 'the curated set leads');
    assert.equal(list[list.length - 1].id, 'utpl_abc123');
});

test('every built-in row is tagged with its provenance', async () => {
    const list = await registry.listAvailableTemplates(VIEWER);
    assert.ok(list.length > 0);
    assert.ok(list.every((t) => t.source === 'builtin'),
        'a gallery that cannot say where a template came from cannot label it');
});

test('a store that will not answer costs the captures, never the gallery', async () => {
    state.listThrows = true;
    const list = await registry.listAvailableTemplates(VIEWER);
    assert.equal(list.length, builtIn.listTemplates().length,
        'losing half the gallery beats losing all of it — this is how someone starts an app');
});

// ── Resolution ─────────────────────────────────────────────────────────────

test('a built-in id resolves from code, without touching the store', async () => {
    state.getThrows = true; // would throw if the store were consulted
    const t = await registry.resolveTemplate('app-request-form', VIEWER);
    assert.ok(t);
    assert.equal(t.source, 'builtin');
    assert.ok(t.definition, 'the definition is what the create path clones');
});

test('a utpl_ id resolves from the store', async () => {
    state.byId.utpl_abc123 = capturedRow();
    const t = await registry.resolveTemplate('utpl_abc123', VIEWER);
    assert.ok(t);
    assert.equal(t.version, 2);
    assert.equal(t.source, 'captured');
});

test('a captured template is invisible outside its organisation', async () => {
    state.byId.utpl_abc123 = capturedRow();
    const outsider = { userId: 'user-9', orgIds: ['org-other'] };
    assert.equal(await registry.resolveTemplate('utpl_abc123', outsider), null,
        'an org-scoped template must not install for someone who cannot see it');
});

test('a private capture stays with its creator', async () => {
    state.byId.utpl_solo = capturedRow({ id: 'utpl_solo', organizationId: null, createdBy: 'user-1' });
    assert.ok(await registry.resolveTemplate('utpl_solo', VIEWER));
    assert.equal(await registry.resolveTemplate('utpl_solo', { userId: 'user-9', orgIds: [] }), null);
});

test('unknown ids and store failures both resolve to null, never an exception', async () => {
    assert.equal(await registry.resolveTemplate('nope', VIEWER), null);
    assert.equal(await registry.resolveTemplate('utpl_missing', VIEWER), null);
    assert.equal(await registry.resolveTemplate('', VIEWER), null);
    state.getThrows = true;
    assert.equal(await registry.resolveTemplate('utpl_abc123', VIEWER), null,
        'every caller handles "no such template"; none handles a throw');
});

// ── The upgrade seam ───────────────────────────────────────────────────────

test('templateResolverFor binds a viewer for annotateTemplateUpgrades', async () => {
    state.byId.utpl_abc123 = capturedRow();
    const resolve = registry.templateResolverFor(VIEWER);
    const t = await resolve('utpl_abc123');
    assert.equal(t.version, 2, 'an app made from a captured template can be offered its newer version');
});
