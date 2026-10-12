/**
 * GDPR-Art33-breach-detection: the live 72-hour half of the check.
 *
 *   - A registry that cannot be read is not "no incidents". Every failure of
 *     getDeadlineStats used to become zero incidents, and with a recipient set
 *     the check passed with "The 72-hour window can be met" while the
 *     registry was unreadable. Only a table that is not there yet keeps the
 *     readiness-only answer.
 *   - The deadline is the GDPR one: incidents under the GDPR regime, from
 *     detected_at + 72 h. The roll-up `overdue_unnotified` counts the earliest
 *     clock of any regime (a NIS2 24 h early warning, a CRA vulnerability),
 *     which is not an Art. 33 breach.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art33-breach-detection.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const fx = { stats: async () => ({ open: 0, overdue_unnotified: 0, nearing_deadline: 0 }) };
const restore = installResolveStub({
    '../../../stores/complianceStore': { getSettings: async () => ({ breach_recipients: ['dpo@x.example'] }) },
    '../../../stores/incidentStore': { getDeadlineStats: (...a) => fx.stats(...a) },
});
const check = require('./art33-breach-detection');
test.after(restore);

const throwing = (code) => async () => { throw Object.assign(new Error('terminating connection due to administrator command'), { code }); };

test('an unreadable incident registry warns with the SQLSTATE, never a pass', async () => {
    fx.stats = throwing('57P01');
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.sqlstate, '57P01');
    assert.equal(r.evidence.registry_readable, false);
    assert.equal('overdue_unnotified' in r.evidence, false, 'unknown is not zero');
    assert.ok(!JSON.stringify(r).includes('terminating connection'), 'the raw error message stays out of the result');
    assert.match(r.details, /could not be read/);
});

test('a registry that is not provisioned yet keeps the readiness-only answer', async () => {
    for (const code of ['42P01', '42703']) {
        fx.stats = throwing(code);
        assert.equal((await check.evaluate('orgA')).status, 'pass', code);
    }
});

test('an early-warning or non-GDPR clock past due is not a missed Art. 33 deadline', async () => {
    fx.stats = async () => ({ open: 1, overdue_unnotified: 1, nearing_deadline: 0, gdpr_overdue_unnotified: 0, gdpr_nearing_deadline: 0 });
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.overdue_unnotified, 0);
});

test('a GDPR incident past detected_at + 72 h fails; one within 24 h of it warns', async () => {
    fx.stats = async () => ({ open: 1, overdue_unnotified: 1, nearing_deadline: 0, gdpr_overdue_unnotified: 1, gdpr_nearing_deadline: 0 });
    const over = await check.evaluate('orgA');
    assert.equal(over.status, 'fail');
    assert.match(over.details, /^1 open incident\(s\) are past the 72-hour Art\. 33 deadline/);

    fx.stats = async () => ({ open: 1, overdue_unnotified: 1, nearing_deadline: 0, gdpr_overdue_unnotified: 0, gdpr_nearing_deadline: 1 });
    assert.equal((await check.evaluate('orgA')).status, 'warn');
});

test('a store that does not report the GDPR counts falls back to the roll-up', async () => {
    fx.stats = async () => ({ open: 1, overdue_unnotified: 1, nearing_deadline: 0 });
    assert.equal((await check.evaluate('orgA')).status, 'fail');
});
