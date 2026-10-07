/**
 * GDPR-Art32-encryption-at-rest — passes only when message bodies really are
 * written encrypted.
 *
 * Pins the false pass where the check passed on MASTER_ENCRYPTION_KEY and
 * SESSION_SECRET alone and said "messages stored encrypted at rest", while the
 * organisation's content-encryption tier ('none' by default) wrote them in
 * plaintext.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art32-encryption-at-rest.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const fx = { policy: null, asked: [] };
const restore = installResolveStub({
    '../../../stores/encryptionPolicy': {
        resolvePolicy: async (orgId) => { fx.asked.push(orgId); return fx.policy; },
        shouldEncrypt: (p, s) => !!p?.scope?.[s],
        SURFACES: { MESSAGES: 'messages', NOTEBOOK_MESSAGES: 'notebookMessages' },
    },
});
const check = require('./art32-encryption-at-rest');

const saved = { master: process.env.MASTER_ENCRYPTION_KEY, session: process.env.SESSION_SECRET };
test.beforeEach(() => {
    process.env.MASTER_ENCRYPTION_KEY = 'test-master';
    process.env.SESSION_SECRET = 'test-session';
    fx.asked = [];
});
test.after(() => {
    restore();
    for (const [k, v] of [['MASTER_ENCRYPTION_KEY', saved.master], ['SESSION_SECRET', saved.session]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
});

test('keys set but tier "none": warn, never "stored encrypted"', async () => {
    fx.policy = { tier: 'none', enabled: false, scope: { messages: false, notebookMessages: false } };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(fx.asked, ['org-1']);
    assert.equal(r.evidence.encryption_tier, 'none');
    assert.equal(r.evidence.messages_encrypted, false);
    assert.deepEqual(r.evidence.plaintext_surfaces, ['messages', 'notebookMessages']);
    assert.doesNotMatch(r.details, /stored encrypted/);
    assert.match(r.details, /plaintext/);
});

test('keys set and a managed tier that covers the message bodies: pass', async () => {
    fx.policy = { tier: 'managed', enabled: true, scope: { messages: true, notebookMessages: true } };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.messages_encrypted, true);
    assert.deepEqual(r.evidence.plaintext_surfaces, []);
});

test('a tier whose scope leaves message bodies out: warn, naming them', async () => {
    fx.policy = { tier: 'zk', enabled: true, scope: { messages: false, notebookMessages: true } };
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.plaintext_surfaces, ['messages']);
    assert.match(r.details, /messages in plaintext/);
});

test('the legacy "default" org id resolves as no organisation', async () => {
    fx.policy = { tier: 'none', enabled: false, scope: {} };
    await check.evaluate('default');
    assert.deepEqual(fx.asked, [null]);
});

test('master key missing: fail, and the details do not claim encryption', async () => {
    delete process.env.MASTER_ENCRYPTION_KEY;
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail');
    assert.doesNotMatch(r.details, /stored encrypted/);
    assert.match(r.details, /MASTER_ENCRYPTION_KEY/);
});

test('session secret missing: fail, and the details do not claim encryption', async () => {
    delete process.env.SESSION_SECRET;
    const r = await check.evaluate('org-1');
    assert.equal(r.status, 'fail');
    assert.doesNotMatch(r.details, /stored encrypted/);
    assert.match(r.details, /SESSION_SECRET/);
});
