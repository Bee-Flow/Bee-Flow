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
        uid: 'alice',
        authError: 'Nextcloud is not connected.',
        fetch: async (url, options = {}) => {
            calls.push({ url, method: options.method || 'GET', body: options.body, headers: options.headers || {} });
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

const SEND = { accountId: 1, to: 'a@example.test, , b@example.test', cc: 'c@example.test', subject: 'Hi', body: 'Text' };

test('sendMail creates the draft, then dispatches it', async () => {
    const { ctx, calls } = fakeCtx([{ status: 200, body: { id: 42 } }, { status: 202, body: '' }]);
    assert.deepEqual(await sendMail(SEND, ctx), { success: true, outboxId: 42, to: SEND.to, subject: 'Hi', attachments: [] });
    const draft = JSON.parse(calls[0].body);
    assert.deepEqual(draft.to.map((r) => r.email), ['a@example.test', 'b@example.test']);
    assert.deepEqual(draft.cc.map((r) => r.email), ['c@example.test']);
    assert.deepEqual(draft.bcc, []);
    assert.equal('inReplyToMessageId' in draft, false, 'not a reply');
    assert.match(calls[1].url, /\/index\.php\/apps\/mail\/api\/outbox\/42$/);
    assert.deepEqual(draft.attachments, []);
});

test('a reply threads on the original\'s Message-ID header, looked up by its Mail id', async () => {
    // Mail's OutboxController takes `inReplyToMessageId` as a string and the
    // IMAP transmission writes it verbatim into In-Reply-To and References
    // (lib/IMAP/ImapTransmissionConnector.php); FlagRepliedMessageHandler finds
    // the original with findByMessageId. So it is the RFC Message-ID, not the
    // database id the Mail tools hand out.
    const { ctx, calls } = fakeCtx([
        { status: 200, body: { databaseId: 9, messageId: '<original@mail.example>', subject: 'Question' } },
        { status: 200, body: { id: 42 } },
        { status: 202, body: '' },
    ]);
    assert.equal((await sendMail({ ...SEND, replyTo: 9 }, ctx)).success, true);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /\/index\.php\/apps\/mail\/api\/messages\/9$/);
    assert.equal(JSON.parse(calls[1].body).inReplyToMessageId, '<original@mail.example>');
});

test('a Message-ID given as replyTo is used as it is; an original that cannot be read stops the send', async () => {
    const direct = fakeCtx([{ status: 200, body: { id: 43 } }, { status: 202, body: '' }]);
    await sendMail({ ...SEND, replyTo: '<original@mail.example>' }, direct.ctx);
    assert.equal(JSON.parse(direct.calls[0].body).inReplyToMessageId, '<original@mail.example>');

    const gone = fakeCtx([{ status: 403, body: [] }]);
    assert.match((await sendMail({ ...SEND, replyTo: 9 }, gone.ctx)).error, /message to reply to/);
    assert.equal(gone.calls.length, 1, 'no draft was created');

    const noHeader = fakeCtx([{ status: 200, body: { databaseId: 9, messageId: null } }]);
    assert.match((await sendMail({ ...SEND, replyTo: 9 }, noHeader.ctx)).error, /message to reply to/);

    assert.match((await sendMail({ ...SEND, replyTo: 'nine' }, fakeCtx([]).ctx)).error, /replyTo/);
});

test('the draft carries the body and S/MIME flags under the names every Mail version requires', async () => {
    // OutboxController::create: Mail 4 takes `body` + a required string
    // `editorBody`, Mail 5 `bodyPlain` / `bodyHtml`; both require the booleans
    // smimeSign / smimeEncrypt. Missing, the controller call fails.
    const plain = fakeCtx([{ status: 201, body: { data: { id: 5 } } }, { status: 202, body: '' }]);
    await sendMail(SEND, plain.ctx);
    const d = JSON.parse(plain.calls[0].body);
    assert.deepEqual(
        { body: d.body, bodyPlain: d.bodyPlain, bodyHtml: d.bodyHtml, editorBody: d.editorBody, isHtml: d.isHtml, smimeSign: d.smimeSign, smimeEncrypt: d.smimeEncrypt },
        { body: 'Text', bodyPlain: 'Text', bodyHtml: null, editorBody: 'Text', isHtml: false, smimeSign: false, smimeEncrypt: false },
    );
    const html = fakeCtx([{ status: 201, body: { data: { id: 6 } } }, { status: 202, body: '' }]);
    await sendMail({ ...SEND, body: '<p>Hello <i>there</i></p>', isHtml: true }, html.ctx);
    const h = JSON.parse(html.calls[0].body);
    assert.equal(h.bodyHtml, '<p>Hello <i>there</i></p>');
    assert.equal(h.isHtml, true);
    assert.match(h.bodyPlain, /Hello \*?there/);
    assert.ok(!/</.test(h.bodyPlain), 'the plain alternative has no tags');
});

/** A WebDAV Depth-0 answer for one file (or folder) of alice. */
function davEntry(path, { size = 1000, folder = false } = {}) {
    const href = `/remote.php/dav/files/alice${path.split('/').map(encodeURIComponent).join('/')}${folder ? '/' : ''}`;
    return {
        status: 207,
        body: `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:href>${href}</d:href>`
            + `<d:propstat><d:prop><d:getcontentlength>${size}</d:getcontentlength>`
            + `<d:resourcetype>${folder ? '<d:collection/>' : ''}</d:resourcetype><oc:fileid>77</oc:fileid></d:prop>`
            + '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
    };
}

test('a file from Nextcloud Files goes into the draft as a cloud attachment, after it was found', async () => {
    const { ctx, calls } = fakeCtx([
        davEntry('/Documents/offer 2026.pdf'),
        { status: 201, body: { data: { id: 8, attachments: [{ id: 1, fileName: 'offer 2026.pdf' }] } } },
        { status: 202, body: '' },
    ]);
    const out = await sendMail({ ...SEND, attachments: [{ path: '/Documents/offer 2026.pdf' }] }, ctx);
    assert.deepEqual(out, { success: true, outboxId: 8, to: SEND.to, subject: 'Hi', attachments: ['offer 2026.pdf'] });
    assert.equal(calls[0].method, 'PROPFIND');
    assert.match(calls[0].url, /\/remote\.php\/dav\/files\/alice\/Documents\/offer%202026\.pdf$/);
    assert.deepEqual(JSON.parse(calls[1].body).attachments, [{ type: 'cloud', fileName: '/Documents/offer 2026.pdf' }]);
});

test('a file given by its Files id is found as the sender (WebDAV SEARCH) and attached by its path', async () => {
    const { ctx, calls } = fakeCtx([
        davEntry('/Forms/upload 1.pdf'),
        { status: 201, body: { data: { id: 12, attachments: [{ id: 1 }] } } },
        { status: 202, body: '' },
    ]);
    const out = await sendMail({ ...SEND, attachments: [{ fileId: 77 }] }, ctx);
    assert.deepEqual(out, { success: true, outboxId: 12, to: SEND.to, subject: 'Hi', attachments: ['upload 1.pdf'] });
    assert.equal(calls[0].method, 'SEARCH');
    assert.match(calls[0].body, /<d:literal>77<\/d:literal>/);
    assert.match(calls[0].body, /<d:href>\/files\/alice<\/d:href>/, 'in the sender\'s own Files tree');
    assert.deepEqual(JSON.parse(calls[1].body).attachments, [{ type: 'cloud', fileName: '/Forms/upload 1.pdf' }]);
});

test('a missing file, a folder or a malformed entry stops the send before any draft exists', async () => {
    const missing = fakeCtx([{ status: 404, body: '' }]);
    assert.deepEqual(await sendMail({ ...SEND, attachments: [{ path: '/Documents/gone.pdf' }] }, missing.ctx),
        { error: 'Attachment not found in Nextcloud Files: /Documents/gone.pdf' });
    assert.equal(missing.calls.length, 1, 'no draft was created');

    const folder = fakeCtx([davEntry('/Documents', { folder: true })]);
    assert.match((await sendMail({ ...SEND, attachments: [{ path: '/Documents' }] }, folder.ctx)).error, /is a folder/);

    assert.match((await sendMail({ ...SEND, attachments: 'offer.pdf' }, fakeCtx([]).ctx)).error, /must be a list/);
    assert.match((await sendMail({ ...SEND, attachments: [{ name: 'x' }] }, fakeCtx([]).ctx)).error, /needs a path/);
});

test('attachments over the size cap are refused, naming the setting', async () => {
    process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB = '1';
    try {
        const big = fakeCtx([davEntry('/a.pdf', { size: 700_000 }), davEntry('/b.pdf', { size: 700_000 })]);
        const out = await sendMail({ ...SEND, attachments: [{ path: '/a.pdf' }, { path: '/b.pdf' }] }, big.ctx);
        assert.match(out.error, /NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB/);
        assert.equal(big.calls.length, 2, 'looked up, never drafted');
        process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB = '0';
        const unlimited = fakeCtx([davEntry('/a.pdf', { size: 700_000 }), davEntry('/b.pdf', { size: 700_000 }),
            { status: 201, body: { data: { id: 9, attachments: [{}, {}] } } }, { status: 202, body: '' }]);
        assert.equal((await sendMail({ ...SEND, attachments: [{ path: '/a.pdf' }, { path: '/b.pdf' }] }, unlimited.ctx)).success, true, '0 = unlimited');
    } finally {
        delete process.env.NEXTCLOUD_MAIL_ATTACHMENT_MAX_MB;
    }
});

test('a draft that came back short of an attachment is deleted, not sent', async () => {
    const { ctx, calls } = fakeCtx([
        davEntry('/Shared/no-download.pdf'),
        { status: 201, body: { data: { id: 11, attachments: [] } } },
        { status: 200, body: '' },
    ]);
    const out = await sendMail({ ...SEND, attachments: [{ path: '/Shared/no-download.pdf' }] }, ctx);
    assert.match(out.error, /took 0 of the 1 attachments/);
    assert.equal(calls[2].method, 'DELETE');
    assert.match(calls[2].url, /\/outbox\/11$/);
    assert.equal(calls.length, 3, 'never dispatched');
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
