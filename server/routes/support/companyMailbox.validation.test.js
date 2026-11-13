// @typecheck
/**
 * /api/support/mailbox/imap: only a super-admin reaches it, a malformed body
 * is refused before any store or socket, and a stored password is only reused
 * for the account it belongs to.
 *
 * Run: cd server && node --test routes/support/companyMailbox.validation.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-at-least-32-characters-long';

const h = require('../../testUtils/routeHarness');

const db = h.recordDb();
const companyMailbox = require('./companyMailbox.mts');

const router = express.Router();
companyMailbox.register(router);
const ADMIN = { id: 'admin-1', organizationId: 'org-1', role: 'admin', email: 'admin@example.test' };
const MEMBER = { id: 'member-1', organizationId: 'org-1', role: 'user', email: 'member@example.test' };
const api = h.serve('/api/support', router, { user: ADMIN });
after(api.close);

const BODY = {
    emailAddress: 'support@example.test',
    imap: { host: 'imap.example.test', port: 993, security: 'tls' },
    smtp: { host: 'smtp.example.test', port: 587, security: 'starttls' },
    username: 'support@example.test',
    password: 'secret',
};

/** The queries the calls in `fn` made (store boot queries from module load are not theirs). */
async function queriesDuring(/** @type {() => Promise<void>} */ fn) {
    await new Promise((r) => setTimeout(r, 50));
    const start = db.queries.length;
    await fn();
    return db.queries.slice(start);
}

test('a member who is not a super-admin is refused on every route, before the body is read', async () => {
    const made = await queriesDuring(async () => {
        for (const [method, url] of [['PUT', '/api/support/mailbox/imap'], ['POST', '/api/support/mailbox/imap/test'], ['POST', '/api/support/mailbox/imap/sync'], ['DELETE', '/api/support/mailbox/imap']]) {
            const res = await api.call(method, url, { body: BODY, user: MEMBER });
            assert.strictEqual(res.status, 403, `${method} ${url}`);
        }
    });
    assert.deepStrictEqual(made, []);
});

test('a malformed body is refused by name, with no query', async () => {
    const cases = [
        { ...BODY, imap: { ...BODY.imap, port: 0 } },
        { ...BODY, imap: { ...BODY.imap, security: 'ssl' } },
        { ...BODY, smtp: { ...BODY.smtp, host: 'smtp.example.test/path' } },
        { ...BODY, emailAddress: 'not-an-address' },
        { ...BODY, imap: { ...BODY.imap, hots: 'x' } },
        { ...BODY, extra: true },
    ];
    const made = await queriesDuring(async () => {
        for (const body of cases) {
            const res = await api.call('PUT', '/api/support/mailbox/imap', { body });
            assert.strictEqual(res.status, 400, JSON.stringify(body));
        }
    });
    assert.deepStrictEqual(made, []);
});

test('isPlausibleHost accepts names and addresses, nothing with a path, a user or a space', () => {
    for (const ok of ['imap.example.test', '10.0.0.5', '[2001:db8::1]', 'mail-1.lan']) assert.ok(companyMailbox.isPlausibleHost(ok), ok);
    for (const bad of ['', 'a b', 'user@host', 'host/path', 'host?x', 'x'.repeat(254)]) assert.ok(!companyMailbox.isPlausibleHost(bad), bad);
});

const STORED = {
    emailAddress: 'support@example.test', displayName: '', active: true, aiAutoReply: false,
    imap: { host: 'imap.example.test', port: 993, security: /** @type {const} */ ('tls'), folder: 'INBOX' },
    smtp: { host: 'smtp.example.test', port: 587, security: /** @type {const} */ ('starttls') },
    username: 'support@example.test', smtpUsername: null,
    secrets: { password: 'stored-secret', smtpPassword: null },
    uidValidity: null, lastUid: null, syncAfter: '', generation: 1, syncStatus: 'idle', syncError: null, lastSyncAt: null, createdAt: null, updatedAt: null,
};

test('resolveConnection reuses the stored password for the same account only', () => {
    const { password: _drop, ...noPassword } = BODY;
    const same = companyMailbox.resolveConnection(/** @type {any} */ (noPassword), STORED);
    assert.strictEqual(same.secrets.password, 'stored-secret');
    assert.throws(
        () => companyMailbox.resolveConnection(/** @type {any} */ ({ ...noPassword, imap: { ...BODY.imap, host: 'evil.example.test' } }), STORED),
        { code: 'password_required' },
        'a new host never gets the stored password',
    );
    assert.throws(() => companyMailbox.resolveConnection(/** @type {any} */ (noPassword), null), { code: 'password_required' });
    const typed = companyMailbox.resolveConnection(/** @type {any} */ (BODY), STORED);
    assert.strictEqual(typed.secrets.password, 'secret');
    assert.strictEqual(typed.imap.folder, 'INBOX');
});

test('resolveConnection never sends the stored password to an SMTP host just typed in', () => {
    const { password: _drop, ...noPassword } = BODY;
    assert.throws(
        () => companyMailbox.resolveConnection(/** @type {any} */ ({ ...noPassword, smtp: { ...BODY.smtp, host: 'elsewhere.example.test' } }), STORED),
        { code: 'password_required' },
    );
});

test('resolveConnection asks for an SMTP password when the SMTP login differs', () => {
    assert.throws(
        () => companyMailbox.resolveConnection(/** @type {any} */ ({ ...BODY, smtpUsername: 'relay' }), STORED),
        { code: 'smtp_password_required' },
    );
    const c = companyMailbox.resolveConnection(/** @type {any} */ ({ ...BODY, smtpUsername: 'relay', smtpPassword: 'relay-secret' }), STORED);
    assert.strictEqual(c.smtpUsername, 'relay');
    assert.strictEqual(c.secrets.smtpPassword, 'relay-secret');
});
