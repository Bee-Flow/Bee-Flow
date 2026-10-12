'use strict';

/**
 * memoryQueries against a REAL Postgres (@electric-sql/pglite, in-process),
 * through the factory's own seams (no module mocking): the filters, ordering
 * and enrichment behind the Memory screen, and the deletes that must stay
 * inside one person's rows.
 *
 * Run: cd server && node --test stores/memoryQueries.pg.test.js
 */

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { createMemoryQueries } = require('./memoryQueries');
const { hydrateRows, keyHashForWrite, PLAINTEXT_WRITE } = require('./memoryCrypto');

const pg = new PGlite();
const rows = async (sql, params) => (params && params.length ? await pg.query(sql, params) : await pg.query(sql)).rows;
const db = {
    run: async (sql, params) => { await rows(sql, params); },
    getAll: rows,
    getOne: async (sql, params) => (await rows(sql, params))[0] || null,
};

const lifecycleCalls = [];
const q = createMemoryQueries({
    db,
    hydrateRows,
    keyHashForWrite,
    resolveWriteContext: async () => PLAINTEXT_WRITE,
    ensureReady: async () => {},
    lifecycle: () => ({ restorePredecessorOf: async (id) => { lifecycleCalls.push(id); } }),
});

const T = (n) => new Date(Date.UTC(2026, 9, n)).toISOString();

async function put(id, o = {}) {
    await pg.query(`INSERT INTO user_memories
        (id, user_id, agent_id, project_id, type, content, summary, subject, attribute, importance, status, origin, sensitivity,
         source_conversation_id, created_at, updated_at, last_used_at, use_count, key_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [id, o.user ?? 'bob', o.agent ?? null, o.project ?? null, o.type ?? 'fact', o.content ?? `content ${id}`, o.summary ?? null,
        o.subject ?? null, o.attribute ?? null, o.importance ?? 0.5, o.status ?? 'active', o.origin ?? 'inferred', o.sens ?? 'none',
        o.conv ?? null, o.created ?? T(1), o.updated ?? o.created ?? T(1), o.lastUsed ?? null, o.uses ?? 0, o.keyHash ?? null]);
}

before(async () => {
    await pg.exec(`
        CREATE TABLE user_memories (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT, project_id TEXT, type TEXT NOT NULL,
            content TEXT NOT NULL, summary TEXT, subject TEXT, attribute TEXT, value TEXT, confidence REAL DEFAULT 1,
            importance REAL DEFAULT 0.5, status TEXT DEFAULT 'active', origin TEXT DEFAULT 'inferred',
            sensitivity TEXT DEFAULT 'none', source_conversation_id TEXT, key_hash TEXT, superseded_by TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), valid_from TIMESTAMPTZ,
            valid_to TIMESTAMPTZ, expires_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ, use_count INTEGER DEFAULT 0, access_count INTEGER DEFAULT 0,
            embedding_enc TEXT, embedding JSONB, evidence_quote TEXT, archived_at TIMESTAMPTZ
        );
        CREATE TABLE memory_sources (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, conversation_id TEXT NOT NULL);
        CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE users (id TEXT PRIMARY KEY, "displayName" TEXT, username TEXT);
        CREATE TABLE agent_conversations (id TEXT PRIMARY KEY);
        CREATE TABLE direct_conversations (id TEXT PRIMARY KEY);
    `);
});

beforeEach(async () => {
    lifecycleCalls.length = 0;
    await pg.exec(`TRUNCATE user_memories, memory_sources, agents, projects, users, agent_conversations, direct_conversations`);
});

test('the default list is the caller\'s active personal memory, newest first, with every contract field', async () => {
    await put('old', { created: T(1) });
    await put('new', { created: T(5) });
    await put('mine-archived', { status: 'archived' });
    await put('proj', { project: 'p1' });
    await put('alice', { user: 'alice' });
    const page = await q.listMemories('bob', {});
    assert.deepStrictEqual(page.items.map((m) => m.id), ['new', 'old']);
    assert.strictEqual(page.total, 2);
    const m = page.items[0];
    for (const k of ['id', 'type', 'content', 'summary', 'importance', 'origin', 'sensitivity', 'status', 'agent_id', 'agent_name',
        'project_id', 'project_name', 'source_conversation_id', 'source_conversation_kind', 'created_at', 'updated_at',
        'valid_from', 'last_used_at', 'use_count']) assert.ok(k in m, `${k} is present`);
    assert.ok(!('embedding' in m) && !('key_hash' in m) && !('embedding_enc' in m), 'index and vector stay server-side');
});

test('scopes: agent bucket, legacy agent+general, project pool, all', async () => {
    await put('general');
    await put('for-a1', { agent: 'a1' });
    await put('for-a2', { agent: 'a2' });
    await put('pool-bob', { project: 'p1' });
    await put('pool-alice', { user: 'alice', project: 'p1' });
    const ids = async (f) => (await q.listMemories('bob', f)).items.map((m) => m.id).sort();
    assert.deepStrictEqual(await ids({ scope: 'agent', agentId: 'a1' }), ['for-a1']);
    assert.deepStrictEqual(await ids({ scope: 'agent', agentId: 'a1', includeGeneral: true }), ['for-a1', 'general']);
    assert.deepStrictEqual(await ids({ scope: 'agent' }), ['for-a1', 'for-a2']);
    assert.deepStrictEqual(await ids({ scope: 'project', projectId: 'p1' }), ['pool-alice', 'pool-bob']);
    assert.deepStrictEqual(await ids({ scope: 'personal' }), ['for-a1', 'for-a2', 'general']);
    assert.deepStrictEqual(await ids({ scope: 'all', projectId: 'p1' }), ['for-a1', 'for-a2', 'general', 'pool-alice', 'pool-bob']);
});

test('pending and archived rows are private to their owner, even inside a project pool', async () => {
    await put('pool-pending-alice', { user: 'alice', project: 'p1', status: 'pending_review' });
    await put('pool-pending-bob', { user: 'bob', project: 'p1', status: 'pending_review' });
    const page = await q.listMemories('bob', { scope: 'project', projectId: 'p1', status: 'pending_review' });
    assert.deepStrictEqual(page.items.map((m) => m.id), ['pool-pending-bob']);
});

test('filters by type and origin; sorts by importance and by last use', async () => {
    await put('a', { type: 'person', origin: 'explicit', importance: 0.2, lastUsed: T(9), created: T(1) });
    await put('b', { type: 'fact', origin: 'tool', importance: 0.9, lastUsed: null, created: T(2) });
    await put('c', { type: 'fact', origin: 'explicit', importance: 0.5, lastUsed: T(3), created: T(3) });
    const ids = async (f) => (await q.listMemories('bob', f)).items.map((m) => m.id);
    assert.deepStrictEqual(await ids({ type: 'fact' }), ['c', 'b']);
    assert.deepStrictEqual(await ids({ origin: 'explicit', sort: 'importance' }), ['c', 'a']);
    assert.deepStrictEqual(await ids({ sort: 'last_used' }), ['a', 'c', 'b'], 'never-used rows sort last');
    assert.deepStrictEqual(await ids({ sort: 'importance' }), ['b', 'c', 'a']);
});

test('search matches content and treats % and _ as plain characters; paging reports the total', async () => {
    await put('s1', { content: 'I like 100% cotton' });
    await put('s2', { content: 'I like wool' });
    await put('s3', { content: 'I like wool too' });
    assert.deepStrictEqual((await q.listMemories('bob', { search: '100%' })).items.map((m) => m.id), ['s1']);
    assert.strictEqual((await q.listMemories('bob', { search: '_ike' })).total, 0);
    const p = await q.listMemories('bob', { search: 'wool', limit: 1, offset: 1 });
    assert.strictEqual(p.total, 2);
    assert.strictEqual(p.items.length, 1);
});

test('rows are enriched with agent, project, author and chat kind in batched lookups', async () => {
    await pg.exec(`
        INSERT INTO agents VALUES ('a1','Writer'); INSERT INTO projects VALUES ('p1','Site');
        INSERT INTO users VALUES ('alice','Alice A','alice'), ('bob','Bob B','bob');
        INSERT INTO agent_conversations VALUES ('c-agent'); INSERT INTO direct_conversations VALUES ('c-direct');`);
    await put('m-agent', { agent: 'a1', conv: 'c-agent' });
    await put('m-direct', { conv: 'c-direct' });
    await put('m-gone', { conv: 'c-deleted' });
    await put('m-pool', { user: 'alice', project: 'p1' });
    const mine = Object.fromEntries((await q.listMemories('bob', {})).items.map((m) => [m.id, m]));
    assert.deepStrictEqual([mine['m-agent'].agent_name, mine['m-agent'].source_conversation_kind], ['Writer', 'agent']);
    assert.strictEqual(mine['m-direct'].source_conversation_kind, 'direct');
    assert.strictEqual(mine['m-gone'].source_conversation_kind, null, 'a deleted chat is tolerated');
    assert.strictEqual(mine['m-gone'].source_conversation_id, 'c-deleted');
    const pool = (await q.listMemories('bob', { scope: 'project', projectId: 'p1' })).items[0];
    assert.deepStrictEqual([pool.project_name, pool.created_by_name], ['Site', 'Alice A']);
});

test('recent: this conversation, this caller, since the moment, never superseded', async () => {
    await put('fresh', { conv: 'c1', created: T(5) });
    await put('stale', { conv: 'c1', created: T(1) });
    await put('replaced', { conv: 'c1', created: T(6), status: 'superseded' });
    await put('elsewhere', { conv: 'c2', created: T(6) });
    await put('via-source', { conv: null, created: T(7) });
    await pg.exec(`INSERT INTO memory_sources VALUES ('s1','via-source','c1')`);
    await put('theirs', { user: 'alice', conv: 'c1', created: T(6) });
    const items = await q.listRecent('bob', 'c1', T(3));
    assert.deepStrictEqual(items.map((m) => m.id), ['via-source', 'fresh']);
});

test('review queue and stats count the caller\'s own pending rows and origins', async () => {
    await put('p1', { status: 'pending_review', created: T(2) });
    await put('p2', { status: 'pending_review', created: T(1) });
    await put('x', { user: 'alice', status: 'pending_review' });
    await put('act1', { origin: 'explicit', importance: 0.9, updated: T(8) });
    await put('act2', { origin: 'tool', type: 'person', importance: 0.1 });
    const review = await q.listReview('bob', {});
    assert.deepStrictEqual(review.items.map((m) => m.id), ['p2', 'p1']);
    assert.strictEqual(review.total, 2);
    const s = await q.getStats('bob');
    assert.strictEqual(s.total, 2, 'pending rows are not counted as memories');
    assert.strictEqual(s.pendingReview, 2);
    assert.deepStrictEqual(s.byOrigin, { explicit: 1, inferred: 0, imported: 0, tool: 1 });
    assert.deepStrictEqual(s.importanceDistribution, { high: 1, medium: 0, low: 1 });
    assert.strictEqual(new Date(s.lastUpdatedAt).toISOString(), T(8));
});

test('setType retypes, recomputes the blind index, and leaves schedule_coverage alone', async () => {
    const hash = (type) => keyHashForWrite({ type, subject: 'city', attribute: 'home' }, PLAINTEXT_WRITE);
    await put('keyed', { type: 'fact', subject: 'city', attribute: 'home', keyHash: hash('fact') });
    await put('plain', { type: 'fact' });
    await put('cov', { type: 'schedule_coverage' });
    const all = await pg.query('SELECT * FROM user_memories');
    const n = await q.setType(all.rows, 'preference');
    assert.strictEqual(n, 2);
    const after = Object.fromEntries((await pg.query('SELECT id, type, key_hash FROM user_memories')).rows.map((r) => [r.id, r]));
    assert.deepStrictEqual([after.keyed.type, after.plain.type, after.cov.type], ['preference', 'preference', 'schedule_coverage']);
    assert.strictEqual(after.keyed.key_hash, hash('preference'));
});

test('deleteByConversation removes only the caller\'s rows and their sources, restoring predecessors first', async () => {
    await put('mine', { conv: 'c1' });
    await put('mine-src', { conv: null });
    await pg.exec(`INSERT INTO memory_sources VALUES ('s1','mine-src','c1'), ('s2','mine','c1')`);
    await put('other-chat', { conv: 'c2' });
    await put('alices', { user: 'alice', conv: 'c1' });
    await put('alices-pool', { user: 'alice', project: 'p1', conv: 'c1' });
    const deleted = await q.deleteByConversation('bob', 'c1');
    assert.strictEqual(deleted, 2);
    assert.deepStrictEqual(lifecycleCalls.sort(), ['mine', 'mine-src']);
    const left = (await pg.query('SELECT id FROM user_memories ORDER BY id')).rows.map((r) => r.id);
    assert.deepStrictEqual(left, ['alices', 'alices-pool', 'other-chat']);
    assert.strictEqual((await pg.query('SELECT 1 FROM memory_sources')).rows.length, 0);
    assert.strictEqual(await q.deleteByConversation('bob', 'c1'), 0, 'idempotent');
});

test('deleteSensitiveForUser hard-deletes art9 rows in every status, only for that user', async () => {
    await put('s-active', { sens: 'art9' });
    await put('s-archived', { sens: 'art9', status: 'archived' });
    await put('s-pool', { sens: 'art9', project: 'p1' });
    await put('plain');
    await put('alice-s', { user: 'alice', sens: 'art9' });
    await pg.exec(`INSERT INTO memory_sources VALUES ('s1','s-active','c1')`);
    assert.strictEqual(await q.deleteSensitiveForUser('bob'), 3);
    const left = (await pg.query('SELECT id FROM user_memories ORDER BY id')).rows.map((r) => r.id);
    assert.deepStrictEqual(left, ['alice-s', 'plain']);
    assert.strictEqual((await pg.query('SELECT 1 FROM memory_sources')).rows.length, 0);
});

test('deleteSensitiveForOrg removes art9 rows of that org\'s users only, with their sources', async () => {
    await pg.exec(`INSERT INTO users (id) VALUES ('bob'), ('carol'), ('alice')`);
    await pg.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "organizationId" TEXT`);
    await pg.exec(`UPDATE users SET "organizationId" = CASE WHEN id = 'alice' THEN 'o2' ELSE 'o1' END`);
    await put('s1', { sens: 'art9' });
    await put('s2', { sens: 'art9', status: 'pending_review' });
    await put('c-s', { user: 'carol', sens: 'art9' });
    await put('plain');
    await put('alice-s', { user: 'alice', sens: 'art9' });
    await pg.exec(`INSERT INTO memory_sources VALUES ('s1','s1','c1'), ('s9','alice-s','c1')`);
    assert.strictEqual(await q.deleteSensitiveForOrg('o1'), 3);
    const left = (await pg.query('SELECT id FROM user_memories ORDER BY id')).rows.map((r) => r.id);
    assert.deepStrictEqual(left, ['alice-s', 'plain']);
    assert.strictEqual((await pg.query('SELECT 1 FROM memory_sources')).rows.length, 1);
    assert.strictEqual(await q.deleteSensitiveForOrg(null), 0);
});

test('the export holds every status with provenance, and none of another person\'s rows', async () => {
    await put('e1', { origin: 'explicit', sens: 'art9', conv: 'c1', lastUsed: T(4) });
    await put('e2', { status: 'superseded' });
    await put('e3', { user: 'alice' });
    await put('cov', { type: 'schedule_coverage' });
    const out = await q.listForExport('bob');
    assert.deepStrictEqual(out.map((m) => m.id), ['e1', 'e2']);
    assert.deepStrictEqual([out[0].origin, out[0].sensitivity, out[0].status, out[0].source_conversation_id, out[0].content],
        ['explicit', 'art9', 'active', 'c1', 'content e1']);
    assert.strictEqual(out[1].status, 'superseded');
});

test('the retention hard-delete SQL removes only old history, with its sources, in batches', async () => {
    const { HARD_DELETE_SQL } = require('../jobs/memoryRetentionEnforcer');
    const old = new Date(Date.now() - 100 * 86400000).toISOString();
    const recent = new Date(Date.now() - 10 * 86400000).toISOString();
    await put('sup-old', { status: 'superseded', created: old, updated: old });
    await put('exp-old', { status: 'expired', created: old, updated: old });
    await put('arch-old', { status: 'archived', created: old, updated: recent });
    await put('sup-new', { status: 'superseded', created: old, updated: recent });
    await put('active-old', { status: 'active', created: old, updated: old });
    await put('pending-old', { status: 'pending_review', created: old, updated: old });
    await pg.exec(`UPDATE user_memories SET valid_to = '${old}' WHERE id = 'sup-old';
                   UPDATE user_memories SET archived_at = '${old}' WHERE id = 'arch-old';
                   INSERT INTO memory_sources VALUES ('s1','sup-old','c1'), ('s2','active-old','c1')`);
    await put('sup-old2', { status: 'superseded', created: old, updated: old });
    const first = await db.getOne(HARD_DELETE_SQL, ['90', 1]);
    assert.strictEqual(first.n, 1, 'the batch limit holds');
    const second = await db.getOne(HARD_DELETE_SQL, ['90', 1]);
    assert.strictEqual(second.n, 1);
    assert.strictEqual((await db.getOne(HARD_DELETE_SQL, ['90', 2])).n, 0, 'idempotent');
    // Only superseded history goes here; archived/expired rows are restorable memories and
    // are deleted by RESTORABLE_DELETE_SQL, for orgs with retention enabled only.
    const left = (await pg.query('SELECT id FROM user_memories ORDER BY id')).rows.map((r) => r.id);
    assert.deepStrictEqual(left, ['active-old', 'arch-old', 'exp-old', 'pending-old', 'sup-new']);
    assert.deepStrictEqual((await pg.query('SELECT memory_id FROM memory_sources')).rows.map((r) => r.memory_id), ['active-old']);
});

test('a project pool list shows art. 9 rows only to their own person', async () => {
    await put('pool-plain', { user: 'alice', project: 'p1' });
    await put('pool-art9-alice', { user: 'alice', project: 'p1', sens: 'art9' });
    await put('pool-art9-bob', { user: 'bob', project: 'p1', sens: 'art9' });
    const asBob = await q.listMemories('bob', { scope: 'project', projectId: 'p1' });
    assert.deepStrictEqual(asBob.items.map((m) => m.id).sort(), ['pool-art9-bob', 'pool-plain']);
    assert.strictEqual(asBob.total, 2);
    const all = await q.listMemories('bob', { scope: 'all', projectId: 'p1' });
    assert.ok(!all.items.some((m) => m.id === 'pool-art9-alice'));
});

test('listActiveByIds returns only readable active rows: never another person\'s art. 9, pending or pool rows without a role', async () => {
    await put('mine', {});
    await put('mine-pending', { status: 'pending_review' });
    await put('mine-art9', { sens: 'art9' });
    await put('alice-personal', { user: 'alice' });
    await put('alice-art9-pool', { user: 'alice', project: 'p1', sens: 'art9' });
    await put('pool-ok', { user: 'alice', project: 'p1' });
    await put('pool-no-role', { user: 'alice', project: 'p2' });
    const ids = ['mine', 'mine-pending', 'mine-art9', 'alice-personal', 'alice-art9-pool', 'pool-ok', 'pool-no-role', 'ghost'];
    const got = await q.listActiveByIds('bob', ids, { canReadProject: async (p) => p === 'p1' });
    assert.deepStrictEqual(got.map((m) => m.id).sort(), ['mine', 'mine-art9', 'pool-ok']);
    assert.deepStrictEqual(await q.listActiveByIds('bob', ids), got.filter((m) => !m.project_id), 'without a role check no pool row is returned');
});
