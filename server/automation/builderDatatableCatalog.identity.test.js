/**
 * buildDatatableCatalogForUser against the REAL principal resolver, with the
 * user read failing.
 *
 * auth/datatableAccess.resolveDatatablePrincipal tolerates a failing
 * userStore.getUser: it records `identityError` and degrades to a tenantless
 * principal — the safe direction for a grade. For the catalog it is the wrong
 * direction: the org scope is never walked, the list is the account's
 * personal tables (usually none), and every caller stores [] = "this user has
 * no datatables" → the prompt says none and builder_add_datatable refuses with
 * "do not retry". builderDatatableCatalog.test.js stubs the resolver; this
 * file drives the real one so the seam between the two is covered.
 *
 * The stores are patched on their module objects (the way
 * auth/datatableAccess.test.js patches userStore) — no database is reached.
 *
 * Run: cd server && node --test --test-force-exit automation/builderDatatableCatalog.identity.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const userStore = require('../stores/userStore');
const datatableStore = require('../stores/datatableStore');
const { buildDatatableCatalogForUser } = require('./builderDatatableCatalog');

const ORG_TABLE = {
    id: 'tbl_org_a', key: 'facturen', name: 'Facturen', description: '', rowCount: 1,
    isPublished: true, sharedGroups: [], managedKind: null,
    organization_id: 'org1', owner_user_id: 'u_other', is_published: true, shared_groups: [], write_mode: 'grants', row_scope: 'all',
};

function patchStores({ getUser }) {
    const saved = {
        getUser: userStore.getUser, getAllGroups: userStore.getAllGroups,
        list: datatableStore.listDatatablesForScope, model: datatableStore.getModel, grants: datatableStore.listGrantsForTables,
    };
    userStore.getUser = getUser;
    userStore.getAllGroups = async () => [];
    datatableStore.listDatatablesForScope = async (scope) => (scope && scope.kind === 'org' ? [ORG_TABLE] : []);
    datatableStore.getModel = async () => ({ model: { tables: [] } });
    datatableStore.listGrantsForTables = async (ids) => new Map(ids.map(id => [id, []]));
    return () => {
        userStore.getUser = saved.getUser; userStore.getAllGroups = saved.getAllGroups;
        datatableStore.listDatatablesForScope = saved.list; datatableStore.getModel = saved.model; datatableStore.listGrantsForTables = saved.grants;
    };
}

test('a throwing user read rejects with "identity unavailable" instead of resolving to an empty list', async () => {
    const restore = patchStores({ getUser: async () => { throw new Error('pool hiccup'); } });
    try {
        await assert.rejects(() => buildDatatableCatalogForUser('u1'), /^Error: identity unavailable \(the account could not be read \(pool hiccup\)\)$/);
    } finally { restore(); }
});

test('the same stores with a readable user row list the org table — the throw above was the identity read, not the tables', async () => {
    const restore = patchStores({ getUser: async (id) => ({ id, organizationId: 'org1', orgRole: 'member', groups: [] }) });
    try {
        const out = await buildDatatableCatalogForUser('u1');
        assert.deepStrictEqual(out.map(t => t.id), ['tbl_org_a']);
    } finally { restore(); }
});
