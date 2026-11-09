// @typecheck
/**
 * memoryReads.searchUserMemories: the SQL search of a person's memories.
 *
 * Sealed memories are searched in the app with `includes`; plaintext ones in
 * SQL, where the text went into ILIKE as typed. `100%` or `a_b` then matched
 * as wildcards, so the same search listed different memories depending on
 * whether the organisation seals them.
 *
 * Run: cd server && node --test stores/memoryReads.search.test.js
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { recordDb } = require('../testUtils/routeHarness');

const db = recordDb();
const reads = require('./memoryStore'); // the facade installs the store's parts

beforeEach(db.reset);

test('% and _ in the search are escaped in the SQL path', async () => {
    await reads.searchUserMemories('u1', { search: ' 100%_x ' });
    const list = db.calls.find((q) => /ILIKE/.test(q.sql) && /LIMIT/.test(q.sql));
    assert.ok(list, 'the SQL search ran');
    assert.ok(list.params.includes('%100\\%\\_x%'), JSON.stringify(list.params));
    const count = db.calls.find((q) => /COUNT\(\*\)/.test(q.sql) && /ILIKE/.test(q.sql));
    assert.ok(count.params.includes('%100\\%\\_x%'), 'the total counts the same rows');
});
