/**
 * The two things K5 changed about a knowledge base's own routes: deleting one
 * says what it breaks first, and a personal one can finally be moved into an
 * organisation.
 *
 * DELETE used to ask for `canAccessKB` — the READING right. Anyone a base was
 * published to could destroy it and every document in it, provided their role
 * carried `manage_knowledge`. And it deleted immediately: agents stopped
 * answering, AI steps started failing on their next run, and nothing about
 * either failure named this base.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/detail.k5.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('node:path');

const mw = (req, res, next) => next();

const fx = {
    kb: null,
    canManage: true,
    usage: { rows: [], partial: [] },
    deleted: [],
    scrubbed: [],
    purged: [],
    updates: [],
    snapshots: [],
    orgIds: new Set(['org1']),
    orgAssertFails: false,
};

function resetFx() {
    fx.kb = { id: 'kb1', tenant_id: 'u1', name: 'Handbook', organization_id: 'org1' };
    fx.canManage = true;
    fx.usage = { rows: [], partial: [] };
    fx.orgIds = new Set(['org1']);
    fx.orgAssertFails = false;
    for (const k of ['deleted', 'scrubbed', 'updates', 'snapshots', 'purged']) fx[k].length = 0;
}
resetFx();

const MOCKS = {
    '../stores/knowledgeBases': {
        getKB: async (id) => (fx.kb && fx.kb.id === id ? fx.kb : null),
        isSystemKB: () => false,
        canUserManageKB: () => fx.canManage,
        updateKB: async (id, patch) => { fx.updates.push({ id, patch }); return { ...fx.kb, ...patch }; },
        snapshotKBVersion: async (id, by, reason) => { fx.snapshots.push({ id, reason }); },
        deleteKB: async (id) => { fx.deleted.push(id); },
        listDocuments: async () => [],
        countsBySource: async () => ({}),
        countDocumentsByStatus: async () => ({ documentCount: 0, documentCountAll: 0, totalChunks: 0 }),
    },
    '../auth': {
        requireAuth: mw,
        requirePermission: () => mw,
        requireActiveOrgForMutations: () => mw,
        resolveUserOrgIds: async () => fx.orgIds,
        hasPermission: async () => true,
        resolveUserGroups: async () => [],
        validateSharedGroupsForOrg: async () => {},
        assertUserCanUseOrg: async (req, orgId) => {
            if (fx.orgAssertFails) { const e = new Error('Organisation not accessible'); e.status = 403; throw e; }
            return orgId;
        },
    },
    '../support/kbAccess': { canAccessKB: async () => true, resolveIsOrgAdmin: async () => false },
    '../core/kb/kbUsage': {
        usageForKb: async () => fx.usage,
        scrubReferences: async (id) => { fx.scrubbed.push(id); return { agent: 1 }; },
        usageSummary: async () => ({}),
    },
    '../core/kb/resolveProvider': { resolveKbProvider: async () => 'local' },
    '../stores/datatableStore': {
        purgeUsageFor: async (kind, id) => { fx.purged.push({ kind, id }); return 1; },
    },
    '../core/kb/localKBIngest': { deleteChunksLocally: async () => {} },
    'multer': Object.assign(() => ({ any: () => mw, single: () => mw, array: () => mw }), { memoryStorage: () => ({}) }),
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-detail-k5:${request}`;
    MOCK_IDS[request] = mockId;
    MOCK_IDS[request.replace(/^\.\.\//, '../../')] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]knowledgeBases(\.js|[\\/][^\\/]+\.js)$/.test(parent.filename)
        && !/\.test\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require(path.join(__dirname, '..', 'knowledgeBases.js'));
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method = 'GET', url, body = {}, session = { user: { id: 'u1' } } }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const request = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {}, session,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

test.beforeEach(resetFx);

// ── DELETE ──────────────────────────────────────────────────────────

test('a base nothing uses deletes on the first ask', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/kb1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deleted, ['kb1']);
});

test('a base something uses answers 409 with the list, and deletes nothing', async () => {
    fx.usage = { rows: [{ kind: 'agent', id: 'ag1', title: 'Support assistant', role: 'chat' }], partial: [] };
    const res = await dispatch({ method: 'DELETE', url: '/kb1' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'in_use');
    assert.strictEqual(res.body.usage[0].id, 'ag1');
    assert.deepStrictEqual(fx.deleted, [], 'nothing was destroyed while asking');
});

test('a kind the scan could NOT reach also blocks — not knowing is not nothing', async () => {
    // The one moment where guessing wrong is unrecoverable.
    fx.usage = { rows: [], partial: ['app'] };
    const res = await dispatch({ method: 'DELETE', url: '/kb1' });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body.usage, []);
    assert.deepStrictEqual(res.body.unchecked, ['app']);
    assert.deepStrictEqual(fx.deleted, []);
});

test('?confirm=1 goes through and scrubs the references after the delete', async () => {
    fx.usage = { rows: [{ kind: 'agent', id: 'ag1', title: 'A', role: 'chat' }], partial: [] };
    const res = await dispatch({ method: 'DELETE', url: '/kb1?confirm=1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.deleted, ['kb1']);
    assert.deepStrictEqual(fx.scrubbed, ['kb1'], 'or an agent keeps a dead id in its config for ever');
    assert.deepStrictEqual(res.body.scrubbed, { agent: 1 });
});

test('deleting stops the table naming a knowledge base that is gone', async () => {
    // A datatable source made this base a consumer in the DATATABLE's
    // dependents index (K8), keyed on the base rather than the source — so
    // nothing else removes those rows. Left behind, the table's "Used by"
    // goes on naming a knowledge base that no longer exists, and its delete
    // guard goes on refusing over it.
    const res = await dispatch({ method: 'DELETE', url: '/kb1?confirm=1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(fx.purged, [{ kind: 'kb', id: 'kb1' }]);
});

test('a purge that fails does not resurrect a deleted knowledge base', async () => {
    // The row is already gone by then; a stale usage row is a wrong "used by",
    // not a reason to report the delete as failed.
    const store = require.cache['mock:kb-detail-k5:../stores/datatableStore'].exports;
    const real = store.purgeUsageFor;
    store.purgeUsageFor = async () => { throw new Error('datatables is down'); };
    try {
        const res = await dispatch({ method: 'DELETE', url: '/kb1?confirm=1' });
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(fx.deleted, ['kb1']);
    } finally {
        store.purgeUsageFor = real;
    }
});

test('deleting asks for the MANAGE right, not the reading one', async () => {
    fx.canManage = false;
    const res = await dispatch({ method: 'DELETE', url: '/kb1?confirm=1' });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.deleted, []);
});

// ── PATCH { organizationId } ────────────────────────────────────────

test('the owner can move a personal base into their organisation', async () => {
    // There was no path for this at all: publish refuses a base with no
    // organisation, and nothing else wrote the column — so a base built up
    // over months could never be shared without building it again.
    fx.kb = { id: 'kb1', tenant_id: 'u1', name: 'Handbook', organization_id: null };
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { organizationId: 'org1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.updates[0].patch.organizationId, 'org1');
    assert.deepStrictEqual(fx.snapshots, [{ id: 'kb1', reason: 'moved_to_organisation' }]);
});

test('the move does NOT publish — who may read it is unchanged', async () => {
    // Belonging to an organisation and being shared with it are two decisions,
    // and only the second is the owner saying "everyone may read this".
    fx.kb = { id: 'kb1', tenant_id: 'u1', name: 'Handbook', organization_id: null };
    await dispatch({ method: 'PATCH', url: '/kb1', body: { organizationId: 'org1' } });
    assert.ok(!('isPublished' in fx.updates[0].patch));
    assert.ok(!('sharedGroups' in fx.updates[0].patch));
});

test('somebody who is not the owner cannot give away a personal base', async () => {
    // canManageKB also admits an org admin holding manage_knowledge — right
    // for a base the org already owns, wrong for handing them somebody's own.
    fx.kb = { id: 'kb1', tenant_id: 'u_someone_else', name: 'Handbook', organization_id: null };
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { organizationId: 'org1' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'not_owner');
    assert.deepStrictEqual(fx.updates, []);
});

test('an organisation the person does not belong to is refused', async () => {
    fx.kb = { id: 'kb1', tenant_id: 'u1', name: 'Handbook', organization_id: null };
    fx.orgAssertFails = true;
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { organizationId: 'org_theirs' } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.updates, []);
});

test('a base that already belongs to an organisation cannot be moved to another', async () => {
    // One way only: un-setting or re-pointing it would revoke colleagues'
    // access to something they may already have attached to their agents,
    // with nothing to say so.
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { organizationId: 'org2' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'org_already_set');
    assert.deepStrictEqual(fx.updates, []);
});

test('an ordinary rename still works and touches no organisation', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { name: 'Personeelshandboek' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(fx.updates[0].patch.name, 'Personeelshandboek');
    assert.ok(!('organizationId' in fx.updates[0].patch));
    assert.deepStrictEqual(fx.snapshots, [{ id: 'kb1', reason: 'metadata_update' }]);
});

test('re-sending the organisation a base already has is not an error', async () => {
    // The settings form PATCHes the whole shape; sending back what is already
    // there must be a no-op, not a 400.
    const res = await dispatch({ method: 'PATCH', url: '/kb1', body: { name: 'X', organizationId: 'org1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!('organizationId' in fx.updates[0].patch));
});

// ── A project's files base ──────────────────────────────────────────

test('a project\'s files base is managed from its project: no publish, rename or delete here', async () => {
    // The files of a collaborative project (projects/projectFiles.js) sit in
    // a base stamped with the project's organisation. A project VIEWER whose
    // org role carries manage_knowledge used to publish it to the whole
    // organisation, or delete it with every file in it, through these routes.
    // `canManage` stays true here: even a caller the generic check admits is
    // refused, so the route does not lean on the store policy alone.
    fx.kb = { ...fx.kb, source_kind: 'project_files', is_published: false };
    fx.canManage = true;
    fx.published = [];
    const store = require.cache['mock:kb-detail-k5:../stores/knowledgeBases'].exports;
    store.setPublished = async (id, flag) => { fx.published.push({ id, flag }); return fx.kb; };
    try {
        const publish = await dispatch({ method: 'PATCH', url: '/kb1/publish', body: { isPublished: true } });
        assert.strictEqual(publish.statusCode, 403);
        const rename = await dispatch({ method: 'PATCH', url: '/kb1', body: { name: 'Mine now' } });
        assert.strictEqual(rename.statusCode, 403);
        const del = await dispatch({ method: 'DELETE', url: '/kb1?confirm=1' });
        assert.strictEqual(del.statusCode, 403);
        assert.deepStrictEqual(fx.published, [], 'not published');
        assert.deepStrictEqual(fx.updates, [], 'not renamed');
        assert.deepStrictEqual(fx.deleted, [], 'not deleted');
    } finally {
        delete store.setPublished;
    }
});
