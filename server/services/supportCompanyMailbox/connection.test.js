// @typecheck
/**
 * Where the company mailbox connects, and what an administrator reads when it fails.
 *
 * Run: cd server && node --test services/supportCompanyMailbox/connection.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { pinHost, describe, smtpOptions, imapOptions } = require('./connection.mts');
const { threadingHeaders, replySubject, newMessageId } = require('./send.mts');

const CONN = {
    emailAddress: 'support@example.test',
    imap: { host: 'imap.example.test', port: 993, security: /** @type {const} */ ('tls'), folder: 'INBOX' },
    smtp: { host: 'smtp.example.test', port: 587, security: /** @type {const} */ ('starttls') },
    username: 'support@example.test',
    smtpUsername: null,
    secrets: { password: 'imap-pass', smtpPassword: null },
};

test('pinHost refuses link-local and metadata, by literal and by what a name resolves to', async () => {
    await assert.rejects(pinHost('169.254.169.254'), { code: 'host_refused' });
    await assert.rejects(pinHost('metadata.google.internal'), { code: 'host_refused' });
    await assert.rejects(pinHost('mail.example.test', async () => ['10.0.0.5', '169.254.0.1']), { code: 'host_refused' });
    await assert.rejects(pinHost('nowhere.example.test', async () => { throw new Error('ENOTFOUND'); }), { code: 'host_unknown' });
});

test('pinHost allows a LAN mail server and keeps the name for TLS', async () => {
    assert.deepStrictEqual(await pinHost('mail.lan.test', async () => ['192.168.1.20']), { address: '192.168.1.20', servername: 'mail.lan.test' });
    assert.deepStrictEqual(await pinHost('10.0.0.9', async () => ['10.0.0.9']), { address: '10.0.0.9', servername: undefined });
});

test('the sockets go to the pinned address; SMTP uses the IMAP login unless it has its own', () => {
    const pinned = { address: '203.0.113.7', servername: 'smtp.example.test' };
    const smtp = smtpOptions(CONN, pinned);
    assert.strictEqual(smtp.host, '203.0.113.7');
    assert.deepStrictEqual(smtp.tls, { servername: 'smtp.example.test' });
    assert.strictEqual(smtp.secure, false);
    assert.strictEqual(smtp.requireTLS, true);
    assert.deepStrictEqual(smtp.auth, { user: 'support@example.test', pass: 'imap-pass' });
    const own = smtpOptions({ ...CONN, smtpUsername: 'relay-user', secrets: { password: 'imap-pass', smtpPassword: 'relay-pass' } }, pinned);
    assert.deepStrictEqual(own.auth, { user: 'relay-user', pass: 'relay-pass' });
    const imap = imapOptions(CONN, { address: '203.0.113.8', servername: 'imap.example.test' });
    assert.strictEqual(imap.host, '203.0.113.8');
    assert.strictEqual(imap.secure, true);
    assert.strictEqual(imap.servername, 'imap.example.test');
});

test('describe turns socket and login errors into words, never echoing the password', () => {
    assert.strictEqual(describe({ authenticationFailed: true }, 'IMAP', 'h').code, 'auth_failed');
    assert.strictEqual(describe({ code: 'EAUTH', message: 'Invalid login: imap-pass' }, 'SMTP', 'h').code, 'auth_failed');
    assert.ok(!describe({ code: 'EAUTH', message: 'Invalid login: imap-pass' }, 'SMTP', 'h').message.includes('imap-pass'));
    assert.strictEqual(describe({ code: 'ECONNREFUSED' }, 'SMTP', 'h').code, 'connect_refused');
    assert.strictEqual(describe({ code: 'ETIMEDOUT' }, 'IMAP', 'h').code, 'timeout');
    assert.strictEqual(describe({ code: 'ESOCKET', message: 'wrong version number' }, 'SMTP', 'h').code, 'tls_mismatch');
    assert.strictEqual(describe({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'IMAP', 'h').code, 'tls_failed');
});

test('a reply answers the customer\'s last message with a Message-ID, with the full References chain', () => {
    const msgs = [
        { author_kind: 'requester', rfc822_message_id: '<a@c>', email_references: null },
        { author_kind: 'staff', rfc822_message_id: '<ours@s>' },
        { author_kind: 'requester', rfc822_message_id: '<b@c>', email_references: '<a@c> <ours@s>' },
        { author_kind: 'requester', rfc822_message_id: null },
    ];
    assert.deepStrictEqual(threadingHeaders(msgs), { inReplyTo: '<b@c>', references: ['<a@c>', '<ours@s>', '<b@c>'] });
    assert.deepStrictEqual(threadingHeaders([]), { inReplyTo: null, references: [] });
});

test('reply subject and Message-ID', () => {
    assert.strictEqual(replySubject('Cannot sign in'), 'Re: Cannot sign in');
    assert.strictEqual(replySubject('RE: Cannot sign in'), 'RE: Cannot sign in');
    assert.strictEqual(replySubject(''), 'Re: (no subject)');
    const id = newMessageId('support@example.test');
    assert.ok(id.startsWith('<support-') && id.endsWith('@example.test>'), id);
});
