'use strict';

/**
 * ISO27001-A.8.12-dlp — guardrail events and AI traffic are counted over the
 * same population (the efficacy check's): a tenant's traffic is its own, not
 * the install's, and the 'default' bucket sees its NULL-org events. A count
 * that FAILED warns, naming only the SQLSTATE.
 *
 * Against a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind db.js's pool. The shield
 * config comes from configStore, replaced on the singleton.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a8-12-dlp.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads, hideTable } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

const { pg, close } = usePglitePool(ladderPglite());
const configStore = require('../../../stores/configStore');
configStore.getConfig = async (key) => (key.startsWith('org_privacy_shield_') ? { enabled: true, collectionIds: ['c'] } : null);

const check = require('./a8-12-dlp');
after(close);

beforeEach(async () => {
    await pg.exec(`DELETE FROM ai_usage_log; DELETE FROM guardrail_events; DELETE FROM users WHERE id LIKE 'dlp_%'`);
    await insertRow(pg, 'users', { id: 'dlp_a', username: 'dlp_a', organizationId: 'org-a' });
    await insertRow(pg, 'users', { id: 'dlp_none', username: 'dlp_none', organizationId: null });
});

/** `n` AI calls by `userId`, stamped with `org`. */
async function calls(n, userId, org) {
    for (let i = 0; i < n; i++) await insertRow(pg, 'ai_usage_log', { user_id: userId, organization_id: org });
}
/** @param {string} userId @param {string | null} org @param {string} action */
const event = (userId, org, action) => insertRow(pg, 'guardrail_events', { user_id: userId, organization_id: org, violation_type: 'pii', action_taken: action });

test('the default bucket counts its NULL-org guardrail events and passes a working shield', async () => {
    await calls(30, 'dlp_none', null);
    await event('dlp_none', null, 'blocked');
    await event('dlp_none', '', 'redacted');
    await event(null, null, 'redacted');
    await event('dlp_a', null, 'blocked');   // org-less row of an org-a member: org-a's, not the bucket's
    const r = await check.evaluate('default');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.total_events, 3);
    assert.equal(r.evidence.blocked_events, 1);
    assert.equal(r.evidence.ai_requests, 30);
});

test("a tenant's traffic is its own, scoped like its events", async () => {
    await calls(30, 'dlp_none', null);        // the install's traffic, not org-a's
    await calls(5, 'dlp_a', 'org-a');
    await calls(5, 'dlp_a', null);            // stamped without an org, attributed through the member
    await calls(30, 'dlp_b', 'org-b');
    await event('dlp_none', null, 'blocked');
    await event('dlp_a', null, 'redacted');
    const r = await check.evaluate('org-a');
    assert.equal(r.evidence.ai_requests, 10);
    assert.equal(r.evidence.total_events, 1, 'a tenant never gets the bucket\'s events');
    assert.equal(r.status, 'warn', 'too little traffic to prove the shield works');
});

test('a count that fails warns with the SQLSTATE; a missing table is not a failure', async () => {
    await calls(30, 'dlp_a', 'org-a');
    const undo = await failReads(pg, 'guardrail_events', '57014', 'canceling statement due to statement timeout');
    let broken;
    try { broken = await check.evaluate('org-a'); } finally { await undo(); }
    assert.equal(broken.status, 'warn');
    assert.match(broken.details, /guardrail_events \(SQL state 57014\)/);
    assert.ok(!JSON.stringify(broken).includes('canceling'), 'no driver message');

    const show = await hideTable(pg, 'guardrail_events');
    let young;
    try { young = await check.evaluate('org-a'); } finally { await show(); }
    assert.equal(young.status, 'warn');
    assert.equal(young.evidence.guardrail_table_missing, true);
    assert.match(young.details, /not available/);
});
