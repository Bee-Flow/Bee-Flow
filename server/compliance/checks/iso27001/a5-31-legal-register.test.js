/**
 * ISO27001-A.5.31-legal-register — the legal register the hub scores against
 * must have been re-checked recently, per framework the organisation uses.
 *
 * Run: cd server && node --test compliance/checks/iso27001/a5-31-legal-register.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const fx = { active: new Set(['GDPR', 'AIA', 'ISO27001']), throws: false };
const restore = installResolveStub({
    '../../frameworkPolicy': {
        activeRegulations: async () => { if (fx.throws) throw new Error('db down'); return fx.active; },
    },
});
const check = require('./a5-31-legal-register');
const frameworks = require('../../frameworks');
test.after(restore);

const at = (iso) => ({ now: Date.parse(`${iso}T12:00:00Z`) });
const plus = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
const newest = () => frameworks.listBuiltin().map(f => f.legal_status_verified).sort()[0];

test.beforeEach(() => { fx.active = new Set(['GDPR', 'AIA', 'ISO27001']); fx.throws = false; });

test('contract shape', () => {
    assert.equal(check.id, 'ISO27001-A.5.31-legal-register');
    assert.equal(check.regulation, 'ISO27001');
    assert.deepEqual(check.controls, ['A.5.31']);
    assert.equal(check.verification, 'automated');
});

test('checked within the window → pass, judged over the ACTIVE frameworks only', async () => {
    const r = await check.evaluate('org1', null, at(plus(newest(), 1)));
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.scope, 'active');
    assert.deepEqual(r.evidence.frameworks.map(f => f.id).sort(), ['aia', 'gdpr', 'iso27001']);
});

test('older than the window → warn, naming the stale frameworks', async () => {
    const r = await check.evaluate('org1', null, at(plus(newest(), frameworks.LEGAL_REVIEW_STALE_DAYS + 30)));
    assert.equal(r.status, 'warn');
    assert.ok(r.evidence.stale_ids.length > 0);
    assert.match(r.details, /more than 90 days ago/);
});

test('older than a year → fail', async () => {
    const r = await check.evaluate('org1', null, at(plus(newest(), 400)));
    assert.equal(r.status, 'fail');
    assert.match(r.details, /more than a year/);
});

test('an unreadable framework policy judges the whole catalogue, never nothing', async () => {
    fx.throws = true;
    const r = await check.evaluate('org1', null, at(plus(newest(), 1)));
    assert.equal(r.evidence.scope, 'catalogue');
    assert.equal(r.evidence.frameworks.length, frameworks.listBuiltin().length);
});
