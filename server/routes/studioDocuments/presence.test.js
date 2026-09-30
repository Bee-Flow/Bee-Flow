'use strict';

/**
 * The presence heartbeat of a designed document (studioDocuments/presence.js)
 * and the registry behind it (core/documents/sectionPresence.js): who may say
 * they are here, what the others learn, what goes over the project stream.
 *
 * Run: cd server && node --test routes/studioDocuments/presence.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');
const presence = require('../../core/documents/sectionPresence');
const { makeDocumentPresenceRouter } = require('./presence');

const ROLES = { owner: undefined, editor: 'editor', viewer: 'viewer' };
const published = [];
const router = makeDocumentPresenceRouter({
    documents: {
        async getDocument(id, userId) {
            if (!(userId in ROLES)) return null;
            if (id === 'd1') return { id, projectId: 'p1', ...(ROLES[userId] ? { projectRole: ROLES[userId] } : {}) };
            if (id === 'solo') return userId === 'owner' ? { id, projectId: null } : null;
            return null;
        },
    },
    presence,
    publishTransient: async (projectId, event) => { published.push([projectId, event]); },
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Authentication required' })),
    limiter: (req, res, next) => next(),
    describePeople: async (ids) => Object.fromEntries(ids.map((id) => [id, { name: `Name of ${id}` }])),
    log: { warn() {} },
});
const api = h.serve('/api/studio-documents', router);
test.after(api.close);
test.beforeEach(() => { presence._reset(); published.length = 0; });

const as = (id) => ({ id, organizationId: 'org1' });
const beat = (user, body, id = 'd1') => api.call('POST', `/api/studio-documents/${id}/presence`, { user: as(user), body });

test('an editor says where they are; the others see it, and it goes out on the project stream as ids only', async () => {
    const first = await beat('editor', { clientId: 'client-editor', sectionId: 'pricing', state: 'editing' });
    assert.strictEqual(first.status, 200, first.text);
    assert.deepStrictEqual(first.body.peers, [], 'nobody else yet');
    assert.strictEqual(first.body.ttlMs, presence.PRESENCE_TTL_MS);

    const second = await beat('viewer', { clientId: 'client-viewer', state: 'viewing' });
    assert.deepStrictEqual(second.body.peers.map(p => [p.userId, p.sectionId, p.state]), [['editor', 'pricing', 'editing']]);
    assert.deepStrictEqual(second.body.people, { editor: { name: 'Name of editor' } });

    assert.deepStrictEqual(published[0], ['p1', {
        kind: 'document.presence', actorId: 'editor', targetType: 'document', targetId: 'd1',
        payload: { documentId: 'd1', clientId: 'client-editor', sectionId: 'pricing', state: 'editing' },
    }]);
});

test('a viewer cannot claim to be editing; a stranger learns nothing', async () => {
    const viewer = await beat('viewer', { clientId: 'client-viewer', sectionId: 'x', state: 'editing' });
    assert.strictEqual(viewer.status, 403);
    assert.strictEqual(viewer.body.code, 'document_read_only');
    assert.strictEqual((await beat('stranger', { clientId: 'client-strange', state: 'viewing' })).status, 404);
    assert.strictEqual((await api.call('POST', '/api/studio-documents/d1/presence', { user: null, body: { clientId: 'client-anon', state: 'viewing' } })).status, 401);
    assert.deepStrictEqual(published, []);
    assert.deepStrictEqual(presence.list('d1'), []);
});

test('leaving removes the entry; only its own user can end it', async () => {
    await beat('editor', { clientId: 'client-editor', sectionId: 'a', state: 'editing' });
    await beat('owner', { clientId: 'client-editor', state: 'left' });
    assert.strictEqual(presence.list('d1').length, 1, 'somebody else\'s client id is not theirs to end');
    await beat('editor', { clientId: 'client-editor', state: 'left' });
    assert.deepStrictEqual(presence.list('d1'), []);
});

test('a private document is presence for its owner only, and nothing is published', async () => {
    const res = await beat('owner', { clientId: 'client-owner', state: 'editing', sectionId: null }, 'solo');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(published, []);
});

test('the registry forgets a client after the TTL and keeps `since` while the section stays', () => {
    const t0 = 1_000_000;
    presence.beat('doc', { userId: 'u1', clientId: 'c1', sectionId: 's1', state: 'editing' }, t0);
    presence.beat('doc', { userId: 'u1', clientId: 'c1', sectionId: 's1', state: 'editing' }, t0 + 10_000);
    assert.strictEqual(presence.list('doc', t0 + 10_000)[0].since, t0);
    presence.beat('doc', { userId: 'u1', clientId: 'c1', sectionId: 's2', state: 'editing' }, t0 + 20_000);
    assert.strictEqual(presence.list('doc', t0 + 20_000)[0].since, t0 + 20_000, 'a new section is a new stay');
    presence.beat('doc', { userId: 'u2', clientId: 'c1', sectionId: 's9', state: 'editing' }, t0 + 21_000);
    assert.strictEqual(presence.list('doc', t0 + 21_000)[0].userId, 'u1', 'a client id is not taken over');
    assert.deepStrictEqual(presence.list('doc', t0 + 20_000 + presence.PRESENCE_TTL_MS + 1), []);
});
