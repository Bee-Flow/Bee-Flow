// @typecheck
/**
 * Conversation search for the agent and the direct table: one strategy set
 * (A: title / migrated content in SQL, A2: encrypted migrated rows decrypted in
 * the app, B: plaintext legacy blob in SQL, C: encrypted legacy blob in the
 * app). The SQL strategies run on a real Postgres (the boot ladder's schema on
 * PGlite, testUtils/pgliteTemplate.js); the crypto functions are injected, as
 * the stores do.
 *
 * Run: cd server && node --test stores/lib/conversationSearch.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');
const { searchConversationRows, byUpdatedDesc, AGENT_SEARCH, DIRECT_SEARCH } = require('./conversationSearch');

const pg = ladderPglite();
test.after(() => pg.close());

let cryptoCtx = { encryptMessages: false, encryptTitle: false };
const msgReads = [];

const deps = {
    getAll: async (sql, params) => (await pg.query(sql, params)).rows,
    async resolveCrypto() { return cryptoCtx; },
    // An "encrypted" title is base64 behind a marker: opaque to ILIKE, readable to the app.
    openTitle: (stored) => (typeof stored === 'string' && stored.startsWith('ENC:') ? Buffer.from(stored.slice(4), 'base64').toString() : stored),
    async getMessages(id) { msgReads.push(id); return [{ role: 'user', content: id === 'm1' ? 'secret needle' : 'nothing' }]; },
    decryptMessages: (blob) => String(blob).replace(/^ENC:/, ''),
};
/** @param {...any} a */
const agentSearch = (...a) => /** @type {any} */ (searchConversationRows)(AGENT_SEARCH, deps, ...a).then((r) => r.results);
/** @param {...any} a */
const directSearch = (...a) => /** @type {any} */ (searchConversationRows)(DIRECT_SEARCH, deps, ...a).then((r) => r.results);

async function reset() {
    await pg.exec('TRUNCATE agent_conversations, direct_conversations, conversation_messages, agents CASCADE');
    msgReads.length = 0;
    cryptoCtx = { encryptMessages: false, encryptTitle: false };
    await insertRow(pg, 'agents', { id: 'ag', name: 'Helper', owner_id: 'u1', avatar: '🐝' });
    await insertRow(pg, 'agents', { id: 'other', name: 'Other', owner_id: 'u1' });
}
let msgSeq = 0;

const agentConv = (over) => insertRow(pg, 'agent_conversations', { user_id: 'u1', agent_id: 'ag', title: 'untitled', messages_migrated: false, messages_json: '[]', ...over });
const directConv = (over) => insertRow(pg, 'direct_conversations', { user_id: 'u1', title: 'untitled', messages_migrated: false, messages_json: '[]', ...over });
const message = (over) => insertRow(pg, 'conversation_messages', { id: `msg-${++msgSeq}`, role: 'user', ...over });

test('agent search, no key: strategy A (title or migrated content) then B (legacy blob), with the agentId and date filters', async () => {
    await reset();
    await agentConv({ id: 'a1', title: 'Needle in the title', messages_migrated: true, updated_at: '2026-01-10' });
    await agentConv({ id: 'a2', title: 'Plain', messages_migrated: true, updated_at: '2026-01-11' });
    await message({ conversation_id: 'a2', conversation_type: 'agent', content: 'a NEEDLE in a message', seq: 1 });
    await message({ conversation_id: 'a2', conversation_type: 'agent', content: 'needle twice', seq: 2 });
    await agentConv({ id: 'b1', title: 'Legacy', messages_json: '[{"content":"needle"}]', updated_at: '2026-02-01' });
    await agentConv({ id: 'x-agent', agent_id: 'other', title: 'needle', updated_at: '2026-01-12' });
    await agentConv({ id: 'x-date', title: 'needle', updated_at: '2025-06-01' });
    await agentConv({ id: 'x-user', user_id: 'u2', title: 'needle', updated_at: '2026-01-12' });
    await agentConv({ id: 'x-migrated-blob', title: 'Moved', messages_migrated: true, messages_json: '[{"content":"needle"}]', updated_at: '2026-01-12' });

    const out = await agentSearch('u1', 'needle', { agentId: 'ag', startDate: '2026-01-01', endDate: '2026-12-31' });
    assert.deepStrictEqual(out.map((r) => r.id), ['a2', 'a1', 'b1'], 'A newest first, one row per conversation, then B');
    assert.strictEqual(out[0].agent_name, 'Helper');
    assert.strictEqual(out[0].agent_avatar, '🐝');
    assert.ok(!('messages_json' in out[0]), 'the SQL strategies never return the blob');
});

test('agent search, encrypted: A2 decrypts migrated rows, C decrypts legacy blobs', async () => {
    await reset();
    cryptoCtx = { encryptMessages: true, encryptTitle: false };
    await agentConv({ id: 'm1', title: 't', messages_migrated: true, updated_at: '2026-01-02' });
    await agentConv({ id: 'm2', title: 't', messages_migrated: true, updated_at: '2026-01-03' });
    await agentConv({ id: 'c1', title: 'x', messages_json: 'ENC:a needle here', updated_at: '2026-01-04' });
    await agentConv({ id: 'c2', title: 'y', messages_json: 'ENC:none', updated_at: '2026-01-05' });
    await agentConv({ id: 'c-other', user_id: 'u2', messages_json: 'ENC:needle', updated_at: '2026-01-05' });
    const out = await agentSearch('u1', 'NEEDLE', {}, 'key');
    assert.deepStrictEqual(out.map((r) => r.id), ['m1', 'c1']);
    assert.strictEqual(out[1].messages_json, 'a needle here');
    assert.deepStrictEqual(msgReads, ['m2', 'm1'], 'only migrated rows of the user, newest first');
});

test('direct search, no key: the message join is the direct one, an agentId filter is ignored', async () => {
    await reset();
    await directConv({ id: 'd1', title: 'T', messages_migrated: true, model_tier: 'fast', updated_at: '2026-01-01' });
    await message({ conversation_id: 'd1', conversation_type: 'direct', content: 'the q is here', seq: 1 });
    await directConv({ id: 'd-agent-msg', title: 'T', messages_migrated: true, updated_at: '2026-01-02' });
    await message({ conversation_id: 'd-agent-msg', conversation_type: 'agent', content: 'q', seq: 1 });
    await directConv({ id: 'd2', title: 'U', messages_json: '[{"content":"q"}]', model_tier: 'smart', updated_at: '2026-03-01' });
    await directConv({ id: 'd-old', title: 'q', updated_at: '2025-01-01' });

    const out = await directSearch('u1', 'q', { agentId: 'ignored', startDate: '2026-01-01' });
    assert.deepStrictEqual(out.map((r) => r.id), ['d1', 'd2'], 'a message of another kind under the same id is not this conversation\'s');
    assert.strictEqual(out[0].model_tier, 'fast');
});

test('direct search, encrypted title only: A2 scans every row of the user, C reads legacy blobs', async () => {
    await reset();
    cryptoCtx = { encryptMessages: false, encryptTitle: true };
    await directConv({ id: 'd3', title: `ENC:${Buffer.from('has q in title').toString('base64')}`, messages_migrated: true, updated_at: '2026-01-01' });
    await directConv({ id: 'd5', title: `ENC:${Buffer.from('nothing').toString('base64')}`, messages_migrated: false, updated_at: '2026-01-03' });
    await directConv({ id: 'd4', title: 'x', messages_json: 'ENC:q', updated_at: '2026-01-02' });
    const out = await directSearch('u1', 'Q', {}, 'key');
    assert.deepStrictEqual(out.map((r) => r.id), ['d3', 'd4']);
    assert.strictEqual(out[0].title, 'has q in title', 'the opened title is returned');
    assert.strictEqual(out[1].messages_json, 'q');
    assert.deepStrictEqual(msgReads, []);
});

test('byUpdatedDesc sorts newest first', () => {
    const rows = [{ updated_at: '2026-01-01' }, { updated_at: '2026-03-01' }, { updated_at: '2026-02-01' }];
    assert.deepStrictEqual(rows.sort(byUpdatedDesc).map((r) => r.updated_at), ['2026-03-01', '2026-02-01', '2026-01-01']);
});

// The app-side strategies match with `includes`; the SQL ones must too, so
// "100%" or "a_b" is literal text there, not a wildcard, and the same search
// returns the same conversations whatever the storage shape.
test('% and _ in the query are literal text in both SQL strategies, not wildcards', async () => {
    await reset();
    await directConv({ id: 'hit-a', title: 'grew 100%_a\\b', messages_migrated: true, updated_at: '2026-01-01' });
    await directConv({ id: 'miss-a', title: 'grew 100 Xab', messages_migrated: true, updated_at: '2026-01-02' });
    await directConv({ id: 'hit-b', messages_json: 'grew 100%_a\\b', updated_at: '2026-01-03' });
    await directConv({ id: 'miss-b', messages_json: 'grew 1000xxab', updated_at: '2026-01-04' });
    const out = await directSearch('u1', '100%_a\\b', {});
    assert.deepStrictEqual(out.map((r) => r.id), ['hit-a', 'hit-b']);
});
