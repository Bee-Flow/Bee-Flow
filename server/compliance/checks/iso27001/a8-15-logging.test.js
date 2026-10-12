'use strict';

/**
 * ISO27001-A.8.15-logging — on the 'default' bucket the org-scoped ledgers
 * include the rows written without an organisation (loginAudit writes NULL
 * for org-less accounts and unknown identifiers), so a single-tenant install
 * does not warn forever; a tenant keeps the bare org filter; the guardrail
 * ledger stays install-wide; and the empty-install text counts three ledgers.
 *
 * db.getOne is replaced before the check is required (testUtils/recordGetOne).
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-15-logging.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../../db');
const { recordGetOne } = require('../../../testUtils/recordGetOne');
const rec = recordGetOne(db);
const { calls } = rec;

const check = require('./a8-15-logging');

beforeEach(() => { calls.length = 0; });

// Sign-ins exist only as rows without an organisation.
function liveExceptOrglessAuth(sql) {
    if (/MIN\(/.test(sql)) return { age: 10 };
    if (/FROM access_audit_log/.test(sql)) return { c: /organization_id IS NULL/.test(sql) ? 5 : 0 };
    return { c: 5 };
}

test("the default bucket counts the org-less sign-ins and passes", async () => {
    rec.answer = async (sql) => liveExceptOrglessAuth(sql);
    const r = await check.evaluate('default');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.authentication_recent_events, 5);
});

test('a tenant keeps the bare org filter; the guardrail ledger stays install-wide', async () => {
    rec.answer = async (sql) => liveExceptOrglessAuth(sql);
    const r = await check.evaluate('org-a');
    assert.equal(r.status, 'warn', 'org-less sign-ins are not a tenant\'s');
    const auth = calls.find(c => /COUNT\(\*\)::int AS c FROM access_audit_log/.test(c.sql));
    assert.match(auth.sql, /AND organization_id = \$1/);
    assert.deepEqual(auth.params, ['org-a']);
    for (const c of calls.filter(x => /guardrail_events/.test(x.sql))) {
        assert.doesNotMatch(c.sql, /\$1/);
        assert.equal(c.params, undefined);
    }
});

test('an install with no events at all says none of the three ledgers recorded any', async () => {
    rec.answer = async (sql) => (/MIN\(/.test(sql) ? { age: null } : { c: 0 });
    const r = await check.evaluate('org-a');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /None of the three security ledgers/);
});
