'use strict';

/**
 * "My chats in this project" against a real Postgres (@electric-sql/pglite,
 * in-process), built with makeMyProjectChats over the PGlite handle: no module
 * mocking.
 *
 * Proven:
 *   - the caller's own direct AND agent chats filed in the project, newest
 *     first, with `shared` telling filed-private from shared;
 *   - never somebody else's chat, shared or not, and never a chat filed in
 *     another project or in none;
 *   - encrypted titles are opened with the caller's context, per type; a title
 *     that will not open reads as null instead of failing the list;
 *   - the limit is capped;
 *   - an install from before sharing (no shared_scope column) still lists,
 *     with nothing shared.
 *
 * Run: cd server && node --test projects/myProjectChats.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { pgliteDb } = require('../testUtils/pgliteDb');
const { sealTitle } = require('../stores/agent/conversationTitle');
const { makeMyProjectChats } = require('./myProjectChats');

const DDL = `
    CREATE TABLE direct_conversations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, project_id TEXT,
        shared_scope TEXT DEFAULT 'private', updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY, agent_id TEXT, user_id TEXT NOT NULL, title TEXT, project_id TEXT,
        shared_scope TEXT DEFAULT 'private', updated_at TIMESTAMPTZ DEFAULT now()
    );`;

// The caller's title key context, as resolveCrypto would hand it back.
const CTX = { backgroundKey: crypto.randomBytes(32), encryptTitle: true };
const OTHER_CTX = { backgroundKey: crypto.randomBytes(32), encryptTitle: true };

const { pg, db } = pgliteDb();
const asked = [];
const chats = makeMyProjectChats(db, {
    resolveCrypto: async (opts) => { asked.push(opts); return CTX; },
});

async function direct(id, { user = 'me', project = 'p1', title = id, scope = 'private', at, ctx = CTX } = {}) {
    await pg.query(
        'INSERT INTO direct_conversations (id, user_id, title, project_id, shared_scope, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, user, sealTitle(title, id, 'direct', ctx), project, scope, at],
    );
}
async function agentChat(id, { user = 'me', project = 'p1', title = id, scope = 'private', at, agent = 'a1' } = {}) {
    await pg.query(
        'INSERT INTO agent_conversations (id, agent_id, user_id, title, project_id, shared_scope, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, agent, user, sealTitle(title, id, 'agent', CTX), project, scope, at],
    );
}

before(async () => {
    await pg.exec(DDL);
    await direct('d_private', { title: 'Budget draft', at: '2026-09-03T10:00:00Z' });
    await direct('d_shared', { title: 'Launch questions', scope: 'project', at: '2026-09-05T10:00:00Z' });
    await agentChat('a_shared', { title: 'Research with the analyst', scope: 'project', at: '2026-09-04T10:00:00Z', agent: 'agent-7' });
    // Not mine, filed elsewhere, or filed nowhere.
    await direct('d_theirs', { user: 'someone', scope: 'project', at: '2026-09-06T10:00:00Z' });
    await agentChat('a_theirs', { user: 'someone', at: '2026-09-06T10:00:00Z' });
    await direct('d_other_project', { project: 'p2', at: '2026-09-06T10:00:00Z' });
    await direct('d_unfiled', { project: null, at: '2026-09-06T10:00:00Z' });
    // A title sealed under a key that is not the caller's.
    await direct('d_bad_title', { title: 'unreadable', at: '2026-09-01T10:00:00Z', ctx: OTHER_CTX });
});
after(async () => { await pg.close(); });

test('my own direct and agent chats in the project, newest first, with shared marked', async () => {
    const out = await chats.list('me', 'p1');
    assert.deepStrictEqual(out.map(c => c.id), ['d_shared', 'a_shared', 'd_private', 'd_bad_title']);
    const byId = Object.fromEntries(out.map(c => [c.id, c]));
    assert.deepStrictEqual(
        { ...byId.a_shared, updatedAt: undefined },
        { id: 'a_shared', type: 'agent', agentId: 'agent-7', title: 'Research with the analyst', updatedAt: undefined, shared: true },
    );
    assert.strictEqual(byId.d_private.type, 'direct');
    assert.strictEqual(byId.d_private.agentId, null);
    assert.strictEqual(byId.d_private.title, 'Budget draft');
    assert.strictEqual(byId.d_private.shared, false);
    assert.strictEqual(byId.d_shared.shared, true);
    assert.deepStrictEqual(asked, [{ userId: 'me' }], 'one context for the page, the caller\'s');
});

test('a title that will not open is null, and the rest of the list still loads', async () => {
    const out = await chats.list('me', 'p1');
    assert.strictEqual(out.find(c => c.id === 'd_bad_title').title, null);
});

test('never another person\'s chat, another project\'s, or an unfiled one', async () => {
    const ids = (await chats.list('me', 'p1')).map(c => c.id);
    for (const id of ['d_theirs', 'a_theirs', 'd_other_project', 'd_unfiled']) assert.ok(!ids.includes(id), id);
    assert.deepStrictEqual((await chats.list('someone', 'p1')).map(c => c.id).sort(), ['a_theirs', 'd_theirs']);
    assert.deepStrictEqual(await chats.list('me', 'p9'), []);
});

test('the limit is honoured and capped', async () => {
    assert.strictEqual((await chats.list('me', 'p1', { limit: 1 })).length, 1);
    assert.strictEqual((await chats.list('me', 'p1', { limit: 10_000 })).length, 4);
    assert.deepStrictEqual(await chats.list('', 'p1'), []);
});

test('an install without shared_scope still lists, with nothing shared', async () => {
    const legacy = pgliteDb();
    try {
        await legacy.pg.exec(`
            CREATE TABLE direct_conversations (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, project_id TEXT, updated_at TIMESTAMPTZ);
            CREATE TABLE agent_conversations (id TEXT PRIMARY KEY, agent_id TEXT, user_id TEXT, title TEXT, project_id TEXT, updated_at TIMESTAMPTZ);
            INSERT INTO direct_conversations VALUES ('old', 'me', 'Old chat', 'p1', '2026-01-01');`);
        const out = await makeMyProjectChats(legacy.db, { resolveCrypto: async () => CTX }).list('me', 'p1');
        assert.deepStrictEqual(out.map(c => [c.id, c.title, c.shared]), [['old', 'Old chat', false]]);
    } finally {
        await legacy.pg.close();
    }
});
