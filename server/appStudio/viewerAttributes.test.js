/**
 * viewer.email / viewer.groups / viewer.orgId for row rules (viewerAttributes.mts): read from
 * the user's own row at use, only for a model that reads them, never taken from the caller,
 * and left off (unknown, so no row) when they cannot be read.
 *
 * Run: cd server && node --test appStudio/viewerAttributes.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    modelReadsViewerAttributes, resolveViewerAttributes, withViewerAttributes,
    ctxWithViewerAttributes, viewerAttributesOf, anonymousViewerAttributes,
} = require('./viewerAttributes.mts');
const accessFilter = require('../core/dataEngine/accessFilter');

function modelWith(rule) {
    return {
        modelVersion: 1,
        tables: [{
            id: 'tbl_tasks0', key: 'tasks',
            fields: [{ id: 'f1', key: 'team', type: 'text' }, { id: 'f2', key: 'contact', type: 'text' }],
            access: { default: 'none', roles: { member: { read: 'all', update: 'all', delete: 'all' } }, rowFilters: rule === undefined ? {} : { member: rule } },
        }],
    };
}

/** A user store that counts its reads. */
function users(rows) {
    const calls = [];
    return { calls, getUser: async (id) => { calls.push(id); if (rows[id] instanceof Error) throw rows[id]; return rows[id] ?? null; } };
}

const ADA = { id: 'u_ada', email: 'ada@example.org', groups: ['g_sales', 'g_board'], organizationId: 'org_1', passwordHash: 'x' };

test('only a model whose row rules read an attribute asks for them', () => {
    assert.equal(modelReadsViewerAttributes(modelWith()), false);
    assert.equal(modelReadsViewerAttributes(modelWith('record.created_by == viewer.id')), false);
    assert.equal(modelReadsViewerAttributes(modelWith('record.team == viewer.organizationId')), false);
    assert.equal(modelReadsViewerAttributes(modelWith('record.team in viewer.groups')), true);
    assert.equal(modelReadsViewerAttributes(modelWith('record.contact == viewer . email')), true);
    assert.equal(modelReadsViewerAttributes(modelWith('record.org_id == viewer.orgId')), true);
    assert.equal(modelReadsViewerAttributes(modelWith({ update: 'record.team in viewer.groups' })), true);
    const { parseExpr } = require('../shared/expr/index.mjs');
    assert.equal(modelReadsViewerAttributes(modelWith(parseExpr('record.contact == viewer.email'))), true);
    for (const junk of [null, undefined, 'x', [], { tables: 'x' }, { tables: [null, { access: null }, { access: { rowFilters: [] } }] }]) {
        assert.equal(modelReadsViewerAttributes(junk), false);
    }
});

test('a model that reads none gets its viewer back untouched, without a user read', async () => {
    const store = users({ u_ada: ADA });
    const viewer = { id: 'u_ada', role: 'member', organizationId: 'org_session' };
    assert.equal(await withViewerAttributes(viewer, modelWith('record.created_by == viewer.id'), store), viewer);
    assert.equal(await withViewerAttributes(viewer, null, store), viewer);
    assert.deepEqual(store.calls, []);
});

test('the attributes come from the user row; organizationId stays what the path put there', async () => {
    const store = users({ u_ada: ADA });
    const out = await withViewerAttributes({ id: 'u_ada', role: 'member', organizationId: 'org_session' }, modelWith('record.team in viewer.groups'), store);
    assert.deepEqual(out, {
        id: 'u_ada', role: 'member', organizationId: 'org_session',
        email: 'ada@example.org', groups: ['g_sales', 'g_board'], orgId: 'org_1',
    });
    assert.deepEqual(store.calls, ['u_ada']);
});

test('nothing of the user row but the three attributes reaches the viewer', async () => {
    const attrs = await resolveViewerAttributes('u_ada', users({ u_ada: ADA }));
    assert.deepEqual(Object.keys(attrs).sort(), ['email', 'groups', 'orgId']);
});

test('groups stored as JSON text, a user without groups, e-mail or organisation', async () => {
    assert.deepEqual(await resolveViewerAttributes('u1', users({ u1: { groups: '["g1","g2"]', email: 'a@example.org' } })), { email: 'a@example.org', groups: ['g1', 'g2'], orgId: null });
    assert.deepEqual(await resolveViewerAttributes('u1', users({ u1: { groups: 'not json' } })), { email: null, groups: [], orgId: null });
    assert.deepEqual(await resolveViewerAttributes('u1', users({ u1: { groups: ['g1', 7, '', null] } })), { email: null, groups: ['g1'], orgId: null });
});

test('what a caller put under these names is replaced, never kept', async () => {
    const store = users({ u_ada: ADA });
    const forged = { id: 'u_ada', role: 'member', email: 'boss@example.org', groups: ['g_everything'], orgId: 'org_other' };
    const out = await withViewerAttributes(forged, modelWith('record.team in viewer.groups'), store);
    assert.deepEqual([out.email, out.groups, out.orgId], ['ada@example.org', ['g_sales', 'g_board'], 'org_1']);
    // And when the user cannot be read they are gone, not kept.
    const gone = await withViewerAttributes({ ...forged, id: 'u_nobody' }, modelWith('record.team in viewer.groups'), store);
    assert.deepEqual(gone, { id: 'u_nobody', role: 'member' });
});

test('an unknown user, a failed read and a missing id leave the attributes off: no row, either way round', async () => {
    const model = modelWith('!(record.team in viewer.groups)');
    const table = model.tables[0];
    for (const [id, store] of [
        ['u_nobody', users({})],
        ['u_broken', users({ u_broken: new Error('database is down') })],
        [null, users({})],
    ]) {
        const viewer = await withViewerAttributes({ id, role: 'member' }, model, store);
        assert.equal('groups' in viewer, false, String(id));
        assert.deepEqual(accessFilter.compileAccessFilter(table, 'member', viewer, 'read', { dialect: 'sqlite' }), {
            where: '(1=1) AND ((NOT ("team" IN (NULL))))', params: [],
        }, String(id));
    }
});

test('an anonymous visitor is in no group and no organisation, and nobody is looked up', async () => {
    const store = users({ 'anon:1': ADA });
    const out = await withViewerAttributes({ id: 'anon:1', role: 'public', organizationId: null }, modelWith('record.team in viewer.groups'), { ...store, anonymous: true });
    assert.deepEqual(out, { id: 'anon:1', role: 'public', organizationId: null, ...anonymousViewerAttributes() });
    assert.deepEqual(anonymousViewerAttributes(), { email: null, groups: [], orgId: null });
    assert.deepEqual(store.calls, []);
});

test('a step context gets them on its viewer; one that has them, or a model that reads none, is left alone', async () => {
    const model = modelWith('record.contact == viewer.email');
    const store = users({ u_ada: ADA });
    const bare = { viewerId: 'u_ada', role: 'member' };
    const out = await ctxWithViewerAttributes(model, bare, store);
    assert.deepEqual(out, { viewerId: 'u_ada', role: 'member', viewer: { id: 'u_ada', email: 'ada@example.org', groups: ['g_sales', 'g_board'], orgId: 'org_1' } });

    const withViewer = { viewerId: 'u_ada', role: 'member', viewer: { id: 'u_ada', role: 'member', organizationId: 'org_app' } };
    const out2 = await ctxWithViewerAttributes(model, withViewer, store);
    assert.deepEqual(out2.viewer, { id: 'u_ada', role: 'member', organizationId: 'org_app', email: 'ada@example.org', groups: ['g_sales', 'g_board'], orgId: 'org_1' });
    assert.equal(withViewer.viewer.email, undefined, 'the caller\'s context is not written to');

    const resolved = { viewerId: 'anon:1', viewer: { id: 'anon:1', ...anonymousViewerAttributes() } };
    store.calls.length = 0;
    assert.equal(await ctxWithViewerAttributes(model, resolved, store), resolved);
    assert.equal(await ctxWithViewerAttributes(modelWith(), bare, store), bare);
    assert.deepEqual(store.calls, []);
});

test('viewerAttributesOf hands on the resolved attributes and nothing else', () => {
    assert.deepEqual(viewerAttributesOf({ id: 'u1', role: 'member', organizationId: 'o', email: null, groups: [], orgId: 'org_1', name: 'x' }), { email: null, groups: [], orgId: 'org_1' });
    assert.deepEqual(viewerAttributesOf({ id: 'u1' }), {});
    assert.deepEqual(viewerAttributesOf(null), {});
});
