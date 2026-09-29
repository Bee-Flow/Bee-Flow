/**
 * buildDatatableCatalogForUser — the datatable list the builder prompt and
 * builder_add_datatable read, driven against stubbed stores.
 *
 * What is worth pinning is the contract the three callers rely on:
 *   - both tenancies are walked, organisation first, store order inside;
 *   - `canWrite` is the SAME question the runner asks (grade >= editor);
 *   - a table the principal holds no grade on is not in the list at all;
 *   - columns come from the model's field descriptors as {key,name,type,unique};
 *   - a store failure THROWS — [] means "no tables", and a caller that
 *     wants "could not tell" catches it (see the module header).
 *
 * The stubs are installed through require.cache before the module under test
 * loads, the same technique core/automationRunner/execDatatable.test.js uses.
 *
 * Run: cd server && node --test --test-force-exit automation/builderDatatableCatalog.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');

function stub(absPath, exports) {
    const resolved = require.resolve(absPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

const ORG = { kind: 'org', id: 'org1' };
const ME = { kind: 'user', id: 'u1' };

const state = {
    tablesByScope: new Map(),
    modelByScope: new Map(),
    // datatableId → grade the stubbed resolver answers (null = no access).
    grades: {},
    listThrows: null,
    // What the resolver reports when the user row could not be read (it
    // degrades to a tenantless principal rather than throwing).
    identityError: null,
    resolverCalls: [],
    gradeAtLeastCalls: [],
    scopesFor: () => [ORG, ME],
};

const scopeKey = (s) => `${s.kind}:${s.id}`;

stub(path.join(SERVER, 'stores', 'datatableStore.js'), {
    listDatatablesForScope: async (scope) => {
        if (state.listThrows) throw new Error(state.listThrows);
        return state.tablesByScope.get(scopeKey(scope)) || [];
    },
    getModel: async (scope) => ({ model: state.modelByScope.get(scopeKey(scope)) || { tables: [] } }),
    listGrantsForTables: async (ids) => new Map(ids.map(id => [id, []])),
});

// The ladder from auth/datatableAccess.js, not a truthy shortcut: the module
// must ask "at least editor", and this stub records that it did.
const RANK = { viewer: 0, editor: 1, owner: 2 };
stub(path.join(SERVER, 'auth', 'datatableAccess.js'), {
    resolveDatatablePrincipalForUser: async (userId) => {
        state.resolverCalls.push(userId);
        return { userId, orgId: state.identityError ? null : 'org1', organizationId: state.identityError ? null : 'org1', orgRole: null, groupIds: [], orgIds: new Set(state.identityError ? [] : ['org1']), identityError: state.identityError };
    },
    datatableScopesFor: (principal) => state.scopesFor(principal),
    gradeForPrincipal: (table) => (Object.hasOwn(state.grades, table.id) ? state.grades[table.id] : null),
    gradeAtLeast: (grade, min) => {
        state.gradeAtLeastCalls.push([grade, min]);
        return grade != null && Object.hasOwn(RANK, grade) && RANK[grade] >= RANK[min];
    },
});

const { buildDatatableCatalogForUser } = require('./builderDatatableCatalog');

const table = (id, key, name, extra = {}) => ({
    id, key, name, description: `${name} desc`, rowCount: 3,
    isPublished: false, sharedGroups: [], managedKind: null, ...extra,
});

function reset() {
    state.tablesByScope = new Map([
        [scopeKey(ORG), [
            table('tbl_org_a', 'facturen', 'Facturen', { isPublished: true }),
            table('tbl_org_b', 'klanten', 'Klanten', { isPublished: true, sharedGroups: ['g1'] }),
        ]],
        [scopeKey(ME), [table('tbl_me', 'notities', 'Notities')]],
    ]);
    state.modelByScope = new Map([
        [scopeKey(ORG), { tables: [
            { id: 'tbl_org_a', fields: [
                { key: 'datum', name: 'Datum', type: 'date' },
                { key: 'excl_btw', name: 'Excl. btw', type: 'number', unique: 0 },
                { key: 'factuurnr', type: 'text', unique: true },
            ] },
            { id: 'tbl_org_b', fields: [{ key: 'email', name: 'E-mail', type: 'text', unique: true }] },
        ] }],
        [scopeKey(ME), { tables: [{ id: 'tbl_me', fields: [{ key: 'tekst', name: 'Tekst', type: 'text' }] }] }],
    ]);
    state.grades = { tbl_org_a: 'editor', tbl_org_b: 'viewer', tbl_me: 'owner' };
    state.listThrows = null;
    state.identityError = null;
    state.resolverCalls = [];
    state.gradeAtLeastCalls = [];
    state.scopesFor = () => [ORG, ME];
}

test('walks both scopes, organisation first, store order within a scope', async () => {
    reset();
    const out = await buildDatatableCatalogForUser('u1');
    assert.deepStrictEqual(out.map(t => t.id), ['tbl_org_a', 'tbl_org_b', 'tbl_me']);
});

test('canWrite is "at least editor": editor and owner write, viewer does not', async () => {
    reset();
    const out = await buildDatatableCatalogForUser('u1');
    const byId = Object.fromEntries(out.map(t => [t.id, t]));
    assert.strictEqual(byId.tbl_org_a.canWrite, true, 'org editor');
    assert.strictEqual(byId.tbl_me.canWrite, true, 'personal owner');
    assert.strictEqual(byId.tbl_org_b.canWrite, false, 'viewer');
    assert.ok(state.gradeAtLeastCalls.length === 3 && state.gradeAtLeastCalls.every(([, min]) => min === 'editor'),
        'the write question is asked against the editor grade, the same threshold the runner uses');
});

test('columns are mapped from the model fields as {key,name,type,unique}; a nameless field shows its key', async () => {
    reset();
    const out = await buildDatatableCatalogForUser('u1');
    const facturen = out.find(t => t.id === 'tbl_org_a');
    assert.deepStrictEqual(facturen.columns, [
        { key: 'datum', name: 'Datum', type: 'date', unique: false },
        { key: 'excl_btw', name: 'Excl. btw', type: 'number', unique: false },
        { key: 'factuurnr', name: 'factuurnr', type: 'text', unique: true },
    ]);
    // The rest of the row shape the picker and the prompt read.
    assert.strictEqual(facturen.key, 'facturen');
    assert.strictEqual(facturen.name, 'Facturen');
    assert.strictEqual(facturen.description, 'Facturen desc');
    assert.strictEqual(facturen.rowCount, 3);
    assert.strictEqual(facturen.managedKind, null);
});

test('scope labels who can SEE it: org, groups or personal', async () => {
    reset();
    const out = await buildDatatableCatalogForUser('u1');
    const byId = Object.fromEntries(out.map(t => [t.id, t]));
    assert.strictEqual(byId.tbl_org_a.scope, 'org', 'published to everyone in the org');
    assert.strictEqual(byId.tbl_org_b.scope, 'groups', 'published to named groups');
    assert.strictEqual(byId.tbl_me.scope, 'personal', 'a user-scoped table is nobody else\'s');
});

test('a table the principal holds no grade on is omitted, not listed read-only', async () => {
    reset();
    state.grades = { tbl_org_a: 'editor', tbl_me: 'owner' }; // tbl_org_b → null
    const out = await buildDatatableCatalogForUser('u1');
    assert.deepStrictEqual(out.map(t => t.id), ['tbl_org_a', 'tbl_me']);
});

test('a table without a model descriptor still lists, with no columns', async () => {
    reset();
    state.modelByScope.set(scopeKey(ME), { tables: [] });
    const out = await buildDatatableCatalogForUser('u1');
    assert.deepStrictEqual(out.find(t => t.id === 'tbl_me').columns, []);
});

test('a given principal is used as-is; without one it is resolved from the user row', async () => {
    reset();
    const principal = { userId: 'u1', orgId: 'org1', organizationId: 'org1', groupIds: [] };
    let seen = null;
    state.scopesFor = (p) => { seen = p; return [ORG]; };
    await buildDatatableCatalogForUser('u1', { principal });
    assert.strictEqual(seen, principal, 'the caller\'s principal reaches the scope walk untouched');
    assert.deepStrictEqual(state.resolverCalls, [], 'no second resolution when one was handed in');

    state.scopesFor = () => [ORG, ME];
    await buildDatatableCatalogForUser('u1');
    assert.deepStrictEqual(state.resolverCalls, ['u1'], 'resolved once, for this user');
});

test('a principal with no scopes yields an empty list — "no tables", not an error', async () => {
    reset();
    state.scopesFor = () => [];
    assert.deepStrictEqual(await buildDatatableCatalogForUser('u1'), []);
});

test('a store failure propagates — the caller decides between "none" and "could not tell"', async () => {
    reset();
    state.listThrows = 'connection refused';
    await assert.rejects(() => buildDatatableCatalogForUser('u1'), /connection refused/);
});

test('a FAILED identity read throws — it is "could not tell", never "this user has no tables"', async () => {
    // The resolver degrades a failing user read to a tenantless principal, so
    // only the personal scope would be walked and the org table above would
    // vanish into an empty list = "no tables" = a refused datatable step.
    reset();
    state.identityError = 'the account could not be read (pool hiccup)';
    state.scopesFor = (p) => (p.orgId ? [ORG, ME] : [ME]);
    await assert.rejects(() => buildDatatableCatalogForUser('u1'), /identity unavailable \(the account could not be read \(pool hiccup\)\)/);
    // A passed-in principal carrying the flag is refused the same way.
    await assert.rejects(() => buildDatatableCatalogForUser('u1', { principal: { userId: 'u1', orgId: null, organizationId: null, groupIds: [], identityError: 'the groups could not be read (x)' } }), /identity unavailable/);
    // And without the flag the same tenantless principal is an honest
    // org-less account: its personal tables, no error.
    const solo = await buildDatatableCatalogForUser('u1', { principal: { userId: 'u1', orgId: null, organizationId: null, groupIds: [], identityError: null } });
    assert.deepStrictEqual(solo.map(t => t.id), ['tbl_me']);
});
