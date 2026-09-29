/**
 * Shared outbound e-mail layer.
 *
 * Covers what supportMailer never exercised: shared mailboxes (`/users/{addr}`),
 * the cheap `reply` strategy, cc, and header-injection hygiene.
 *
 * Run: cd server && node --test services/email/send.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let gmailSends = [];
let graphCalls = [];

stub('./providerClients', {
    gmailClientFromTokens: async () => ({
        users: {
            messages: {
                send: async ({ userId, requestBody }) => {
                    gmailSends.push({ userId, requestBody });
                    return { data: { id: 'sent-1', threadId: requestBody.threadId || 'thread-new' } };
                },
            },
        },
    }),
    graphFetchFromTokens: async (_tokens, _onRefresh, path, opts = {}) => {
        graphCalls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
        if (path.endsWith('/createReply')) return { id: 'draft-1' };
        return {};
    },
});

const send = require('./send');

function decodeRaw(encoded) {
    return Buffer.from(String(encoded).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function headersOf(mime) {
    return mime.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
}

const TOKENS = { accessToken: 'at', refreshToken: 'rt' };

test.beforeEach(() => { gmailSends = []; graphCalls = []; });

// ── Guard rails ──────────────────────────────────────────────────────────────

test('refuses an unknown provider, missing tokens, or no from-address', async () => {
    await assert.rejects(
        () => send.sendMailMessage({ provider: 'imap', tokens: TOKENS, mailbox: { address: 'a@b.nl' } }),
        /Unsupported provider: imap/,
    );
    await assert.rejects(
        () => send.sendMailMessage({ provider: 'gmail', tokens: null, mailbox: { address: 'a@b.nl' } }),
        /not connected/i,
    );
    await assert.rejects(
        () => send.sendMailMessage({ provider: 'gmail', tokens: TOKENS, mailbox: {} }),
        /No mailbox address/,
    );
});

// ── Gmail ────────────────────────────────────────────────────────────────────

test('gmail personal: threads on Message-ID + References and sends as "me"', async () => {
    const res = await send.sendMailMessage({
        provider: 'gmail', tokens: TOKENS,
        mailbox: { address: 'ik@acme.nl', displayName: 'Ik', mode: 'personal' },
        to: 'klant@example.com', subject: 'Re: vraag', textBody: 'antwoord',
        inReplyTo: '<parent@x>', references: '<root@x>',
        providerThreadId: 'th-1', messageIdSeed: 'seed7',
    });

    assert.strictEqual(gmailSends[0].userId, 'me');
    assert.strictEqual(gmailSends[0].requestBody.threadId, 'th-1');
    const headers = headersOf(decodeRaw(gmailSends[0].requestBody.raw));
    assert.match(headers, /^From: Ik <ik@acme\.nl>$/m);
    assert.match(headers, /^References: <root@x> <parent@x>$/m);
    assert.strictEqual(res.providerMessageId, 'sent-1');
    assert.match(res.rfc822MessageId, /^<support-seed7-.*@acme\.nl>$/);
});

test('gmail shared: still sends over "me", but FROM the alias address', async () => {
    // Gmail cannot touch a delegated mailbox; "shared" is a verified send-as
    // alias on the user's own mailbox. If this ever routes to another userId,
    // the API will 403 and the feature is silently broken.
    await send.sendMailMessage({
        provider: 'gmail', tokens: TOKENS,
        mailbox: { address: 'support@acme.nl', displayName: 'Acme Support', mode: 'shared' },
        to: 'klant@example.com', subject: 'Hoi', textBody: 'hoi',
    });

    assert.strictEqual(gmailSends[0].userId, 'me');
    assert.match(headersOf(decodeRaw(gmailSends[0].requestBody.raw)), /^From: Acme Support <support@acme\.nl>$/m);
});

test('gmail: cc is carried and a list of recipients is joined', async () => {
    await send.sendMailMessage({
        provider: 'gmail', tokens: TOKENS, mailbox: { address: 'ik@acme.nl' },
        to: ['een@example.com', 'twee@example.com'], cc: 'cc@example.com',
        subject: 's', textBody: 'b',
    });

    const headers = headersOf(decodeRaw(gmailSends[0].requestBody.raw));
    assert.match(headers, /^To: een@example\.com, twee@example\.com$/m);
    assert.match(headers, /^Cc: cc@example\.com$/m);
});

// ── Outlook ──────────────────────────────────────────────────────────────────

test('outlook personal: default strategy is the single-call reply', async () => {
    // `reply` needs only Mail.Send; `createReply` needs Mail.ReadWrite. New
    // callers must get the cheap one by default.
    await send.sendMailMessage({
        provider: 'outlook', tokens: TOKENS,
        mailbox: { address: 'ik@acme.nl', mode: 'personal' },
        to: 'klant@example.com', cc: 'chef@acme.nl', subject: 'Re: x', htmlBody: '<p>hoi</p>',
        sourceProviderMessageId: 'AAMk-1',
    });

    assert.strictEqual(graphCalls.length, 1);
    assert.strictEqual(graphCalls[0].method, 'POST');
    assert.strictEqual(graphCalls[0].path, '/me/messages/AAMk-1/reply');
    assert.strictEqual(graphCalls[0].body.comment, '<p>hoi</p>');
    assert.strictEqual(graphCalls[0].body.message.toRecipients[0].emailAddress.address, 'klant@example.com');
    assert.strictEqual(graphCalls[0].body.message.ccRecipients[0].emailAddress.address, 'chef@acme.nl');
});

test('outlook shared: every path is addressed as /users/{address}', async () => {
    await send.sendMailMessage({
        provider: 'outlook', tokens: TOKENS,
        mailbox: { address: 'support@acme.nl', mode: 'shared' },
        to: 'klant@example.com', subject: 'Re: x', htmlBody: '<p>hoi</p>',
        sourceProviderMessageId: 'AAMk-1',
    });
    assert.strictEqual(graphCalls[0].path, '/users/support%40acme.nl/messages/AAMk-1/reply');

    graphCalls = [];
    await send.sendMailMessage({
        provider: 'outlook', tokens: TOKENS,
        mailbox: { address: 'support@acme.nl', mode: 'shared' },
        to: 'klant@example.com', subject: 'nieuw', htmlBody: '<p>hoi</p>',
    });
    assert.strictEqual(graphCalls[0].path, '/users/support%40acme.nl/sendMail');
});

test('outlook: createReply keeps the exact three-call sequence, shared or not', async () => {
    await send.sendMailMessage({
        provider: 'outlook', tokens: TOKENS,
        mailbox: { address: 'support@acme.nl', mode: 'shared' },
        to: 'klant@example.com', subject: 'Re: x', htmlBody: '<p>hoi</p>',
        sourceProviderMessageId: 'AAMk-1', replyStrategy: 'createReply',
    });

    assert.deepStrictEqual(graphCalls.map((c) => `${c.method} ${c.path}`), [
        'POST /users/support%40acme.nl/messages/AAMk-1/createReply',
        'PATCH /users/support%40acme.nl/messages/draft-1',
        'POST /users/support%40acme.nl/messages/draft-1/send',
    ]);
});

test('outlook: no source message falls back to sendMail', async () => {
    await send.sendMailMessage({
        provider: 'outlook', tokens: TOKENS, mailbox: { address: 'ik@acme.nl' },
        to: 'klant@example.com', subject: 'nieuw', htmlBody: '<p>hoi</p>',
    });

    assert.strictEqual(graphCalls[0].path, '/me/sendMail');
    assert.strictEqual(graphCalls[0].body.saveToSentItems, true);
    assert.strictEqual(graphCalls[0].body.message.subject, 'nieuw');
});

// ── Security ─────────────────────────────────────────────────────────────────

test('CRLF in a header value cannot inject a header (Graph path)', async () => {
    // The Graph JSON path never passes through MailComposer, so nothing else
    // would escape this.
    await send.sendMailMessage({
        provider: 'outlook', tokens: TOKENS, mailbox: { address: 'ik@acme.nl' },
        to: 'klant@example.com\r\nBcc: stiekem@evil.com',
        subject: 'hoi\r\nX-Injected: 1',
        htmlBody: '<p>x</p>',
    });

    const body = graphCalls[0].body;
    assert.doesNotMatch(body.message.subject, /[\r\n]/);
    assert.strictEqual(body.message.subject, 'hoi X-Injected: 1');
    assert.strictEqual(body.message.toRecipients.length, 1);
    assert.doesNotMatch(body.message.toRecipients[0].emailAddress.address, /[\r\n]/);
});

test('script tags and inline handlers are stripped from the HTML body', async () => {
    await send.sendMailMessage({
        provider: 'outlook', tokens: TOKENS, mailbox: { address: 'ik@acme.nl' },
        to: 'klant@example.com', subject: 's',
        htmlBody: '<p onclick="x()">hoi</p><script>evil()</script>',
    });

    const html = graphCalls[0].body.message.body.content;
    assert.doesNotMatch(html, /<script|onclick/i);
    assert.match(html, /hoi/);
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('helpers behave', () => {
    assert.strictEqual(send.stripHeaderValue('a\r\nb'), 'a b');
    assert.strictEqual(send.stripHeaderValue(null), '');
    assert.deepStrictEqual(send.toRecipientList('a@x.nl, b@x.nl'), ['a@x.nl', 'b@x.nl']);
    assert.deepStrictEqual(send.toRecipientList(null), []);
    assert.deepStrictEqual(send.graphRecipients('a@x.nl'), [{ emailAddress: { address: 'a@x.nl' } }]);
    assert.strictEqual(send.buildReferenceChain('<r@x>', '<p@x>'), '<r@x> <p@x>');
    assert.strictEqual(send.buildReferenceChain(null, null), undefined);
    assert.strictEqual(send.senderDomain('a@sub.example.org'), 'sub.example.org');
    assert.strictEqual(send.senderDomain('kapot'), 'beeflow.nl');
});

// ── sanitizeHtml: an allowlist, not five regexes ─────────────────────
//
// The regex version was written when the only HTML this ever saw came from our
// own markdown renderer. The reply editor now sends author-written HTML with
// pasted fragments in it, and a regex looking for "<script>" does not see an
// onerror written across a newline, an <svg><script>, or a <base> that reroutes
// every relative link in the message.

test('inline style survives — it is the only styling mail clients honour', () => {
    const out = send.sanitizeHtml('<p style="color:#c00;font-family:Calibri">Hoi</p>');
    assert.match(out, /style="color:#c00;font-family:Calibri"/);
});

test('a Word paste loses its <style> block and its class names', () => {
    // Both are discarded or mangled by Gmail and Outlook anyway, and a Word
    // paste drags in kilobytes of them.
    const out = send.sanitizeHtml('<style>.MsoNormal{color:red}</style><p class="MsoNormal">Word</p>');
    assert.equal(out, '<p>Word</p>');
});

test('a signature logo still works, by cid or by data URI', () => {
    assert.match(send.sanitizeHtml('<img src="cid:logo1" alt="logo">'), /src="cid:logo1"/);
    assert.match(send.sanitizeHtml('<img src="data:image/png;base64,iVBOR" alt="l">'), /src="data:image\/png/);
});

test('the things a regex misses are gone', () => {
    for (const [markup, gone] of [
        ['<img src=x onerror=alert(1)>', /onerror/i],
        ['<img\n  src=x\n  onerror="alert(1)">', /onerror/i],
        ['<script>evil()</script><b>ok</b>', /script/i],
        ['<svg><script>evil()</script></svg>', /script/i],
        ['<base href="http://evil/">', /<base/i],
        ['<a href="javascript:alert(1)">klik</a>', /javascript:/i],
        ['<iframe src="http://evil"></iframe>', /iframe/i],
        ['<form action="http://evil"><input></form>', /<form/i],
    ]) {
        assert.doesNotMatch(send.sanitizeHtml(markup), gone, markup);
    }
});

test('the markup a real reply is made of comes through', () => {
    const body = '<p><b>Beste Jan</b>,</p><ul><li>punt</li></ul>'
        + '<table><tr><td style="padding:4px">1</td></tr></table>'
        + '<a href="https://beeflow.nl" target="_blank">site</a>';
    const out = send.sanitizeHtml(body);
    for (const kept of ['<b>', '<ul>', '<li>', '<td style="padding:4px">', 'href="https://beeflow.nl"']) {
        assert.ok(out.includes(kept), `${kept} survives`);
    }
});

test('an empty body is still an empty string, not "undefined"', () => {
    assert.equal(send.sanitizeHtml(''), '');
    assert.equal(send.sanitizeHtml(null), '');
    assert.equal(send.sanitizeHtml(undefined), '');
});
