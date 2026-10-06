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
const { installResolveStub } = require('../../../testUtils/stubRequire');

const fx = { settings: {} };
const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async () => ({ ...fx.settings }) },
});
const check = require('./art37-dpo-appointed');
test.after(restore);

test('name and e-mail set: pass, and neither value reaches details or evidence', async () => {
    fx.settings = { dpo_name: 'Marieke de Wit', dpo_email: 'privacy@vandael.example' };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    const out = JSON.stringify(r);
    assert.doesNotMatch(out, /Marieke|de Wit|privacy@vandael/);
    assert.deepEqual(r.evidence, { dpo_name: true, dpo_email: true });
});

test('one of the two: warn; none: fail', async () => {
    fx.settings = { dpo_name: 'Marieke de Wit' };
    assert.equal((await check.evaluate('org1')).status, 'warn');
    fx.settings = {};
    assert.equal((await check.evaluate('org1')).status, 'fail');
});
