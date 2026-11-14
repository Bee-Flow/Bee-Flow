'use strict';

/**
 * ISO27001-A.8.15-logging — on the 'default' bucket the org-scoped ledgers
 * include the rows written without an organisation (loginAudit writes NULL
 * for org-less accounts and unknown identifiers), so a single-tenant install
 * does not warn forever; a tenant keeps the bare org filter; the guardrail
 * ledger stays install-wide; and the empty-install text counts three ledgers.
 *
 * Against a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind db.js's pool.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-15-logging.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');

const { pg, close } = usePglitePool(ladderPglite());
const check = require('./a8-15-logging');

after(close);
beforeEach(() => pg.exec('DELETE FROM access_audit_log; DELETE FROM integration_activity_log; DELETE FROM guardrail_events'));

let seq = 0;
/** @param {string | null} org @param {string} [action] */
const signIn = (org, action = 'login_succeeded') => pg.query(
    "INSERT INTO access_audit_log (id, action, target_type, target_id, organization_id, created_at) VALUES ($1, $2, 'user', 'u1', $3, NOW() - INTERVAL '10 days')",
    [`a${++seq}`, action, org]);
/** @param {string | null} org */
const integrationEvent = (org) => pg.query(
    "INSERT INTO integration_activity_log (organization_id, tool_name, timestamp) VALUES ($1, 'nextcloud_list_files', NOW() - INTERVAL '10 days')", [org]);
/** @param {string | null} org */
const guardrailEvent = (org) => pg.query(
    "INSERT INTO guardrail_events (organization_id, violation_type, timestamp) VALUES ($1, 'pii', NOW() - INTERVAL '10 days')", [org]);

// Sign-ins exist only as rows without an organisation; the other ledgers are live for org-a and the default bucket.
async function liveExceptOrglessAuth() {
    for (const org of ['default', 'org-a']) await integrationEvent(org);
    await guardrailEvent('org-b');
    for (let i = 0; i < 5; i++) await signIn(i % 2 ? null : '');
}

test("the default bucket counts the org-less sign-ins and passes", async () => {
    await liveExceptOrglessAuth();
    const r = await check.evaluate('default');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.authentication_recent_events, 5);
    assert.equal(r.evidence.access_audit_log_span_days, 10);
});

test('a tenant keeps the bare org filter; the guardrail ledger stays install-wide', async () => {
    await liveExceptOrglessAuth();
    await signIn('org-b');
    const r = await check.evaluate('org-a');
    assert.equal(r.status, 'warn', 'org-less sign-ins and another tenant\'s are not org-a\'s');
    assert.equal(r.evidence.authentication_recent_events, 0);
    assert.equal(r.evidence.integration_recent_events, 1, 'only org-a\'s integration row');
    assert.equal(r.evidence.guardrail_recent_events, 1, 'another tenant\'s guardrail event counts: install-wide');
    assert.match(r.details, /authentication log/);

    await signIn('org-a');
    assert.equal((await check.evaluate('org-a')).status, 'pass');
});

test('only sign-in actions count as authentication events', async () => {
    await liveExceptOrglessAuth();
    await signIn('org-a', 'role_changed');
    assert.equal((await check.evaluate('org-a')).evidence.authentication_recent_events, 0);
    await signIn('org-a', 'login_failed');
    assert.equal((await check.evaluate('org-a')).evidence.authentication_recent_events, 1);
});

test('an install with no events at all says none of the three ledgers recorded any', async () => {
    const r = await check.evaluate('org-a');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.integration_log_span_days, null);
    assert.match(r.details, /None of the three security ledgers/);
});
