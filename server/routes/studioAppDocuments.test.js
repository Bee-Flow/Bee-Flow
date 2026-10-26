'use strict';

/**
 * Studio documents inside an app, over HTTP (routes/studioAppDocuments.js with
 * appDocuments/pool.mts and reader.mts): every document is read AS THE OWNER,
 * only when it is the owner's own (or an org team template), not archived, and
 * in the app's document pool for the viewer's role — or a copy this app made.
 * Everything else is the same 404. What leaves is allow-listed.
 *
 * Run: cd server && node --test routes/studioAppDocuments.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');
const { makeAppDocumentsRouter } = require('./studioAppDocuments');
const { normalizeDeck } = require('../core/documents/deckModel');

const DEF = {
    screens: [
        {
            id: 's1', sections: [{ id: 'sec1', children: [
                { id: 'view_fixed', type: 'document_viewer', props: { source: { kind: 'static', value: 'deck1' } } },
                { id: 'view_var', type: 'document_viewer', props: { source: { kind: 'formula', expr: 'vars.doc' } } },
                { id: 'pick', type: 'input_document', props: { documentIds: ['page1', 'shared1', 'archived1', 'teamTpl'], folderId: 'f1', kind: 'any' } },
                { id: 'pick_decks', type: 'input_document', props: { documentIds: ['page1', 'deck1'], kind: 'presentation' } },
                { id: 'cmp', type: 'document_compare', props: { left: { kind: 'static', value: 'deck1' }, right: { kind: 'formula', expr: 'vars.copy' } } },
                { id: 'admin_view', type: 'document_viewer', visibleToRoles: ['admin'], props: { source: { kind: 'static', value: 'secret1' } } },
                { id: 'plain', type: 'heading', props: { text: 'Hi' } },
            ] }],
        },
        { id: 's2', visibleToRoles: ['admin'], sections: [{ id: 'sec2', children: [
            { id: 'admin_cmp', type: 'document_compare', props: { left: { kind: 'static', value: 'secret2' } } },
        ] }] },
    ],
    actions: {
        act_copy: { kind: 'sequence', steps: [{ kind: 'copy_document', source: { kind: 'static', value: 'deck1' }, templateDocumentId: 'deck2', resultVar: 'copy' }] },
    },
};
const DRAFT = { screens: [{ id: 's1', sections: [{ id: 'sec1', children: [
    { id: 'draft_view', type: 'document_viewer', props: { source: { kind: 'static', value: 'loose' } } },
] }] }], actions: {} };
const APP = { id: 'app1', userId: 'owner', organizationId: 'org1', definition: DRAFT, publishedDefinition: DEF };

const owned = (id, extra = {}) => ({ id, userId: 'owner', organizationId: 'org1', name: `Doc ${id}`, docType: 'page', kind: 'document', bodyHtml: `<p>${id}</p>`, settings: {}, versionId: `v-${id}`, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'someone', folderId: null, ...extra });
const DOCS = {
    deck1: owned('deck1', { docType: 'presentation', bodyHtml: '# Deck\n\n## Results\n- Revenue grew 10%\n', settings: { deck: { preset: 'band' } } }),
    deck2: owned('deck2', { docType: 'presentation', bodyHtml: '# Deck\n\n## Results\n- Revenue grew 12%\n', settings: { deck: { preset: 'minimal' } } }),
    page1: owned('page1'),
    pageF: owned('pageF', { folderId: 'f1' }),
    sheetF: owned('sheetF', { folderId: 'f1', docType: 'spreadsheet' }),
    otherFolder: owned('otherFolder', { folderId: 'f2' }),
    secret1: owned('secret1'),
    secret2: owned('secret2'),
    loose: owned('loose'),
    copy1: owned('copy1', { docType: 'presentation', bodyHtml: '# Deck\n\n## Results\n- Revenue grew 12%\n', settings: { createdByApp: 'app1' } }),
    copyOther: owned('copyOther', { settings: { createdByApp: 'app2' } }),
    shared1: owned('shared1', { userId: 'colleague', sharingRole: 'viewer' }),
    archived1: owned('archived1', { archived: true }),
    teamTpl: owned('teamTpl', { userId: 'colleague', kind: 'template', visibility: 'team' }),
};
const reads = [];
const readerDeps = {
    async getDocument(id, userId) {
        reads.push(userId);
        return DOCS[id] || null;
    },
    async getDocumentVersion(id, userId, versionId) {
        reads.push(userId);
        return DOCS[id] ? { ...DOCS[id], bodyHtml: '<p>an older text</p>', versionId } : null;
    },
    async listVersions(id) {
        return { versions: [
            { id: `v-${id}`, seq: 2, source: 'autosave', name: null, summary: '', createdAt: '2026-10-02', createdBy: 'someone', contributors: [{ userId: 'someone' }] },
            { id: 'v-old', seq: 1, source: 'named', name: 'Sent to the board', summary: '', createdAt: '2026-10-01', createdBy: 'someone', contributors: [] },
        ] };
    },
    async listFolder(userId, folderId) {
        return Object.values(DOCS).filter((d) => d.folderId === folderId);
    },
    async readSheet() {
        return { tabs: [{ name: 'Tab', cells: { A1: '1', A2: '=A1+1' }, display: { A1: '1', A2: '2' } }] };
    },
    async previewHtml(doc) { return `<html><body>${doc.id}</body></html>`; },
    deckOf: (doc) => normalizeDeck(doc.bodyHtml),
    lookOf: (doc) => doc.settings.deck || {},
};
const ROLES = { owner: 'owner', admin: 'admin', member: 'member' };
const router = makeAppDocumentsRouter({
    reader: readerDeps,
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })),
    loadVisibleApp: async (req, res) => {
        if (req.params.id !== 'app1' || req.session.user.id === 'outsider') { res.status(404).json({ error: 'App not found' }); return null; }
        return APP;
    },
    resolveRole: async (_req, _app, userId) => ROLES[userId] || null,
    // The run gate's own rule (roleAllows / actionRoleAccess): no module load of the store it requires.
    documentChecks: (_def, role) => ({
        visible: (n) => role === 'owner' || !Array.isArray(n?.visibleToRoles) || n.visibleToRoles.length === 0 || n.visibleToRoles.includes(role),
        actionAllowed: () => true,
    }),
    limiter: null,
});
const api = h.serve('/api/studio-apps', router);
test.after(api.close);
test.beforeEach(() => { reads.length = 0; });

const as = (user, method, path, body) => api.call(method, `/api/studio-apps${path}`, { user: user && { id: user, organizationId: 'org1' }, body });
const view = (user, doc, node, extra = '') => as(user, 'GET', `/app1/documents/${doc}?node=${node}${extra}`);

test('a pinned document is shown to the owner and to a member, read as the owner, with allow-listed fields only', async () => {
    for (const user of ['owner', 'member']) {
        const res = await view(user, 'deck1', 'view_fixed');
        assert.strictEqual(res.status, 200, res.text);
        assert.deepStrictEqual(Object.keys(res.body.document).sort(), ['docType', 'family', 'id', 'name', 'updatedAt', 'versionId']);
        assert.strictEqual(res.body.document.family, 'deck');
        assert.strictEqual(res.body.html, '<html><body>deck1</body></html>');
        assert.ok(!res.text.includes('owner') && !res.text.includes('someone') && !res.text.includes('org1'), 'no user, editor or organisation ids');
    }
    assert.ok(reads.every((u) => u === 'owner'), 'every read is acts-as-owner');
    assert.strictEqual((await view('member', 'deck1', 'view_fixed')).headers.get('cache-control'), 'no-store');
});

test('another user\'s document is refused, also when the owner could read it through a share', async () => {
    // Not readable by the owner at all: the store answers null.
    assert.strictEqual((await view('member', 'nope', 'view_var')).status, 404);
    // Shared WITH the owner and even listed in a picker: an app's audience is wider than that share.
    const shared = await view('member', 'shared1', 'pick');
    assert.strictEqual(shared.status, 404);
    assert.strictEqual(shared.body.code, 'document_not_found');
    // Archived is gone.
    assert.strictEqual((await view('owner', 'archived1', 'pick')).status, 404);
    // An org team template the builder pinned is fine.
    assert.strictEqual((await view('member', 'teamTpl', 'pick')).status, 200);
});

test('a dynamic binding reaches only the pool: the owner\'s other documents stay out, this app\'s own copies are in', async () => {
    assert.strictEqual((await view('member', 'loose', 'view_var')).status, 404, 'the owner\'s document nobody put in the app');
    assert.strictEqual((await view('owner', 'loose', 'view_var')).status, 404, 'the same rule for the owner testing the app');
    assert.strictEqual((await view('member', 'page1', 'view_var')).status, 200, 'pinned in a picker');
    assert.strictEqual((await view('member', 'pageF', 'view_var')).status, 200, 'in the picker\'s folder');
    assert.strictEqual((await view('member', 'otherFolder', 'view_var')).status, 404, 'another folder');
    assert.strictEqual((await view('member', 'deck2', 'view_var')).status, 200, 'the template of a copy step');
    assert.strictEqual((await view('member', 'copy1', 'view_var')).status, 200, 'a copy this app made');
    assert.strictEqual((await view('member', 'copyOther', 'view_var')).status, 404, 'a copy another app made');
});

test('what a role cannot see adds nothing: hidden nodes and screens are 404, their documents out of the pool', async () => {
    const hidden = await view('member', 'secret1', 'admin_view');
    assert.strictEqual(hidden.status, 404);
    assert.strictEqual(hidden.body.code, 'document_component_not_found');
    assert.strictEqual((await view('member', 'secret1', 'view_var')).status, 404);
    assert.strictEqual((await view('member', 'secret2', 'view_var')).status, 404);
    assert.strictEqual((await view('admin', 'secret1', 'admin_view')).status, 200);
    assert.strictEqual((await view('admin', 'secret2', 'view_var')).status, 200);
    // A node that is no document component, or that does not exist.
    assert.strictEqual((await view('owner', 'deck1', 'plain')).status, 404);
    assert.strictEqual((await view('owner', 'deck1', 'ghost')).status, 404);
});

test('the gates before any read: no session 401, an app you cannot see 404, a bad id 400', async () => {
    assert.strictEqual((await as(null, 'GET', '/app1/documents/deck1?node=view_fixed')).status, 401);
    assert.strictEqual((await view('outsider', 'deck1', 'view_fixed')).status, 404);
    h.assertRefused(assert, await view('owner', 'bad%20id', 'view_fixed'), 'params.docId');
    h.assertRefused(assert, await as('owner', 'GET', '/app1/documents/deck1'), 'query.node');
    assert.deepStrictEqual(reads, [], 'nothing was read');
});

test('?draft=1 is the owner\'s; anyone else gets the published app', async () => {
    assert.strictEqual((await view('owner', 'loose', 'draft_view', '&draft=1')).status, 200);
    assert.strictEqual((await view('member', 'loose', 'draft_view', '&draft=1')).status, 404);
});

test('a picker lists its own ids and folder (owner-owned, not archived, by kind), nothing else', async () => {
    const all = await as('member', 'GET', '/app1/documents?node=pick');
    assert.strictEqual(all.status, 200, all.text);
    assert.deepStrictEqual(all.body.documents.map((d) => d.id).sort(), ['page1', 'pageF', 'sheetF', 'teamTpl']);
    assert.deepStrictEqual(Object.keys(all.body.documents[0]).sort(), ['docType', 'family', 'id', 'name', 'updatedAt']);
    const decks = await as('member', 'GET', '/app1/documents?node=pick_decks');
    assert.deepStrictEqual(decks.body.documents.map((d) => d.id), ['deck1']);
    const q = await as('member', 'GET', '/app1/documents?node=pick&q=pagef');
    assert.deepStrictEqual(q.body.documents.map((d) => d.id), ['pageF']);
    assert.strictEqual((await as('member', 'GET', '/app1/documents?node=view_fixed')).status, 400, 'only a picker lists');
});

test('a sheet is shown as its computed values; it has no versions to compare', async () => {
    const sheet = await view('member', 'sheetF', 'view_var');
    assert.deepStrictEqual(sheet.body.sheet, { tabs: [{ name: 'Tab', display: { A1: '1', A2: '2' } }] });
    const v = await view('member', 'sheetF', 'view_var', '&version=v-old');
    assert.strictEqual(v.status, 422);
    assert.strictEqual(v.body.code, 'sheet_versions_unavailable');
    const list = await as('member', 'GET', '/app1/documents/sheetF/versions?node=view_var');
    assert.deepStrictEqual(list.body, { supported: false, versions: [] });
});

test('versions: newest first, a version name but never who made it', async () => {
    const list = await as('member', 'GET', '/app1/documents/page1/versions?node=view_var');
    assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(list.body.versions, [
        { versionId: 'v-page1', label: null, source: 'autosave', createdAt: '2026-10-02', current: true },
        { versionId: 'v-old', label: 'Sent to the board', source: 'named', createdAt: '2026-10-01', current: false },
    ]);
    assert.ok(!list.text.includes('someone'));
    const old = await view('member', 'page1', 'view_var', '&version=v-old');
    assert.strictEqual(old.body.document.versionId, 'v-old');
});

test('compare: two decks slide by slide, both rendered; only from a compare node', async () => {
    const out = await as('member', 'POST', '/app1/documents/compare', { node: 'cmp', left: { documentId: 'deck1' }, right: { documentId: 'copy1' } });
    assert.strictEqual(out.status, 200, out.text);
    assert.strictEqual(out.body.result.family, 'deck');
    assert.strictEqual(out.body.result.summary.changed, 1);
    assert.strictEqual(out.body.leftHtml, '<html><body>deck1</body></html>');
    assert.strictEqual(out.body.rightHtml, '<html><body>copy1</body></html>');
    const wrongNode = await as('member', 'POST', '/app1/documents/compare', { node: 'view_fixed', left: { documentId: 'deck1' }, right: { documentId: 'copy1' } });
    assert.strictEqual(wrongNode.status, 400);
});

test('compare: one side outside the pool refuses the whole compare; a sheet against a page is 422', async () => {
    const out = await as('member', 'POST', '/app1/documents/compare', { node: 'cmp', left: { documentId: 'deck1' }, right: { documentId: 'loose' } });
    assert.strictEqual(out.status, 404);
    const mixed = await as('member', 'POST', '/app1/documents/compare', { node: 'cmp', left: { documentId: 'sheetF' }, right: { documentId: 'page1' } });
    assert.strictEqual(mixed.status, 422);
    assert.strictEqual(mixed.body.code, 'documents_not_comparable');
    h.assertRefused(assert, await as('member', 'POST', '/app1/documents/compare', { node: 'cmp', left: { documentId: 'deck1', extra: 1 }, right: { documentId: 'page1' } }), 'body.left');
});

test('compare: two versions of one document', async () => {
    const out = await as('member', 'POST', '/app1/documents/compare', { node: 'cmp', left: { documentId: 'page1', versionId: 'v-old' }, right: { documentId: 'page1' } });
    assert.strictEqual(out.status, 200, out.text);
    assert.strictEqual(out.body.result.family, 'text');
    assert.strictEqual(out.body.left.versionId, 'v-old');
    assert.strictEqual(out.body.right.versionId, 'v-page1');
    assert.ok(out.body.result.blocks.some((b) => b.op !== 'equal'));
});
