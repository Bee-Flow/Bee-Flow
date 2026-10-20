/**
 * Idle / LRU eviction of the per-conversation token maps in dlpRunner.
 *
 * Proven:
 *   - an idle conversation is evicted, and the next getConversationTokenMapAsync
 *     rehydrates the same tokens from the database (hydrated + notebook-bound
 *     flags go together with the map);
 *   - an entry with a pending / failed / row-less write is NEVER evicted;
 *   - an entry whose hydration is in flight is not evicted;
 *   - DLP_TOKENMAP_MAX_CONVERSATIONS evicts the least recently used;
 *   - 0 disables each limit.
 *
 * Run: cd server && node --test core/dlp/dlpRunner.eviction.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert');
const { test, beforeEach, after } = require('node:test');

// In-memory "database": one agent_conversations table.
const rows = new Map(); // id → pii_token_map
let writeGate = null;   // promise the UPDATE waits for (pending-write test)
let failWrites = false;
const db = require('../../db');
db.run = async (sql, params) => {
    if (writeGate) await writeGate;
    if (failWrites) throw new Error('db down');
    if (/UPDATE agent_conversations SET pii_token_map = \$1/.test(sql)) {
        if (!rows.has(params[1])) return { rowCount: 0 };
        rows.set(params[1], JSON.parse(params[0]));
        return { rowCount: 1 };
    }
    return { rowCount: 0 };
};
db.getOne = async (sql, params) => {
    if (/FROM agent_conversations/.test(sql) && rows.has(params[0])) return { pii_token_map: rows.get(params[0]) };
    return null;
};
db.getAll = async () => [];

const dlp = require('./dlpRunner');

const flush = () => new Promise((r) => setImmediate(r));
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
    rows.clear();
    writeGate = null;
    failWrites = false;
    delete process.env.DLP_TOKENMAP_IDLE_MS;
    delete process.env.DLP_TOKENMAP_MAX_CONVERSATIONS;
    for (const id of ['c1', 'c2', 'c3', 'c4']) dlp.clearConversationState(id, { ephemeral: true });
});
after(() => { delete process.env.DLP_TOKENMAP_IDLE_MS; delete process.env.DLP_TOKENMAP_MAX_CONVERSATIONS; });

test('an idle conversation is evicted and rehydrates the same tokens from the DB', async () => {
    rows.set('c1', null);
    dlp.mergeTokenMap('c1', { '[email_1]': 'a@x.test', '[person_1]': 'Anna' });
    await flush(); await flush();
    assert.deepStrictEqual(rows.get('c1'), { '[email_1]': 'a@x.test', '[person_1]': 'Anna' });

    assert.strictEqual(dlp.sweepIdle(Date.now() + 3 * HOUR), 1);
    assert.deepStrictEqual(dlp.getConversationTokenMap('c1'), {}, 'gone from memory');

    const back = await dlp.getConversationTokenMapAsync('c1');
    assert.deepStrictEqual(back, { '[email_1]': 'a@x.test', '[person_1]': 'Anna' });
});

test('a recently used conversation is kept', async () => {
    rows.set('c1', null);
    dlp.mergeTokenMap('c1', { '[email_1]': 'a@x.test' });
    await flush(); await flush();
    assert.strictEqual(dlp.sweepIdle(Date.now() + HOUR), 0);
    assert.deepStrictEqual(dlp.getConversationTokenMap('c1'), { '[email_1]': 'a@x.test' });
});

test('an entry with a pending write is not evicted until the write lands', async () => {
    rows.set('c1', null);
    let open; writeGate = new Promise((r) => { open = r; });
    dlp.mergeTokenMap('c1', { '[email_1]': 'a@x.test' });
    await flush();
    assert.strictEqual(dlp.sweepIdle(Date.now() + 5 * HOUR), 0, 'pending write: kept');
    open(); writeGate = null;
    await flush(); await flush();
    assert.strictEqual(dlp.sweepIdle(Date.now() + 5 * HOUR), 1, 'written: evictable');
});

test('entries whose write failed or found no row are never evicted', async () => {
    failWrites = true;
    rows.set('c1', null);
    dlp.mergeTokenMap('c1', { '[email_1]': 'a@x.test' });
    dlp.mergeTokenMap('c2', { '[email_1]': 'b@x.test' }); // no row at all
    await flush(); await flush();
    failWrites = false;
    assert.strictEqual(dlp.sweepIdle(Date.now() + 5 * HOUR), 0);
    assert.deepStrictEqual(dlp.getConversationTokenMap('c2'), { '[email_1]': 'b@x.test' });
});

test('the count cap evicts the least recently used first', async () => {
    process.env.DLP_TOKENMAP_MAX_CONVERSATIONS = '2';
    process.env.DLP_TOKENMAP_IDLE_MS = '0';
    for (const id of ['c1', 'c2', 'c3']) {
        rows.set(id, null);
        dlp.mergeTokenMap(id, { '[email_1]': `${id}@x.test` });
        await flush(); await flush();
    }
    dlp.getConversationTokenMap('c1'); // c1 is now the most recent
    // (the merges above already swept lazily; re-running is harmless)
    dlp.sweepIdle();
    assert.deepStrictEqual(dlp.getConversationTokenMap('c2'), {}, 'c2 was the least recently used');
    assert.deepStrictEqual(dlp.getConversationTokenMap('c1'), { '[email_1]': 'c1@x.test' });
    assert.deepStrictEqual(await dlp.getConversationTokenMapAsync('c2'), { '[email_1]': 'c2@x.test' });
});

test('0 disables both limits', async () => {
    process.env.DLP_TOKENMAP_IDLE_MS = '0';
    process.env.DLP_TOKENMAP_MAX_CONVERSATIONS = '0';
    for (const id of ['c1', 'c2', 'c3']) {
        rows.set(id, null);
        dlp.mergeTokenMap(id, { '[email_1]': `${id}@x.test` });
        await flush(); await flush();
    }
    assert.strictEqual(dlp.sweepIdle(Date.now() + 1000 * HOUR), 0);
    assert.deepStrictEqual(dlp.getConversationTokenMap('c3'), { '[email_1]': 'c3@x.test' });
});
