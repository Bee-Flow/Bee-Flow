// @typecheck
/**
 * usage/queries.getRecentCalls: the free-text search of the call log.
 *
 * The search text went into ILIKE as typed, so `gpt_4` or `50%` matched as
 * wildcards and listed calls that do not contain the text.
 *
 * Run: cd server && node --test stores/usage/queries.search.test.js
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const { recordDb } = require('../../testUtils/routeHarness');

const db = recordDb();
const queries = require('./queries');

beforeEach(db.reset);

const lastSelect = () => db.calls.filter((q) => /FROM ai_usage_log/i.test(q.sql)).pop();

test('% and _ in the search are escaped: literal text, not wildcards', async () => {
    await queries.getRecentCalls(10, { search: 'gpt_4 50%' });
    const q = lastSelect();
    assert.match(q.sql, /agent_name ILIKE \$\d+ OR user_id ILIKE \$\d+ OR model ILIKE \$\d+/);
    assert.equal(q.params.filter((p) => p === '%gpt\\_4 50\\%%').length, 3);
});

test('a plain search is still a substring match', async () => {
    await queries.getRecentCalls(10, { search: 'claude' });
    assert.equal(lastSelect().params.filter((p) => p === '%claude%').length, 3);
});
