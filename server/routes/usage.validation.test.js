/**
 * What the usage dashboards may ask (routes/usage.js).
 *
 *   - `?days=abc` became 30 days under a 200, and a date that is not a date
 *     reached SQL.
 *   - a misspelled filter (`?modle=gpt`) answered the unfiltered totals as
 *     if they were the filtered ones.
 *   - `?eu=yes` dropped the EU filter; `?interval=hours` drew a daily chart.
 *   - GET /recent had no ceiling on `limit`.
 *
 * No refused request reaches the database; the session is checked first.
 *
 * Run: cd server && node --test routes/usage.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../core/http/routeHarness');

// Every statement with its parameters, so the /recent ceiling can be read off the query.
const seen = [];
const { db, api } = h.routeUnderTest(test, '/api/usage', () => require('./usage'), {
    answer: (sql, params) => { seen.push({ sql, params }); },
});

test('a filter the dashboard does not have is refused by name', async () => {
    const res = await api.call('GET', '/api/usage/summary?days=7&modle=gpt');
    h.assertRefused(assert, res, 'query', /"modle"/);
    assert.deepStrictEqual(db.queries, []);
});

test('numbers, dates and the fixed vocabularies are checked', async () => {
    const cases = [
        ['/api/usage/summary?days=abc', 'query.days', /whole number of days/],
        ['/api/usage/summary?startDate=yesterday&endDate=2026-09-01', 'query.startDate', /are dates/],
        ['/api/usage/summary?startDate=2026-09-01T00:00:00Z', 'query.startDate', /together, or neither/],
        ['/api/usage/timeline?interval=hours', 'query.interval', /hour or day/],
        ['/api/usage/integrations/egress?eu=yes', 'query.eu', /true or false/],
        ['/api/usage/integrations/sovereignty?dimension=org', 'query.dimension', /Invalid dimension/],
        ['/api/usage/recent?limit=-1', 'query.limit', /whole number/],
    ];
    for (const [url, path, message] of cases) h.assertRefused(assert, await api.call('GET', url), path, message);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the query', async () => {
    const res = await api.call('GET', '/api/usage/summary?days=abc', { user: null });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('/recent asks the store for at most 1000 rows', async () => {
    seen.length = 0;
    const res = await api.call('GET', '/api/usage/recent?limit=999999');
    assert.strictEqual(res.status, 200, res.text);
    const recent = seen.find((q) => /FROM ai_usage_log/.test(q.sql) && /LIMIT/.test(q.sql));
    assert.ok(recent, db.queries.join(' | '));
    assert.strictEqual(recent.params.at(-1), 1000);
});

test('a valid request reaches the store and answers as before', async () => {
    const res = await api.call('GET', '/api/usage/by-model?days=30');
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(Array.isArray(res.body));
    assert.ok(db.queries.length > 0);
});
