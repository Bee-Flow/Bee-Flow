/**
 * The write path for a shared thread.
 *
 * Three things had to change for a second person to be able to post into a
 * conversation, and all three failed SILENTLY before:
 *
 *   1. THE PREDICATE. Every write ends `AND user_id = $n` with the CALLER's id.
 *      Member B posting into A's thread matched zero rows, and the four call
 *      sites in directChat.js ignore the returned boolean — so B would watch a
 *      complete answer stream in and find it gone on reload.
 *
 *   2. THE KEY. Both write paths did `resolveCrypto({ userId, encryptionKey })`
 *      with the requesting user. B replying would have re-encrypted A's entire
 *      conversation under B's key, locking A out of their own thread.
 *
 *   3. THE ARRAY. replaceMessages is a full DELETE + re-INSERT of whatever the
 *      caller is holding. If Alice posted while Bob had the thread open, Bob's
 *      write would delete her message outright.
 *
 * Run: cd server && node --test stores/agent/sharedWrite.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');

const fx = {
    rows: {},            // conversation id -> row
    roles: {},           // `${userId}|${projectId}` -> role
    stored: {},          // conversation id -> messages already persisted
    calls: [],
    cryptoCalls: [],
};

function mock(absId, exports) {
    const p = require.resolve(absId);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

mock(path.join(SERVER, 'db'), {
    async getOne(sql, params) {
        if (/FROM direct_conversations/i.test(sql)) {
            const row = fx.rows[params[0]];
            if (!row) return null;
            // The owner-scoped variants carry a second parameter.
            if (params.length > 1 && /user_id = \$2/.test(sql) && row.user_id !== params[1]) return null;
            if (/shared_scope = 'project'/.test(sql) && row.shared_scope !== 'project') return null;
            return { ...row };
        }
        return null;
    },
    async getAll() { return []; },
    async run(sql, params) {
        fx.calls.push({ sql, params });
        if (/DELETE FROM conversation_messages/i.test(sql)) {
            fx.calls.push({ op: 'wipeMessages', id: params[0] });
            delete fx.stored[params[0]];
            return { rowCount: 1 };
        }
        if (/DELETE FROM direct_conversations/i.test(sql)) {
            const row = fx.rows[params[0]];
            if (row && row.user_id === params[1]) { delete fx.rows[params[0]]; return { rowCount: 1 }; }
            return { rowCount: 0 };
        }
        if (/UPDATE direct_conversations/i.test(sql)) {
            const id = params[params.length - 2];
            const owner = params[params.length - 1];
            const row = fx.rows[id];
            return { rowCount: row && row.user_id === owner ? 1 : 0 };
        }
        return { rowCount: 0 };
    },
    async getClient() { throw new Error('not used'); },
});

mock(path.join(SERVER, 'stores', 'agent', 'initSchema'), { initDB: async () => {} });
mock(path.join(SERVER, 'stores', 'agent', 'messageEncryption'), {
    encryptMessages: (v) => v,
    decryptMessages: (v) => v,
});
mock(path.join(SERVER, 'stores', 'agent', 'conversationTitle'), {
    sealTitle: (t) => t, openTitle: (t) => t, openTitles: (r) => r,
});
mock(path.join(SERVER, 'stores', 'lib', 'fieldEnvelope'), {
    encryptField: (v) => v,
    decryptField: (v) => v,
    isEnvelope: () => false,
});
mock(path.join(SERVER, 'stores', 'agent', 'messageCrypto'), {
    // Records WHICH key was requested — the assertion that matters most here.
    resolveCrypto: async (opts) => {
        fx.cryptoCalls.push(opts);
        return {
            key: null,
            keyLabel: opts.projectKeyFor ? `project:${opts.projectKeyFor.projectId}` : `user:${opts.userId}`,
            encryptMessages: false,
        };
    },
    conversationKey: () => null,
});
mock(path.join(SERVER, 'stores', 'agent', 'conversationMessages'), {
    async getMessages(id) { return fx.stored[id] || []; },
    async replaceMessages(id, type, messages) {
        fx.calls.push({ op: 'replace', id, count: messages.length });
        fx.stored[id] = [...messages];
    },
    async appendMessages(id, type, messages) {
        fx.calls.push({ op: 'append', id, count: messages.length });
        fx.stored[id] = [...(fx.stored[id] || []), ...messages];
    },
});
const fxDlpCleared = [];
mock(path.join(SERVER, 'core', 'dlp', 'dlpRunner'), {
    clearConversationState: (id) => fxDlpCleared.push(id),
});
mock(path.join(SERVER, 'auth', 'projectAccess'), {
    hasProjectRole: async (userId, projectId, minRole) => {
        const role = fx.roles[`${userId}|${projectId}`];
        if (!role) return false;
        const order = { viewer: 0, editor: 1, owner: 2 };
        return order[role] >= order[minRole];
    },
});

const store = require('./directConversations');

function resetFx() {
    fx.rows = {};
    fx.roles = {};
    fx.stored = {};
    fx.calls.length = 0;
    fx.cryptoCalls.length = 0;
    fxDlpCleared.length = 0;
}

function sharedConv({ id = 'c1', owner = 'alice', project = 'p1' } = {}) {
    fx.rows[id] = {
        id, user_id: owner, project_id: project,
        shared_scope: 'project', crypto_scope: 'project',
        messages_migrated: true, meta_json: null,
    };
    return id;
}
function privateConv({ id = 'c2', owner = 'alice' } = {}) {
    fx.rows[id] = {
        id, user_id: owner, project_id: null,
        shared_scope: 'private', crypto_scope: 'user',
        messages_migrated: true, meta_json: null,
    };
    return id;
}

const M = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }));

// ═══ 1. The predicate ════════════════════════════════════════════════

test('an editor member can write to a shared thread they do not own', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'editor';

    const ok = await store.updateDirectConversation(id, M(1), 'bob');
    assert.strictEqual(ok, true);

    // The UPDATE must key on the OWNER, not on Bob — otherwise zero rows.
    const upd = fx.calls.find(c => c.sql && /UPDATE direct_conversations/.test(c.sql));
    assert.strictEqual(upd.params[upd.params.length - 1], 'alice');
});

test('a VIEWER member cannot write to a shared thread', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'viewer';

    await assert.rejects(
        () => store.updateDirectConversation(id, M(1), 'bob'),
        (e) => e.code === 'CONVERSATION_WRITE_DENIED'
    );
});

test('a non-member cannot write to a shared thread', async () => {
    resetFx();
    const id = sharedConv();

    await assert.rejects(
        () => store.updateDirectConversation(id, M(1), 'mallory'),
        (e) => e.code === 'CONVERSATION_WRITE_DENIED'
    );
});

test('a PRIVATE conversation stays owner-only, whatever the project role', async () => {
    resetFx();
    const id = privateConv();
    fx.roles['bob|p1'] = 'owner';       // irrelevant: the conversation is private

    await assert.rejects(
        () => store.updateDirectConversation(id, M(1), 'bob'),
        (e) => e.code === 'CONVERSATION_WRITE_DENIED'
    );
});

test('a failed write THROWS instead of returning false into a caller that ignores it', async () => {
    resetFx();
    // No such conversation at all.
    await assert.rejects(
        () => store.updateDirectConversation('ghost', M(1), 'alice'),
        (e) => e.code === 'CONVERSATION_WRITE_DENIED'
    );
});

// ═══ 2. The key ══════════════════════════════════════════════════════

test('a shared thread is written with the PROJECT key, not the writer\'s', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'editor';

    await store.updateDirectConversation(id, M(1), 'bob', null, { encryptionKey: 'bobs-session-dek' });

    const used = fx.cryptoCalls.find(c => c.projectKeyFor);
    assert.ok(used, 'the project key must be requested');
    assert.strictEqual(used.projectKeyFor.projectId, 'p1');
    assert.ok(
        !fx.cryptoCalls.some(c => c.encryptionKey === 'bobs-session-dek'),
        "Bob's own session key must never key Alice's thread",
    );
});

test('a private conversation still uses the owner + session key', async () => {
    resetFx();
    const id = privateConv();

    await store.updateDirectConversation(id, M(1), 'alice', null, { encryptionKey: 'alice-dek' });

    const used = fx.cryptoCalls.at(-1);
    assert.strictEqual(used.userId, 'alice');
    assert.strictEqual(used.encryptionKey, 'alice-dek');
    assert.ok(!used.projectKeyFor, 'no project key for a private conversation');
});

// ═══ 3. The array ════════════════════════════════════════════════════

test('a shared thread APPENDS only what is new', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'editor';
    fx.stored[id] = M(3);                       // Alice already posted 3

    await store.updateDirectConversation(id, M(5), 'bob');

    const write = fx.calls.find(c => c.op);
    assert.strictEqual(write.op, 'append');
    assert.strictEqual(write.count, 2, 'only the two new messages');
    assert.strictEqual(fx.stored[id].length, 5, 'nothing was deleted');
});

test('a stale array from one member cannot delete another\'s message', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'editor';
    fx.stored[id] = M(4);                       // Alice posted while Bob had it open

    // Bob's client still believes there are 3 messages and sends 3.
    await store.updateDirectConversation(id, M(3), 'bob');

    // Shorter than stored = an edit/truncate, which legitimately replaces —
    // but the point is it is a DELIBERATE path, not an accident of staleness.
    const write = fx.calls.find(c => c.op);
    assert.strictEqual(write.op, 'replace');
});

test('a shared thread with nothing new writes no messages at all', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'editor';
    fx.stored[id] = M(3);

    await store.updateDirectConversation(id, M(3), 'bob');

    assert.ok(!fx.calls.some(c => c.op), 'no message write for a no-op turn');
});

test('a PRIVATE conversation keeps the replace path unchanged', async () => {
    resetFx();
    const id = privateConv();
    fx.stored[id] = M(2);

    await store.updateDirectConversation(id, M(4), 'alice');

    const write = fx.calls.find(c => c.op);
    assert.strictEqual(write.op, 'replace', 'private conversations are untouched by this change');
    assert.strictEqual(write.count, 4);
});

// ═══ Reading a shared thread ═════════════════════════════════════════

test('a member can READ a shared thread they do not own', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'viewer';
    fx.stored[id] = M(2);

    const conv = await store.getDirectConversation(id, 'bob');
    assert.ok(conv, 'a viewer can open a shared thread');
    assert.ok(
        fx.cryptoCalls.some(c => c.projectKeyFor?.projectId === 'p1'),
        'and it is opened with the project key',
    );
});

test('a non-member reading a shared thread gets nothing', async () => {
    resetFx();
    const id = sharedConv();

    assert.strictEqual(await store.getDirectConversation(id, 'mallory'), null);
});

// ═══ 4. Deleting ═════════════════════════════════════════════════════
// The message wipe keys on the conversation id ALONE — conversation_messages
// has no user_id to scope it with — so it has to run AFTER the ownership check,
// never before it. Running it first meant a 404 was returned while the owner's
// messages were already gone.

test('a non-owner delete destroys nothing', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'editor';              // even an editor is not the owner
    fx.stored[id] = M(3);

    assert.strictEqual(await store.deleteDirectConversation(id, 'bob'), false);
    assert.strictEqual(fx.stored[id].length, 3, "the owner's messages must survive");
    assert.ok(!fx.calls.some(c => c.op === 'wipeMessages'), 'no DELETE was issued at all');
    assert.deepStrictEqual(fxDlpCleared, [], 'and no pii_token_map was cleared');
    assert.ok(fx.rows[id], 'the conversation itself is still there');
});

test('a delete by someone who merely knows the id destroys nothing', async () => {
    resetFx();
    const id = sharedConv();
    fx.stored[id] = M(2);

    assert.strictEqual(await store.deleteDirectConversation(id, 'mallory'), false);
    assert.strictEqual(fx.stored[id].length, 2);
    assert.ok(!fx.calls.some(c => c.op === 'wipeMessages'));
});

test('the OWNER can still delete, messages and DLP state included', async () => {
    resetFx();
    const id = privateConv();
    fx.stored[id] = M(2);

    assert.strictEqual(await store.deleteDirectConversation(id, 'alice'), true);
    assert.ok(fx.calls.some(c => c.op === 'wipeMessages' && c.id === id));
    assert.deepStrictEqual(fxDlpCleared, [id]);
    assert.ok(!fx.rows[id]);
});

test('deleting an id that does not exist is a no-op, not a wipe', async () => {
    resetFx();
    assert.strictEqual(await store.deleteDirectConversation('ghost', 'alice'), false);
    assert.ok(!fx.calls.some(c => c.op === 'wipeMessages'));
});

// ═══ 5. The workspace ════════════════════════════════════════════════
// canPost is editor+, canManage is the OWNER only (see conversationAccess.js).
// The workspace is canManage territory and the write carried no predicate at
// all, so a read-only project member could overwrite it.

test('a viewer cannot overwrite the owner\'s workspace', async () => {
    resetFx();
    const id = sharedConv();
    fx.roles['bob|p1'] = 'viewer';

    assert.strictEqual(await store.updateDirectConversationWorkspace(id, 'bob was here', 'nb-evil', 'bob'), false);
});

test('the owner can write their own workspace', async () => {
    resetFx();
    const id = sharedConv();
    assert.strictEqual(await store.updateDirectConversationWorkspace(id, 'notes', 'nb-1', 'alice'), true);
    const upd = fx.calls.filter(c => c.sql && /workspace_content/.test(c.sql)).at(-1);
    assert.strictEqual(upd.params.at(-1), 'alice', 'the UPDATE carries the owner predicate');
});

test('a workspace write with no notebook still carries the owner predicate', async () => {
    resetFx();
    const id = sharedConv();
    assert.strictEqual(await store.updateDirectConversationWorkspace(id, 'notes', null, 'alice'), true);
    const upd = fx.calls.filter(c => c.sql && /workspace_content/.test(c.sql)).at(-1);
    assert.ok(/AND user_id = \$3/.test(upd.sql), upd.sql);
    assert.deepStrictEqual(upd.params, ['notes', id, 'alice']);
});

test('a member cannot read a PRIVATE conversation filed under their project', async () => {
    resetFx();
    // Filed into the project but never shared — the two are different acts.
    fx.rows.c3 = {
        id: 'c3', user_id: 'alice', project_id: 'p1',
        shared_scope: 'private', crypto_scope: 'user',
        messages_migrated: true, meta_json: null,
    };
    fx.roles['bob|p1'] = 'editor';

    assert.strictEqual(await store.getDirectConversation('c3', 'bob'), null,
        'filing a chat under a project must not publish it');
});
