'use strict';

/**
 * The KB query log in the processing register: present only while at least one base of the
 * organisation logs, with the terms of those bases and the recipients, and no ids or counts of people.
 *
 * Run: cd server && node --test compliance/ropa/kbQueryLogActivity.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { kbQueryLogActivity } = require('./kbQueryLogActivity');

const deps = (kbs) => ({ listLoggingKbs: async () => kbs });

test('no base logs: no activity', async () => {
    assert.deepEqual(await kbQueryLogActivity('org1', deps([])), []);
    assert.deepEqual(await kbQueryLogActivity('', deps([{ id: 'k', name: 'K', query_log_retention_days: 30 }])), []);
});

test('one logging base: one activity with the term, purpose, recipients and measures', async () => {
    const [a] = await kbQueryLogActivity('org1', deps([{ id: 'k1', name: 'Handbook', query_log_retention_days: 90 }]));
    assert.equal(a.activity_id, 'kb-query-log');
    assert.match(a.retention, /^90 days\./);
    assert.match(a.purpose, /Quality control/);
    assert.match(a.recipients, /managers of each knowledge base/);
    assert.ok(a.security_measures.some((m) => /access log/.test(m)));
    assert.equal(a.source.kind, 'kb_query_log');
    assert.ok(!JSON.stringify(a).includes('Handbook'), 'base names are not in the register');
});

test('several bases with different terms give the range', async () => {
    const [a] = await kbQueryLogActivity('org1', deps([
        { id: 'k1', name: 'A', query_log_retention_days: 30 }, { id: 'k2', name: 'B', query_log_retention_days: 365 },
    ]));
    assert.match(a.retention, /^30 to 365 days, set per knowledge base\./);
    assert.match(a.processing, /one of the 2 logging knowledge bases/);
});
