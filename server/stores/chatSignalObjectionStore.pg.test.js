'use strict';

/**
 * "Don't count my chat turns" against a real Postgres (pglite): set, read and
 * withdraw; the memo follows a change at once; a read error reads as
 * objecting; and the store offers no way to list or count objections.
 *
 * Run: cd server && node --test stores/chatSignalObjectionStore.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../testUtils/pgliteDb');
const objections = require('./chatSignalObjectionStore');

const { pg, db } = pgliteDb();
let queries = 0;
const counting = { query: (sql, params) => { queries++; return db.query(sql, params); } };
const store = objections.makeChatSignalObjectionStore(counting);

before(async () => { await pg.exec(objections.DDL); await pg.exec(objections.DDL); });
after(() => pg.close());

test('set, read and withdraw an objection', async () => {
    assert.equal(await store.isObjecting('u1'), false);
    await store.setObjecting('u1', true);
    await store.setObjecting('u1', true);   // idempotent
    assert.equal(await store.isObjecting('u1'), true);
    const { rows } = await pg.query(`SELECT * FROM chat_signal_objections`);
    assert.deepEqual(rows, [{ user_id: 'u1' }], 'the user id and nothing else: no timestamp, no history');
    await store.setObjecting('u1', false);
    assert.equal(await store.isObjecting('u1'), false);
});

test('reads are memoised, and a change invalidates the memo at once', async () => {
    queries = 0;
    assert.equal(await store.isObjecting('u2'), false);
    assert.equal(await store.isObjecting('u2'), false);
    assert.equal(queries, 1, 'the second read comes from the memo');
    await store.setObjecting('u2', true);
    assert.equal(await store.isObjecting('u2'), true, 'the memo does not outlive the change');
});

test('a read error reads as objecting and is not memoised', async () => {
    let fail = true;
    const flaky = objections.makeChatSignalObjectionStore({
        query: async (sql, params) => { if (fail) throw Object.assign(new Error('connection lost'), { code: '08006' }); return db.query(sql, params); },
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(await flaky.isObjecting('u3'), true);
    } finally {
        console.warn = warn;
    }
    fail = false;
    assert.equal(await flaky.isObjecting('u3'), false, 'the next read asks again');
    assert.equal(await store.isObjecting(''), true, 'no id: do not count');
});

test('the module exports no list or count function', () => {
    const names = [...Object.keys(objections), ...Object.keys(store)];
    for (const n of names) assert.doesNotMatch(n, /list|count|all|export|find|query/i, n);
    assert.deepEqual(Object.keys(store).sort(), ['isObjecting', 'setObjecting']);
});
