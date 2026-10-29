'use strict';

/**
 * Sending a message and reading an attachment (nextcloudMailActions.js)
 * against a fake Nextcloud Mail.
 *
 * Run: cd server && node --test integrations/nextcloudMailActions.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sendMail, readMailAttachment } = require('./nextcloudMailActions');

/** A fake auth answering each request with the next reply in `replies`. */
function fakeCtx(replies) {
    const calls = [];
    const ctx = {
        baseUrl: 'https://cloud.example.test',
        authError: 'Nextcloud is not connected.',
        fetch: async (url, options = {}) => {
            calls.push({ url, method: options.method || 'GET', body: options.body });
            const r = replies.shift();
            const bytes = Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? ''));
            return {
                status: r.status,
                ok: r.status >= 200 && r.status < 300,
                headers: new Map(Object.entries(r.headers || {})),
                text: async () => bytes.toString('utf8'),
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
            };
        },
    };
    return { ctx, calls };
}

const SEND = { accountId: 1, to: 'a@example.test, , b@example.test', cc: 'c@example.test', subject: 'Hi', body: 'Text', replyTo: 9 };

test('sendMail creates the draft, then dispatches it', async () => {
    const { ctx, calls } = fakeCtx([{ status: 200, body: { id: 42 } }, { status: 202, body: '' }]);
    assert.deepEqual(await sendMail(SEND, ctx), { success: true, outboxId: 42, to: SEND.to, subject: 'Hi' });
    const draft = JSON.parse(calls[0].body);
    assert.deepEqual(draft.to.map((r) => r.email), ['a@example.test', 'b@example.test']);
    assert.deepEqual(draft.cc.map((r) => r.email), ['c@example.test']);
    assert.deepEqual(draft.bcc, []);
    assert.equal(draft.inReplyToMessageId, 9);
    assert.match(calls[1].url, /\/index\.php\/apps\/mail\/api\/outbox\/42$/);
});

test('sendMail stops at a failed or id-less draft', async () => {
    assert.deepEqual(await sendMail(SEND, fakeCtx([{ status: 401, body: '' }]).ctx), { error: 'Nextcloud is not connected.' });
    assert.deepEqual(await sendMail(SEND, fakeCtx([{ status: 500, body: { message: 'boom' } }]).ctx), { error: 'Mail draft failed (500)', detail: { message: 'boom' } });
    assert.deepEqual(await sendMail(SEND, fakeCtx([{ status: 200, body: {} }]).ctx), { error: 'Mail draft created but no outbox id returned', detail: {} });
    assert.deepEqual(await sendMail({ accountId: 1, to: 'a@example.test' }, fakeCtx([]).ctx), { error: 'accountId, to, subject, and body are required' });
});

test('sendMail reports a failed dispatch with the outbox id', async () => {
    const { ctx } = fakeCtx([{ status: 201, body: { data: { id: 7 } } }, { status: 503, body: 'busy' }]);
    assert.deepEqual(await sendMail(SEND, ctx), { error: 'Mail send failed (503)', detail: 'busy', outboxId: 7 });
});

test('readMailAttachment returns a text attachment as UTF-8 and refuses a binary one', async () => {
    const text = fakeCtx([{ status: 200, body: 'hello there', headers: { 'content-type': 'text/plain' } }]);
    const out = await readMailAttachment({ messageId: 3, attachmentId: 'a1', filename: 'note.txt' }, text.ctx);
    assert.equal(out.content, 'hello there');
    assert.equal(out.truncated, false);

    const bin = fakeCtx([{ status: 200, body: 'PK', headers: { 'content-type': 'application/zip' } }]);
    const refused = await readMailAttachment({ messageId: 3, attachmentId: 'a2' }, bin.ctx);
    assert.equal(refused.filename, 'attachment-a2');
    assert.match(refused.error, /use nextcloud_mail_save_attachment/);
    assert.deepEqual(await readMailAttachment({ messageId: 3 }, bin.ctx), { error: 'messageId and attachmentId are required' });
});
