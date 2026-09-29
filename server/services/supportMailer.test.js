/**
 * Support Mailer — GOLDEN test.
 *
 * This locks the exact wire behaviour of the live support inbox: the decoded
 * RFC822 headers Gmail receives, and the exact Graph call sequence Outlook
 * receives. It exists so the shared-email-layer extraction (services/email/send.js)
 * can be proven to change NOTHING for support.
 *
 * It must pass byte-identically before and after that refactor. If a change here
 * is needed, that change is a deliberate behaviour change to the support inbox —
 * not refactor fallout.
 *
 * Run: cd server && node --test services/supportMailer.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Recorders ────────────────────────────────────────────────────────────────
let gmailSends = [];      // { userId, requestBody }
let graphCalls = [];      // { path, method, body }
let refreshedWith = [];   // tokens written back through onRefresh
let inboxRow = null;

stub('./email/providerClients', {
    gmailClientFromTokens: async (tokens, onRefresh) => {
        assert.ok(tokens && tokens.accessToken, 'gmail client must receive tokens');
        assert.strictEqual(typeof onRefresh, 'function', 'gmail client must receive an onRefresh callback');
        return {
            users: {
                messages: {
                    send: async ({ userId, requestBody }) => {
                        gmailSends.push({ userId, requestBody });
                        return { data: { id: 'gm-sent-1', threadId: requestBody.threadId || 'gm-thread-new' } };
                    },
                },
            },
        };
    },
    graphFetchFromTokens: async (tokens, onRefresh, path, opts = {}) => {
        assert.ok(tokens && tokens.accessToken, 'graph call must receive tokens');
        graphCalls.push({
            path,
            method: opts.method || 'GET',
            body: opts.body ? JSON.parse(opts.body) : null,
        });
        if (path.endsWith('/createReply')) return { id: 'draft-99' };
        return {};
    },
});

stub('../stores/supportInboxStore', {
    getInboxWithTokens: async () => inboxRow,
    updateTokens: async (_id, t) => { refreshedWith.push(t); },
});

const supportMailer = require('./supportMailer');

// ── Helpers ──────────────────────────────────────────────────────────────────
function decodeRaw(encoded) {
    const b64 = String(encoded).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64').toString('utf8');
}

/** Unfold RFC822 continuation lines so a long References header is one string. */
function headersOf(mime) {
    const head = mime.split(/\r?\n\r?\n/)[0];
    return head.replace(/\r?\n[ \t]+/g, ' ');
}

/**
 * The HTML part is quoted-printable: soft line breaks (`=\r\n`) and `=3D` for
 * `=`. Decode so assertions can read the markup the customer actually sees.
 */
function decodeQp(mime) {
    return String(mime)
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const GMAIL_INBOX = {
    id: 'ib-1',
    provider: 'gmail',
    email_address: 'support@acme.nl',
    display_name: 'Acme Support',
    signature: '<p>Groet, Acme</p>',
    tokens: { accessToken: 'at', refreshToken: 'rt' },
};

const OUTLOOK_INBOX = {
    id: 'ib-2',
    provider: 'outlook',
    email_address: 'support@acme.nl',
    display_name: 'Acme Support',
    signature: '',
    tokens: { accessToken: 'at', refreshToken: 'rt' },
};

const THREAD = {
    id: 'th-7',
    requester_email: 'klant@example.com',
    subject: 'Bestelling 123',
    provider_thread_id: 'gm-thread-7',
};

test.beforeEach(() => {
    gmailSends = [];
    graphCalls = [];
    refreshedWith = [];
});

// ── Gmail ────────────────────────────────────────────────────────────────────

test('gmail: sends as "me" with the thread id and the full header set', async () => {
    inboxRow = GMAIL_INBOX;
    const res = await supportMailer.sendReply('ib-1', THREAD, {
        bodyText: 'Hallo,\n\nJe pakket is onderweg.',
        inReplyTo: '<parent@example.com>',
        references: '<root@example.com>',
        sourceProviderMessageId: 'gm-src-1',
    });

    assert.strictEqual(gmailSends.length, 1);
    const { userId, requestBody } = gmailSends[0];
    assert.strictEqual(userId, 'me', 'Gmail can only ever send as the authenticated user');
    assert.strictEqual(requestBody.threadId, 'gm-thread-7', 'threadId keeps the reply in the customer conversation');

    const headers = headersOf(decodeRaw(requestBody.raw));
    assert.match(headers, /^From: Acme Support <support@acme\.nl>$/m);
    assert.match(headers, /^To: klant@example\.com$/m);
    assert.match(headers, /^Subject: Re: Bestelling 123$/m);
    assert.match(headers, /^In-Reply-To: <parent@example\.com>$/m);
    // References = prior chain + the parent Message-ID, in that order.
    assert.match(headers, /^References: <root@example\.com> <parent@example\.com>$/m);
    assert.match(headers, /^Message-ID: <support-th-7-[0-9a-f-]{36}@acme\.nl>$/m);

    assert.strictEqual(res.providerMessageId, 'gm-sent-1');
    assert.strictEqual(res.providerThreadId, 'gm-thread-7');
    assert.match(res.rfc822MessageId, /^<support-th-7-.*@acme\.nl>$/);
    assert.strictEqual(res.status.ok, true);
    assert.strictEqual(res.status.provider, 'gmail');
});

test('gmail: prefixes Re: only once, and derives the Message-ID domain from the inbox', async () => {
    inboxRow = { ...GMAIL_INBOX, email_address: 'help@sub.example.org' };
    await supportMailer.sendReply('ib-1', { ...THREAD, subject: 'RE: al beantwoord' }, { bodyText: 'ok' });

    const headers = headersOf(decodeRaw(gmailSends[0].requestBody.raw));
    assert.match(headers, /^Subject: RE: al beantwoord$/m, 'an existing Re: must not be doubled');
    assert.match(headers, /^Message-ID: <support-th-7-[0-9a-f-]{36}@sub\.example\.org>$/m);
});

test('gmail: renders markdown, appends the signature, and omits the AI footer for staff replies', async () => {
    inboxRow = GMAIL_INBOX;
    await supportMailer.sendReply('ib-1', THREAD, {
        bodyText: '# Titel\n\n- een\n- twee\n\n**vet** en [link](https://example.com)',
    });

    const mime = decodeQp(decodeRaw(gmailSends[0].requestBody.raw));
    assert.match(mime, /<h2>Titel<\/h2>/);
    assert.match(mime, /<li>een<\/li>/);
    assert.match(mime, /<strong>vet<\/strong>/);
    assert.match(mime, /<a href="https:\/\/example\.com">link<\/a>/);
    assert.match(mime, /<p>Groet, Acme<\/p>/, 'the signature is appended as HTML');
    assert.doesNotMatch(mime, /AI-assistent/, 'a human-sent reply carries no AI disclosure');
});

test('gmail: an AI auto-reply carries the AI disclosure in both parts', async () => {
    inboxRow = GMAIL_INBOX;
    await supportMailer.sendReply('ib-1', THREAD, { bodyText: 'Je pakket is onderweg.', isAiReply: true });

    const mime = decodeQp(decodeRaw(gmailSends[0].requestBody.raw));
    assert.match(mime, /automatisch opgesteld door onze AI-assistent/,
        'AI transparency footer is mandatory on automatic replies');
});

test('gmail: strips scripts and inline handlers from an HTML body', async () => {
    inboxRow = GMAIL_INBOX;
    await supportMailer.sendReply('ib-1', THREAD, {
        bodyHtml: '<p onclick="steal()">Hoi</p><script>evil()</script><a href="javascript:x">x</a>',
    });

    const mime = decodeRaw(gmailSends[0].requestBody.raw);
    assert.doesNotMatch(mime, /<script/i);
    assert.doesNotMatch(mime, /onclick/i);
    assert.doesNotMatch(mime, /javascript:/i);
    assert.match(mime, /Hoi/);
});

// ── Outlook ──────────────────────────────────────────────────────────────────

test('outlook: replies through the exact createReply → PATCH → send sequence', async () => {
    inboxRow = OUTLOOK_INBOX;
    const res = await supportMailer.sendReply('ib-2', { ...THREAD, provider_thread_id: 'conv-7' }, {
        bodyText: 'Je pakket is onderweg.',
        sourceProviderMessageId: 'AAMk-src-1',
    });

    assert.strictEqual(graphCalls.length, 3, 'exactly three Graph calls — no more, no fewer');
    assert.deepStrictEqual(
        graphCalls.map((c) => `${c.method} ${c.path}`),
        [
            'POST /me/messages/AAMk-src-1/createReply',
            'PATCH /me/messages/draft-99',
            'POST /me/messages/draft-99/send',
        ],
    );
    assert.strictEqual(graphCalls[1].body.body.contentType, 'HTML');
    assert.match(graphCalls[1].body.body.content, /Je pakket is onderweg\./);

    assert.strictEqual(res.providerMessageId, 'draft-99');
    assert.strictEqual(res.providerThreadId, 'conv-7');
    assert.strictEqual(res.rfc822MessageId, null, 'Graph mints the Message-ID itself');
});

test('outlook: falls back to sendMail when there is no source message to reply to', async () => {
    inboxRow = OUTLOOK_INBOX;
    await supportMailer.sendReply('ib-2', { ...THREAD, provider_thread_id: null }, { bodyText: 'Hoi' });

    assert.strictEqual(graphCalls.length, 1);
    assert.strictEqual(graphCalls[0].method, 'POST');
    assert.strictEqual(graphCalls[0].path, '/me/sendMail');
    assert.strictEqual(graphCalls[0].body.saveToSentItems, true);
    assert.strictEqual(graphCalls[0].body.message.toRecipients[0].emailAddress.address, 'klant@example.com');
    assert.strictEqual(graphCalls[0].body.message.subject, 'Re: Bestelling 123');
});

// ── Failure modes ────────────────────────────────────────────────────────────

test('refuses to send from an inbox that is not connected', async () => {
    inboxRow = { ...GMAIL_INBOX, tokens: null };
    await assert.rejects(
        () => supportMailer.sendReply('ib-1', THREAD, { bodyText: 'x' }),
        /not connected/i,
    );
    assert.strictEqual(gmailSends.length, 0);
});

test('refuses an unknown provider', async () => {
    inboxRow = { ...GMAIL_INBOX, provider: 'imap' };
    await assert.rejects(
        () => supportMailer.sendReply('ib-1', THREAD, { bodyText: 'x' }),
        /Unsupported provider: imap/,
    );
});

test('refuses a missing inbox', async () => {
    inboxRow = null;
    await assert.rejects(() => supportMailer.sendReply('nope', THREAD, { bodyText: 'x' }), /Inbox not found/);
});

// ── Pure helpers (the ones that move to services/email/send.js) ───────────────

test('exported helpers keep their contract', () => {
    assert.strictEqual(supportMailer.sanitizeHtml('<script>x</script><b>ok</b>'), '<b>ok</b>');
    assert.strictEqual(supportMailer.textToHtml('a\nb'), 'a<br>b');
    assert.strictEqual(supportMailer.textToHtml('<a & b>'), '&lt;a &amp; b&gt;');
    assert.strictEqual(supportMailer.htmlToText('<p>een</p><p>twee</p>'), 'een\n\ntwee');
    assert.strictEqual(supportMailer.markdownToHtml('**vet**'), '<p><strong>vet</strong></p>');
    assert.strictEqual(supportMailer.markdownToHtml(''), '');
});
