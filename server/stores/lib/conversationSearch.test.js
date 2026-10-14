/**
 * Conversation search for the agent and the direct table: one strategy set
 * (A: title / migrated content in SQL, A2: encrypted migrated rows decrypted in
 * the app, B: plaintext legacy blob in SQL, C: encrypted legacy blob in the
 * app). These tests pin the exact SQL, parameters and rows each store produced
 * before the shared helper existed, so the extraction stays a pure move. The
 * db and crypto functions are injected, as the stores do.
 *
 * Run: cd server && node --test stores/lib/conversationSearch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { searchConversationRows, byUpdatedDesc, AGENT_SEARCH, DIRECT_SEARCH } = require('./conversationSearch');

const calls = [];
let respond = () => [];
let cryptoCtx = { encryptMessages: false, encryptTitle: false };
const msgReads = [];

const deps = {
    async getAll(sql, params) {
        const norm = sql.replace(/\s+/g, ' ').trim();
        calls.push({ sql: norm, params });
        return respond(norm, params);
    },
    async resolveCrypto() { return cryptoCtx; },
    openTitle: (stored) => stored,
    async getMessages(id) { msgReads.push(id); return [{ role: 'user', content: id === 'm1' ? 'secret needle' : 'nothing' }]; },
    decryptMessages: (blob) => String(blob).replace(/^ENC:/, ''),
};
const agentSearch = (...a) => searchConversationRows(AGENT_SEARCH, deps, ...a).then(r => r.results);
const directSearch = (...a) => searchConversationRows(DIRECT_SEARCH, deps, ...a).then(r => r.results);

function reset() { calls.length = 0; msgReads.length = 0; respond = () => []; cryptoCtx = { encryptMessages: false, encryptTitle: false }; }

const AGENT_COLS = 'c.id, c.agent_id, c.user_id, c.title, c.updated_at, c.messages_migrated, a.name AS agent_name, a.avatar AS agent_avatar';
const DIRECT_COLS = 'c.id, c.user_id, c.title, c.updated_at, c.model_tier, c.messages_migrated';

test('agent search, no key: strategy A then B with the agentId and date filters', async () => {
    reset();
    respond = (sql) => {
        if (sql.includes('cm.content ILIKE')) return [{ id: 'a1', title: 'Needle', updated_at: '2026-01-01' }];
        if (sql.includes('messages_json ILIKE')) return [{ id: 'a1', title: 'dup', updated_at: '2026-01-01' }, { id: 'b1', title: 'B', updated_at: '2026-02-01' }];
        return [];
    };
    const out = await agentSearch('u1', 'needle', { agentId: 'ag', startDate: 's', endDate: 'e' });
    assert.deepStrictEqual(out.map(r => r.id), ['a1', 'b1']);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].sql,
        `SELECT DISTINCT ${AGENT_COLS} FROM agent_conversations c LEFT JOIN agents a ON c.agent_id = a.id LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id AND c.messages_migrated = TRUE WHERE c.user_id = $1 AND (c.title ILIKE $5 OR cm.content ILIKE $5) AND c.agent_id = $2 AND c.updated_at >= $3 AND c.updated_at <= $4 ORDER BY c.updated_at DESC LIMIT 50`);
    assert.deepStrictEqual(calls[0].params, ['u1', 'ag', 's', 'e', '%needle%']);
    assert.strictEqual(calls[1].sql,
        `SELECT ${AGENT_COLS} FROM agent_conversations c LEFT JOIN agents a ON c.agent_id = a.id WHERE c.user_id = $1 AND c.messages_migrated = FALSE AND c.messages_json ILIKE $5 AND c.agent_id = $2 AND c.updated_at >= $3 AND c.updated_at <= $4 ORDER BY c.updated_at DESC LIMIT 50`);
    assert.deepStrictEqual(calls[1].params, ['u1', 'ag', 's', 'e', '%needle%']);
});

test('agent search, encrypted: A2 decrypts migrated rows, C decrypts legacy blobs', async () => {
    reset();
    cryptoCtx = { encryptMessages: true, encryptTitle: false };
    respond = (sql) => {
        if (sql.includes('LIMIT 200') && sql.includes('messages_migrated = TRUE')) {
            return [{ id: 'm1', title: 't', updated_at: '2026-01-02', messages_migrated: true }, { id: 'm2', title: 't', updated_at: '2026-01-03', messages_migrated: true }];
        }
        if (sql.includes('LIMIT 200') && sql.includes('messages_migrated = FALSE')) {
            return [{ id: 'c1', title: 'x', updated_at: '2026-01-04', messages_json: 'ENC:a needle here' }, { id: 'c2', title: 'y', updated_at: '2026-01-05', messages_json: 'ENC:none' }];
        }
        return [];
    };
    const out = await agentSearch('u1', 'NEEDLE', {}, 'key');
    assert.deepStrictEqual(out.map(r => r.id), ['m1', 'c1']);
    assert.strictEqual(out[1].messages_json, 'a needle here');
    assert.deepStrictEqual(msgReads, ['m1', 'm2']);
    assert.strictEqual(calls.length, 3);
    assert.strictEqual(calls[1].sql,
        `SELECT ${AGENT_COLS} FROM agent_conversations c LEFT JOIN agents a ON c.agent_id = a.id WHERE c.user_id = $1 AND c.messages_migrated = TRUE ORDER BY c.updated_at DESC LIMIT 200`);
    assert.deepStrictEqual(calls[1].params, ['u1']);
    assert.strictEqual(calls[2].sql,
        'SELECT c.id, c.agent_id, c.user_id, c.title, c.updated_at, c.messages_json, c.messages_migrated, a.name AS agent_name, a.avatar AS agent_avatar FROM agent_conversations c LEFT JOIN agents a ON c.agent_id = a.id WHERE c.user_id = $1 AND c.messages_migrated = FALSE ORDER BY c.updated_at DESC LIMIT 200');
});

test('direct search, no key: conversation_type join, agentId filter ignored', async () => {
    reset();
    respond = (sql) => {
        if (sql.includes('cm.content ILIKE')) return [{ id: 'd1', user_id: 'u1', title: 'T', updated_at: '2026-01-01', model_tier: 'fast', messages_migrated: true }];
        if (sql.includes('messages_json ILIKE')) return [{ id: 'd2', user_id: 'u1', title: 'U', updated_at: '2026-03-01', model_tier: 'smart', messages_migrated: false }];
        return [];
    };
    const out = await directSearch('u1', 'q', { agentId: 'ignored', startDate: 's' });
    assert.deepStrictEqual(out.map(r => r.id), ['d1', 'd2']);
    assert.strictEqual(calls[0].sql,
        `SELECT DISTINCT ${DIRECT_COLS} FROM direct_conversations c LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id AND cm.conversation_type = 'direct' AND c.messages_migrated = TRUE WHERE c.user_id = $1 AND (c.title ILIKE $3 OR cm.content ILIKE $3) AND c.updated_at >= $2 ORDER BY c.updated_at DESC LIMIT 50`);
    assert.deepStrictEqual(calls[0].params, ['u1', 's', '%q%']);
    assert.strictEqual(calls[1].sql,
        `SELECT ${DIRECT_COLS} FROM direct_conversations c WHERE c.user_id = $1 AND c.messages_migrated = FALSE AND c.messages_json ILIKE $3 AND c.updated_at >= $2 ORDER BY c.updated_at DESC LIMIT 50`);
});

test('direct search, encrypted title only: A2 scans every row, C reads legacy blobs', async () => {
    reset();
    cryptoCtx = { encryptMessages: false, encryptTitle: true };
    respond = (sql) => {
        if (sql.includes('LIMIT 200') && !sql.includes('messages_json')) return [{ id: 'd3', user_id: 'u1', title: 'has q in title', updated_at: '2026-01-01', model_tier: 'fast', messages_migrated: true }];
        if (sql.includes('LIMIT 200')) return [{ id: 'd4', user_id: 'u1', title: 'x', updated_at: '2026-01-02', model_tier: 'fast', messages_json: 'ENC:q' }];
        return [];
    };
    const out = await directSearch('u1', 'Q', {}, 'key');
    assert.deepStrictEqual(out.map(r => r.id), ['d3', 'd4']);
    assert.strictEqual(out[1].messages_json, 'q');
    assert.deepStrictEqual(msgReads, []);
    assert.strictEqual(calls[1].sql,
        `SELECT ${DIRECT_COLS} FROM direct_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 200`);
    assert.strictEqual(calls[2].sql,
        `SELECT c.id, c.user_id, c.title, c.updated_at, c.model_tier, c.messages_json, c.messages_migrated FROM direct_conversations c WHERE c.user_id = $1 AND c.messages_migrated = FALSE ORDER BY c.updated_at DESC LIMIT 200`);
});

test('byUpdatedDesc sorts newest first', () => {
    const rows = [{ updated_at: '2026-01-01' }, { updated_at: '2026-03-01' }, { updated_at: '2026-02-01' }];
    assert.deepStrictEqual(rows.sort(byUpdatedDesc).map(r => r.updated_at), ['2026-03-01', '2026-02-01', '2026-01-01']);
});
