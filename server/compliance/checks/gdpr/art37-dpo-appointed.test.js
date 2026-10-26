// @typecheck
/**
 * GDPR-Art37-dpo-appointed — records THAT a DPO is on file, never who.
 *
 * The details and evidence of every run are written into the append-only,
 * hash-chained evidence log; a DPO's name and e-mail address in there could
 * never be removed once the person leaves the role.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art37-dpo-appointed.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRecordingDb } = require('../../../testUtils/mockDb');

// The real complianceStore over a recording pool: compliance_settings is `rows`.
const rows = [];
createRecordingDb({ tables: { compliance_settings: rows } }).attachPool();
const check = require('./art37-dpo-appointed');
/** @param {Record<string, unknown>} settings */
const setSettings = (settings) => { rows.length = 0; rows.push({ organization_id: 'org1', ...settings }); };

test('name and e-mail set: pass, and neither value reaches details or evidence', async () => {
    setSettings({ dpo_name: 'Marieke de Wit', dpo_email: 'privacy@vandael.example' });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    const out = JSON.stringify(r);
    assert.doesNotMatch(out, /Marieke|de Wit|privacy@vandael/);
    assert.deepEqual(r.evidence, { dpo_name: true, dpo_email: true });
});

test('one of the two: warn; none: fail', async () => {
    setSettings({ dpo_name: 'Marieke de Wit' });
    assert.equal((await check.evaluate('org1')).status, 'warn');
    setSettings({});
    assert.equal((await check.evaluate('org1')).status, 'fail');
});
