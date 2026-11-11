/**
 * What the Adoption report may be asked (routes/usageAdoption.js).
 *
 *   - the query is closed: a key the report does not read is refused by name,
 *     so `?user=` or `?org=` cannot widen or redirect the organisation report;
 *   - numbers, dates and the kind are checked, the dates sent together;
 *   - the session is checked before the query, and no refused request reaches
 *     the database.
 *
 * Run: cd server && node --test routes/usageAdoption.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');

const { db, api } = h.routeUnderTest(test, '/api/usage/adoption', () => require('./usageAdoption'));

test('a key the report does not read is refused by name', async () => {
    for (const [url, key] of [
        ['/api/usage/adoption/people?user=someone', '"user"'],
        ['/api/usage/adoption/summary?org=org2', '"org"'],
        ['/api/usage/adoption/groups?organizationId=org2', '"organizationId"'],
    ]) {
        h.assertRefused(assert, await api.call('GET', url), 'query', new RegExp(key));
    }
    assert.deepStrictEqual(db.queries, []);
});

test('numbers, dates, the kind and the reveal flag are checked', async () => {
    const cases = [
        ['/api/usage/adoption/summary?days=abc', 'query.days', /whole number of days/],
        ['/api/usage/adoption/summary?days=0', 'query.days', /whole number of days/],
        ['/api/usage/adoption/areas?startDate=yesterday&endDate=2026-09-01', 'query.startDate', /are dates/],
        ['/api/usage/adoption/areas?startDate=2026-09-01T00:00:00Z', 'query.startDate', /together, or neither/],
        ['/api/usage/adoption/studio/items?kind=nope', 'query.kind', /kind is one of agent, automation/],
        ['/api/usage/adoption/people?reveal=yes', 'query.reveal', /true or false/],
        ['/api/usage/adoption/people?limit=0', 'query.limit', /whole number/],
        ['/api/usage/adoption/summary?orgId=' + 'x'.repeat(201), 'query.orgId', /at most 200 characters/],
        ['/api/usage/adoption/people?cursor=-1', 'query.cursor', /position/],
    ];
    for (const [url, path, message] of cases) h.assertRefused(assert, await api.call('GET', url), path, message);
    assert.deepStrictEqual(db.queries, []);
});

test('the session is checked before the query', async () => {
    const res = await api.call('GET', '/api/usage/adoption/summary?days=abc', { user: null });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(db.queries, []);
});

test('a well-formed query passes the schema', async () => {
    const res = await api.call('GET', '/api/usage/adoption/studio/items?kind=agent&days=30&limit=500&group=g1');
    assert.notStrictEqual(res.status, 400, res.text);
});
