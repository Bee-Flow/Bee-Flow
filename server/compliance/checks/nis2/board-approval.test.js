/**
 * NIS2-Art20-board-approval — admins acknowledged the published ISP + board training stamp.
 * Run: cd server && node --test --test-force-exit compliance/checks/nis2/board-approval.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const fx = { doc: null, admins: [], review: null, settings: {}, docError: null, adminError: null, seen: [] };
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR' });
const fakeDb = {
    async getOne(sql, params) {
        fx.seen.push({ sql, params });
        if (/FROM isms_documents/.test(sql)) {
            if (fx.docError) throw fx.docError;
            assert.deepEqual(params, [ORG, 'information-security-policy']);
            return fx.doc;
        }
        if (/FROM iso_management_reviews/.test(sql)) { if (fx.review === 'missing') throw pgError('42P01'); return fx.review; }
        throw new Error(`unexpected sql ${sql}`);
    },
    async getAll(sql, params) {
        fx.seen.push({ sql, params });
        if (fx.adminError) throw fx.adminError;
        assert.match(sql, /FROM users u/);
        assert.match(sql, /LEFT JOIN isms_acknowledgements a/);
        assert.equal(params[0], ORG);
        assert.equal(params[1], 'information-security-policy');
        assert.equal(params[2], fx.doc.current_version, 'acks bind to the CURRENT version');
        return fx.admins.map(a => ({ id: a.id, acknowledged: !!a.acknowledged }));
    },
};
const restore = installResolveStub({
    '../../../db': fakeDb,
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
});
const check = require('./board-approval');
test.after(() => restore());

const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();
const admin = (id, acknowledged) => ({ id, acknowledged, email: `${id}@example.org`, displayName: `Person ${id}` });

test.beforeEach(() => {
    fx.doc = { status: 'published', current_version: 3 }; fx.admins = []; fx.review = null; fx.settings = {};
    fx.docError = null; fx.adminError = null; fx.seen = [];
});

test('contract shape — hybrid', () => {
    assert.equal(check.id, 'NIS2-Art20-board-approval');
    assert.equal(check.verification, 'hybrid');
    assert.equal(check.severity, 'high');
    assert.equal(check.remediationLink, 'admin/compliance/policies');
});

test('relevance gate', async () => {
    fx.settings = { framework_relevance: { nis2: 'not_relevant' } };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'not_applicable');
    assert.equal(fx.seen.length, 0);
});

test('policy not published → fail (no admin query)', async () => {
    fx.doc = { status: 'draft', current_version: 0 };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.policy_published, false);
    assert.ok(!fx.seen.some(s => /FROM users u/.test(s.sql)));
});

test('missing policy row entirely → fail', async () => {
    fx.doc = null;
    assert.equal((await check.evaluate(ORG)).status, 'fail');
});

test('all admins acknowledged + fresh board training → pass', async () => {
    fx.admins = [admin('u1', true), admin('u2', true)];
    fx.settings = { nis2_board_training_at: daysAgo(30) };
    fx.review = { held_at: daysAgo(10), attendees_count: 3 };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.acknowledged, 2);
    assert.equal(r.evidence.board_training_current, true);
    assert.equal(r.evidence.last_management_review.attendees_count, 3);
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, EMAIL);
});

test('all acknowledged but no board training recorded → warn (hybrid attestation part)', async () => {
    fx.admins = [admin('u1', true)];
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.board_training_current, false);
    assert.match(r.details, /No management cybersecurity training/);
});

test('stale board training (> 365 d) → warn with the age', async () => {
    fx.admins = [admin('u1', true)];
    fx.settings = { nis2_board_training_at: daysAgo(400) };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.match(r.details, /400 days ago/);
});

test('some admins acknowledged → warn, unacknowledged ids only (no names/e-mail)', async () => {
    fx.admins = [admin('u1', true), admin('u2', false), admin('u3', false)];
    fx.settings = { nis2_board_training_at: daysAgo(1) };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.unacknowledged, ['u2', 'u3']);
    assert.doesNotMatch(JSON.stringify(r.evidence) + r.details, EMAIL);
    assert.doesNotMatch(JSON.stringify(r.evidence), /Person/);
});

test('no admin acknowledged → fail', async () => {
    fx.admins = [admin('u1', false)];
    fx.settings = { nis2_board_training_at: daysAgo(1) };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'fail');
    assert.match(r.details, /None of the 1 admin/);
});

test('no admin accounts at all → warn', async () => {
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.admins_total, 0);
});

test('management-review register missing is only an evidence gap', async () => {
    fx.admins = [admin('u1', true)]; fx.review = 'missing';
    fx.settings = { nis2_board_training_at: daysAgo(1) };
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.last_management_review, null);
});

test('missing tables → warn not provisioned, never throws', async () => {
    fx.docError = pgError('42P01');
    assert.match((await check.evaluate(ORG)).details, /not provisioned/);
    fx.docError = null; fx.adminError = pgError('42703');
    const r = await check.evaluate(ORG);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.provisioned, false);
});
