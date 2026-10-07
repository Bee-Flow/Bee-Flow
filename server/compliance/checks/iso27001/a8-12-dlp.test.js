'use strict';

/**
 * ISO27001-A.8.12-dlp — guardrail events and AI traffic are counted over the
 * same population (the efficacy check's): a tenant's traffic is its own, not
 * the install's, and the 'default' bucket sees its NULL-org events. A count
 * that FAILED warns, naming only the SQLSTATE.
 *
 * db.getOne is replaced before the check is required (testUtils/recordGetOne).
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-12-dlp.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../../db');
const { recordGetOne } = require('../../../testUtils/recordGetOne');
const rec = recordGetOne(db);
const { calls } = rec;

const configStore = require('../../../stores/configStore');
configStore.getConfig = async (key) => (key.startsWith('org_privacy_shield_') ? { enabled: true, collectionIds: ['c'] } : null);

const check = require('./a8-12-dlp');

beforeEach(() => { calls.length = 0; });

test('the default bucket counts its NULL-org guardrail events and passes a working shield', async () => {
    rec.answer = async (sql) => {
        if (/ai_usage_log/.test(sql)) return { c: 100 };
        // Events only exist for the bucket's "resolves to no organisation" rows.
        return /IS NULL\)\)/.test(sql)
            ? { total_events: 3, blocked_events: 1, redacted_events: 2 }
            : { total_events: 0, blocked_events: 0, redacted_events: 0 };
    };
    const r = await check.evaluate('default');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.total_events, 3);
});

test("a tenant's traffic is its own, scoped like its events", async () => {
    rec.answer = async (sql) => (/ai_usage_log/.test(sql) ? { c: 0 } : { total_events: 0, blocked_events: 0, redacted_events: 0 });
    await check.evaluate('org-a');
    const traffic = calls.find(c => /ai_usage_log/.test(c.sql));
    assert.match(traffic.sql, /t\.organization_id = \$1/);
    assert.match(traffic.sql, /LEFT JOIN users u ON u\.id = t\.user_id/);
    assert.deepEqual(traffic.params, ['org-a']);
    const events = calls.find(c => /guardrail_events/.test(c.sql));
    assert.deepEqual(events.params, ['org-a']);
    assert.doesNotMatch(events.sql, /IS NULL\)\)/, 'a tenant never gets the bucket clause');
});

test('a count that fails warns with the SQLSTATE; a missing table is not a failure', async () => {
    rec.answer = async (sql) => {
        if (/ai_usage_log/.test(sql)) return { c: 100 };
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    };
    const broken = await check.evaluate('org-a');
    assert.equal(broken.status, 'warn');
    assert.match(broken.details, /guardrail_events \(SQL state 57014\)/);
    assert.ok(!JSON.stringify(broken).includes('canceling'), 'no driver message');

    rec.answer = async (sql) => {
        if (/ai_usage_log/.test(sql)) return { c: 100 };
        throw Object.assign(new Error('x'), { code: '42P01' });
    };
    const young = await check.evaluate('org-a');
    assert.equal(young.status, 'warn');
    assert.equal(young.evidence.guardrail_table_missing, true);
    assert.match(young.details, /not available/);
});
