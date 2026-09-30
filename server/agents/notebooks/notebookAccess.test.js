/**
 * A project notebook's own knowledge base, for the people it is shared with.
 *
 *   - a member's first upload creates the base as the NOTEBOOK OWNER's and
 *     attaches it (it used to be the member's personal base, which the
 *     owner-scoped attach refused: the source said "ready" and was never
 *     found); the base carries no organisation, so an org admin cannot read a
 *     member's private notebook sources through the KB ACL's org-admin rule;
 *   - the notebook's own base is read by notebook role, any other base only
 *     with the caller's own KB access (attaching never widens who reads it);
 *   - the change feed hears ids and counts only, and only for filed notebooks;
 *   - without a co-editing engine, a notebook stays single-writer.
 *
 * Collaborators are swapped on their shared module objects (testUtils/swaps.js).
 *
 * Run: cd server && node --test agents/notebooks/notebookAccess.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../../testUtils/swaps');

const notebookStore = require('../../stores/notebookStore');
const kbStore = require('../../stores/knowledgeBases');
const { ensureNotebookKBFor } = require('./sourceIngestion');
const { partitionNotebookKbIds } = require('./notebookKbAccess');
const { makeNotebookFeed } = require('./notebookFeed');
const notebookCollab = require('./notebookCollab');

const { swap, restore } = makeSwaps();
after(restore);

test('a member\'s first upload creates the base as the notebook owner\'s and attaches it', async () => {
    const created = [];
    const attached = [];
    const undo = [
        swap(notebookStore, 'getNotebook', async (id, userId) => (userId === 'erin'
            ? { id, userId: 'alice', name: 'Plan', organizationId: 'org1', knowledgeBaseIds: [], role: 'editor' }
            : null)),
        swap(kbStore, 'createKB', async (tenantId, name, description, organizationId, extra) => {
            created.push({ tenantId, organizationId, sourceKind: extra.sourceKind });
            return { id: 'kb-new', name };
        }),
        swap(notebookStore, 'attachKnowledgeBaseIfAbsent', async (id, ownerId, kbId) => { attached.push({ id, ownerId, kbId }); return kbId; }),
    ];
    try {
        const out = await ensureNotebookKBFor('nb1', 'erin');
        assert.deepStrictEqual(out, { kbId: 'kb-new', tenantId: 'alice' });
        assert.deepStrictEqual(created, [{ tenantId: 'alice', organizationId: null, sourceKind: 'notebook_auto' }]);
        assert.deepStrictEqual(attached, [{ id: 'nb1', ownerId: 'alice', kbId: 'kb-new' }]);
    } finally { undo.forEach((u) => u()); }
});

test('a private notebook\'s own base carries no organisation, so an org admin cannot read its sources', async () => {
    const created = [];
    const undo = [
        // A standalone notebook: every notebook is stamped with its owner's org.
        swap(notebookStore, 'getNotebook', async (id) => ({ id, userId: 'alice', name: 'Diary', organizationId: 'org1', knowledgeBaseIds: [], role: 'owner' })),
        swap(kbStore, 'createKB', async (tenantId, name, description, organizationId, extra) => {
            created.push({ id: 'kb-private', tenant_id: tenantId, organization_id: organizationId, source_kind: extra.sourceKind, is_published: false, shared_groups: '[]' });
            return { id: 'kb-private', name };
        }),
        swap(notebookStore, 'attachKnowledgeBaseIfAbsent', async (_id, _ownerId, kbId) => kbId),
    ];
    try {
        await ensureNotebookKBFor('nb-private', 'alice');
        const [row] = created;
        assert.strictEqual(row.organization_id, null);
        // The generic ACL's org-admin rule reads every base of the admin's org.
        assert.strictEqual(kbStore.canUserAccessKB(row, 'olga-admin', new Set(['org1']), [], { isOrgAdmin: true }), false,
            'an org admin of the notebook owner\'s org does not reach the base');
        assert.strictEqual(kbStore.canUserAccessKB(row, 'alice', new Set(['org1']), [], {}), true, 'the owner still does');
    } finally { undo.forEach((u) => u()); }
});

test('the notebook\'s own base is read by role; any other base by the caller\'s own access', async () => {
    const kbs = {
        own: { id: 'own', source_kind: 'notebook_auto', tenant_id: 'alice' },
        foreignAuto: { id: 'foreignAuto', source_kind: 'notebook_auto', tenant_id: 'zed' },
        manual: { id: 'manual', source_kind: 'manual', tenant_id: 'alice' },
    };
    const asked = [];
    const out = await partitionNotebookKbIds({ session: { user: { id: 'erin' } } }, {
        userId: 'alice', knowledgeBaseIds: ['manual', 'own', 'foreignAuto', 'gone'],
    }, {
        kbStore: { getKB: async (id) => kbs[id] || null },
        partition: async (_req, ids) => { asked.push(...ids); return { allowed: [], denied: ids }; },
    });
    assert.deepStrictEqual(out.allowed, ['own']);
    assert.deepStrictEqual(asked, ['manual', 'foreignAuto', 'gone'], 'everything but the notebook\'s own base went through the KB ACL');
    assert.deepStrictEqual(out.denied, ['manual', 'foreignAuto', 'gone']);
});

test('the feed hears only filed notebooks, and ids and counts only', async () => {
    const calls = [];
    const feed = makeNotebookFeed({
        recordContentChange: async (a) => { calls.push(['content', a]); },
        recordItemRenamed: async (a) => { calls.push(['renamed', a]); },
        recordItemCreated: async () => { throw new Error('feed down'); },
        recordItemMoved: async (a) => { calls.push(['moved', a]); },
    });
    await feed.contentChanged({ projectId: null, notebookId: 'nb1', contributors: [], source: 'named' });
    await feed.renamed({ projectId: '', notebookId: 'nb1', actorId: 'erin' });
    assert.deepStrictEqual(calls, [], 'a standalone notebook has no feed');

    await feed.renamed({ projectId: 'p1', notebookId: 'nb1', actorId: 'erin' });
    await feed.sourcesAdded({ projectId: 'p1', notebookId: 'nb1', actorId: 'erin', count: 3 });
    await feed.created({ projectId: 'p1', notebookId: 'nb1', actorId: 'erin' });   // a failing feed costs a log line
    await feed.moved({ projectId: 'p1', notebookId: 'nb1', actorId: 'erin', direction: 'sideways' });
    assert.deepStrictEqual(calls, [
        ['renamed', { projectId: 'p1', itemType: 'notebook', itemId: 'nb1', actorId: 'erin' }],
        ['content', {
            projectId: 'p1', itemType: 'notebook', itemId: 'nb1', contributors: [{ userId: 'erin', kind: 'user' }],
            stats: { sourcesAdded: 3 }, versionId: null, source: 'checkpoint',
        }],
        ['moved', { projectId: 'p1', itemType: 'notebook', itemId: 'nb1', actorId: 'erin', direction: 'in' }],
    ]);
    await makeNotebookFeed(null).renamed({ projectId: 'p1', notebookId: 'nb1', actorId: 'erin' });
});

test('without a co-editing engine a notebook stays single-writer; a failing engine reads as not co-edited', async () => {
    assert.strictEqual(await notebookCollab.isCollabActive('nb1', null), false);
    assert.deepStrictEqual(await notebookCollab.applyEdit('nb1', { origin: 'ai', actorId: 'u1' }, { html: '<p>x</p>' }, null), { applied: false });
    const broken = { isActive: async () => { throw new Error('db down'); }, applyServerEdit: async () => ({ applied: true }) };
    assert.strictEqual(await notebookCollab.isCollabActive('nb1', broken), false);
    assert.deepStrictEqual(await notebookCollab.applyEdit('nb1', { origin: 'ai', actorId: 'u1' }, { html: '<p>x</p>' }, broken), { applied: false });
    const stored = await notebookCollab.readCurrentContent({ id: 'nb1', documentContent: '<p>row</p>', documentMd: 'row' }, broken);
    assert.deepStrictEqual(stored, { html: '<p>row</p>', markdown: 'row', live: false, active: false, seq: null });
});
