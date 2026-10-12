'use strict';

/**
 * ISO27001-A.5.14-mail-security — a failed config read warns instead of
 * dropping out as not applicable, and the snapshot judged is the one of the
 * configured domain, not the alphabetically first subject.
 *
 * The evidence store is the real singleton with its two read functions
 * replaced per test (the smoke harness does the same).
 *
 * Run: cd server && node --test compliance/checks/iso27001/a5-14-mail-security.test.js
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const isoEvidenceStore = require('../../../stores/isoEvidenceStore');
const check = require('./a5-14-mail-security');

const saved = { getConfig: isoEvidenceStore.getConfig, listLatestSnapshots: isoEvidenceStore.listLatestSnapshots };
afterEach(() => Object.assign(isoEvidenceStore, saved));

function stub(config, snaps = []) {
    isoEvidenceStore.getConfig = async () => (typeof config === 'function' ? config() : config);
    isoEvidenceStore.listLatestSnapshots = async () => snaps;
}

const full = (domain) => ({
    subject_id: domain,
    fetched_at: '2026-10-01T00:00:00Z',
    payload: { domain, spf: { present: true }, dmarc: { present: true, policy: 'reject' }, dkim: { found_selectors: ['google'] } },
});
const open = (domain) => ({
    subject_id: domain,
    payload: { domain, spf: { present: false }, dmarc: { present: false }, dkim: { found_selectors: [] } },
});

test('a config read that fails warns; it is not "connector not enabled"', async () => {
    stub(() => { throw Object.assign(new Error('timeout'), { code: '57014' }); });
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.error_code, '57014');
});

test('the configured domain is judged, not the first subject in the list', async () => {
    // 'acme.nl' sorts before 'beta.nl': the stale snapshot comes first.
    stub({ enabled: true, settings: { domain: ' Beta.NL ' } }, [open('acme.nl'), full('beta.nl')]);
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.domain, 'beta.nl');
});

test('no snapshot for the configured domain yet warns; no domain configured says so', async () => {
    stub({ enabled: true, settings: { domain: 'new.nl' } }, [full('old.nl')]);
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.match(r.details, /no snapshot for new\.nl/);
    stub({ enabled: true }, [full('old.nl')]);
    assert.match((await check.evaluate('org1')).details, /no sending domain is configured/);
});

test('a disabled connector is not applicable', async () => {
    stub({ enabled: false });
    assert.equal((await check.evaluate('org1')).status, 'not_applicable');
});
