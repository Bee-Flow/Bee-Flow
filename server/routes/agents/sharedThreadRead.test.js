'use strict';

/**
 * Opening an agent conversation: the owner as before, a project member
 * read-only on a SHARED thread, everybody else 404
 * (routes/agents/sharedThreadRead.js, mounted by routes/agents/conversations.js).
 *
 * Served with injected fakes through core/http/routeHarness `serve()` — no
 * module mocking. The access fake follows the real rule in
 * stores/agent/conversationAccess.js: the owner; a member of the project a
 * thread is SHARED into; nobody for a private thread.
 *
 * Proven:
 *   - a viewer and an editor may read a shared thread; the answer is a
 *     projection (no token map, no meta, no workspace, no filing) and says
 *     whether they may post;
 *   - the member read is opened WITHOUT the member's session key;
 *   - a private thread, a non-member, a wrong agent id: 404, and the row is
 *     never opened for a non-member;
 *   - the owner's answer is unchanged, opened with the owner's key;
 *   - an unavailable project key is a 503, never an empty chat;
 *   - a guest without a session keeps the owner-only path.
 *
 * Run: cd server && node --test routes/agents/sharedThreadRead.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { serve } = require('../../core/http/routeHarness');
const { makeReadAgentConversation } = require('./sharedThreadRead');

const OWNER = { id: 'u_owner', organizationId: 'org1' };
const VIEWER = { id: 'u_viewer', organizationId: 'org1' };
const EDITOR = { id: 'u_editor', organizationId: 'org1' };
const STRANGER = { id: 'u_stranger', organizationId: 'org1' };

const ROLES = { p1: { u_viewer: 'viewer', u_editor: 'editor' } };
const THREADS = {
    shared: { id: 'shared', agent_id: 'a1', user_id: 'u_owner', project_id: 'p1', shared_scope: 'project' },
    private: { id: 'private', agent_id: 'a1', user_id: 'u_owner', project_id: 'p1', shared_scope: 'private' },
};

const opened = [];
let projectKeyDown = false;

async function resolveConversationAccess(convId, viewerId) {
    const row = THREADS[convId];
    if (!row) return null;
    const isOwner = row.user_id === viewerId;
    let projectRole = null;
    if (!isOwner) {
        if (row.shared_scope !== 'project' || !row.project_id) return null;
        projectRole = ROLES[row.project_id]?.[viewerId] || null;
        if (!projectRole) return null;
    }
    return {
        id: row.id, ownerId: row.user_id, projectId: row.project_id, isOwner, projectRole,
        canRead: true, canPost: isOwner || projectRole === 'editor', canManage: isOwner,
    };
}

async function getConversationById(convId, encryptionKey) {
    opened.push({ convId, encryptionKey });
    if (projectKeyDown) throw Object.assign(new Error('no org root key'), { code: 'PROJECT_KEY_UNAVAILABLE' });
    const row = THREADS[convId];
    if (!row) return null;
    return {
        ...row,
        title: 'Launch plan',
        messages: [{ role: 'user', content: 'When do we launch?' }, { role: 'assistant', content: 'In May.' }],
        meta: { conversationSummary: 'owner-only state' },
        pii_token_map: { '[person_1]': 'A. Person' },
        workspace_content: 'owner notes',
        labels_json: '["mine"]',
        pinned: true,
        threadTitles: {},
        created_at: '2026-09-01T10:00:00Z',
        updated_at: '2026-09-02T10:00:00Z',
    };
}

const router = express.Router();
router.get('/:id/conversations/:convId', makeReadAgentConversation({
    getConversationById,
    resolveConversationAccess,
    getEffectiveUserId: (req) => req.session?.user?.id || 'guest_x',
}));
const api = serve('/agents', router, { session: { encryptionKey: 'session-dek' } });
test.after(api.close);
test.beforeEach(() => { opened.length = 0; projectKeyDown = false; });

test('a viewer reads a shared thread, read-only, as a projection', async () => {
    const res = await api.call('GET', '/agents/a1/conversations/shared', { user: VIEWER });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.title, 'Launch plan');
    assert.strictEqual(res.body.messages.length, 2);
    assert.strictEqual(res.body.ownerId, 'u_owner');
    assert.strictEqual(res.body.readOnly, true);
    assert.deepStrictEqual(res.body.access, { isOwner: false, role: 'viewer', canPost: false, canManage: false });
    for (const ownerOnly of ['pii_token_map', 'meta', 'workspace_content', 'labels_json', 'pinned']) {
        assert.ok(!(ownerOnly in res.body), `${ownerOnly} reached a member`);
    }
    assert.deepStrictEqual(opened, [{ convId: 'shared', encryptionKey: null }], 'a member read must not carry the member\'s key');
});

test('an editor reads it too, and is told they may post', async () => {
    const res = await api.call('GET', '/agents/a1/conversations/shared', { user: EDITOR });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.readOnly, false);
    assert.strictEqual(res.body.access.canPost, true);
});

test('a private thread is invisible to members, and is never opened for them', async () => {
    const res = await api.call('GET', '/agents/a1/conversations/private', { user: EDITOR });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(opened, []);
});

test('somebody outside the project gets 404, not 403', async () => {
    const res = await api.call('GET', '/agents/a1/conversations/shared', { user: STRANGER });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(opened, []);
});

test('an unknown conversation is the same 404', async () => {
    const res = await api.call('GET', '/agents/a1/conversations/nope', { user: VIEWER });
    assert.strictEqual(res.status, 404);
});

test('a member naming another agent gets 404', async () => {
    const res = await api.call('GET', '/agents/a2/conversations/shared', { user: VIEWER });
    assert.strictEqual(res.status, 404);
});

test('an unavailable project key is a 503, never an empty conversation', async () => {
    projectKeyDown = true;
    const res = await api.call('GET', '/agents/a1/conversations/shared', { user: VIEWER });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.code, 'PROJECT_KEY_UNAVAILABLE');
});

test('the owner gets the whole row, opened with their own key, as before', async () => {
    const res = await api.call('GET', '/agents/a1/conversations/private', { user: OWNER });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.workspace_content, 'owner notes');
    assert.ok('pii_token_map' in res.body);
    assert.deepStrictEqual(opened, [{ convId: 'private', encryptionKey: 'session-dek' }]);
});

test('without a session only the owner path exists', async () => {
    const res = await api.call('GET', '/agents/a1/conversations/shared', { user: null });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(opened, [{ convId: 'shared', encryptionKey: undefined }]);
});
