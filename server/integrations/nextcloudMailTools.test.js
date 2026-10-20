'use strict';
/**
 * Nextcloud Mail tools against a fake Nextcloud: ids, bodies, flags and error
 * wording (issue 189).
 * Run: cd server && node --test integrations/nextcloudMailTools.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { executeNextcloudMailTool } = require('./nextcloudMailTools');
const { classifyNextcloudError } = require('../utils/nextcloudErrorClassifier');

const { json, run } = require('./nextcloudToolTestHarness');

// ── Mail ────────────────────────────────────────────────────────────────
test('mail_search returns the database id, keeps the header, and reads the attachment flag', async () => {
    const msg = {
        databaseId: 77,
        id: '<abc@example.test>',
        messageId: '<abc@example.test>',
        subject: 'Hi',
        flags: { hasAttachments: true },
        hasAttachments: false,
    };
    const { out } = await run(executeNextcloudMailTool, 'nextcloud_mail_search', { mailboxId: 3 }, async () => json(200, { newMessages: [msg] }));
    assert.strictEqual(out.messages[0].id, 77);
    assert.strictEqual(out.messages[0].messageIdHeader, '<abc@example.test>');
    assert.strictEqual(out.messages[0].hasAttachments, true);
});

test('mail_read turns an HTML body into text without script or style content', async () => {
    const html = '<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><p>Hello <b>there</b></p><div>Second line</div></body></html>';
    const { out } = await run(executeNextcloudMailTool, 'nextcloud_mail_read', { messageId: 5 }, async () => json(200, { id: 5, body: html, hasHtmlBody: true }));
    assert.ok(!/[<>]|alert|color:red/.test(out.body), out.body);
    assert.match(out.body, /Hello \*\*there\*\*/);
    assert.match(out.body, /Second line/);
});

test('mail_read prefers the plain part and leaves a plain body alone', async () => {
    const a = await run(executeNextcloudMailTool, 'nextcloud_mail_read', { messageId: 5 }, async () => json(200, { body: '<p>x</p>', bodyPlain: 'plain x', hasHtmlBody: true }));
    assert.strictEqual(a.out.body, 'plain x');
    const b = await run(executeNextcloudMailTool, 'nextcloud_mail_read', { messageId: 5 }, async () => json(200, { body: 'a < b and c > d' }));
    assert.strictEqual(b.out.body, 'a < b and c > d');
});

test('mail_read returns the numeric id, not the header', async () => {
    const { out } = await run(executeNextcloudMailTool, 'nextcloud_mail_read', { messageId: 5 },
        async () => json(200, { id: '<h@example.test>', messageId: '<h@example.test>', databaseId: 5, body: 'x' }));
    assert.strictEqual(out.id, 5);
    assert.strictEqual(out.messageIdHeader, '<h@example.test>');
});

test('mail_list_mailboxes normalises specialRole and no longer invents a message count', async () => {
    const boxes = [
        { databaseId: 1, name: 'INBOX', specialRole: [] },
        { databaseId: 2, name: 'Sent', specialRole: 'sent' },
        { databaseId: 3, name: 'Old', specialUse: ['\\Archive'] },
    ];
    const { out } = await run(executeNextcloudMailTool, 'nextcloud_mail_list_mailboxes', { accountId: 1 }, async () => json(200, boxes));
    assert.deepStrictEqual(out.mailboxes.map(m => m.specialRole), [null, 'sent', 'archive']);
    assert.ok(out.mailboxes.every(m => !('totalMessages' in m)));
});

test('mail errors: 403 is a permission error, 400 and 409 are explained, a timeout names the fix', async () => {
    const status = async (s) => (await run(executeNextcloudMailTool, 'nextcloud_mail_read', { messageId: 1 }, async () => json(s, {}))).out.error;
    assert.match(await status(403), /Permission denied for mail read/);
    assert.match(await status(400), /Check the accountId/);
    assert.match(await status(409), /syncing/);
    assert.match(await status(404), /Not found for mail read/);
    const t = await run(executeNextcloudMailTool, 'nextcloud_mail_search', { mailboxId: 1 }, async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    assert.match(t.out.error, /timed out.*query/);
});

test('the classifier knows a Mail search timeout and ignores unrelated "mail" wording', () => {
    const t = classifyNextcloudError({ error: 'Mail search timed out: the mailbox is large.' });
    assert.strictEqual(t.code, 'TIMEOUT');
    assert.match(t.remediation, /query/);
    const files = classifyNextcloudError({ error: 'Permission denied for read of /Documents/mail merge.docx' });
    assert.match(files.message, /file or folder/);
});

test('the classifier does not give Mail errors the Files advice', async () => {
    const { out } = await run(executeNextcloudMailTool, 'nextcloud_mail_read', { messageId: 1 }, async () => json(403, {}));
    const c = classifyNextcloudError(out);
    assert.doesNotMatch(c.message, /file or folder/);
    assert.doesNotMatch(c.remediation, /Share the folder/);
    assert.match(c.message, /mail/i);
});


// ── Attachment size cap (TOOL_FILE_MAX_BYTES) ───────────────────────────
function binaryReply(buf, headers = {}) {
    return { ok: true, status: 200, headers: new Headers(headers), text: async () => buf.toString(), arrayBuffer: async () => Uint8Array.from(buf).buffer };
}

test('mail_read_attachment refuses an attachment over TOOL_FILE_MAX_BYTES and names the variable', async () => {
    const prev = process.env.TOOL_FILE_MAX_BYTES;
    process.env.TOOL_FILE_MAX_BYTES = String(1024 * 1024);
    try {
        const { out } = await run(executeNextcloudMailTool, 'nextcloud_mail_read_attachment', { messageId: 5, attachmentId: 'a1', filename: 'big.txt' },
            async () => binaryReply(Buffer.alloc(2 * 1024 * 1024, 97), { 'content-type': 'text/plain', 'content-length': String(2 * 1024 * 1024) }));
        assert.match(out.error, /TOOL_FILE_MAX_BYTES/);
        assert.match(out.error, /2\.0 MB/);
        assert.strictEqual(out.content, undefined);
    } finally {
        if (prev === undefined) delete process.env.TOOL_FILE_MAX_BYTES; else process.env.TOOL_FILE_MAX_BYTES = prev;
    }
});

test('mail_read_attachment still reads a 1 MB text attachment under the default cap', async () => {
    const { out } = await run(executeNextcloudMailTool, 'nextcloud_mail_read_attachment', { messageId: 5, attachmentId: 'a1', filename: 'ok.txt' },
        async () => binaryReply(Buffer.alloc(1024 * 1024, 97), { 'content-type': 'text/plain' }));
    assert.strictEqual(out.error, undefined);
    assert.strictEqual(out.size, 1024 * 1024);
});
