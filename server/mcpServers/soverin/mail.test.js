const test = require('node:test');
const assert = require('node:assert');

const mail = require('./mail');

test('readConfig defaults to Soverin hosts and implicit TLS', () => {
    const config = mail.readConfig({ SOVERIN_EMAIL: 'tom@example.nl', SOVERIN_PASSWORD: 'pw' });

    assert.strictEqual(config.email, 'tom@example.nl');
    assert.deepStrictEqual(config.imap, { host: 'imap.soverin.net', port: 993, secure: true });
    assert.deepStrictEqual(config.smtp, { host: 'smtp.soverin.net', port: 465, secure: true });
    assert.strictEqual(config.readOnly, false);
    assert.strictEqual(config.maxBodyChars, 8000);
});

test('readConfig switches to STARTTLS on the plaintext ports', () => {
    const config = mail.readConfig({ SOVERIN_IMAP_PORT: '143', SOVERIN_SMTP_PORT: '587' });

    assert.strictEqual(config.imap.secure, false);
    assert.strictEqual(config.smtp.secure, false);
});

test('readConfig never throws on missing credentials (install-time probe)', () => {
    const config = mail.readConfig({});

    assert.strictEqual(config.email, '');
    assert.throws(() => mail.requireCredentials(config), /credentials are not configured/i);
});

test('readConfig reads the operator flags', () => {
    assert.strictEqual(mail.readConfig({ SOVERIN_READ_ONLY: 'true' }).readOnly, true);
    assert.strictEqual(mail.readConfig({ SOVERIN_READ_ONLY: '0' }).readOnly, false);
    assert.strictEqual(mail.readConfig({ SOVERIN_MAX_BODY_CHARS: '250' }).maxBodyChars, 250);
    // Garbage falls back rather than producing NaN caps.
    assert.strictEqual(mail.readConfig({ SOVERIN_MAX_BODY_CHARS: 'lots' }).maxBodyChars, 8000);
});

test('allowedTools drops the mutating tools in read-only mode', () => {
    const tools = [{ name: 'search_messages' }, { name: 'send_message' }, { name: 'move_message' }];

    assert.strictEqual(mail.allowedTools(tools, { readOnly: false }).length, 3);
    assert.deepStrictEqual(
        mail.allowedTools(tools, { readOnly: true }).map((t) => t.name),
        ['search_messages']
    );
});

test('clampLimit keeps limits inside 1..50', () => {
    assert.strictEqual(mail.clampLimit(undefined), 20);
    assert.strictEqual(mail.clampLimit(5), 5);
    assert.strictEqual(mail.clampLimit(500), 50);
    assert.strictEqual(mail.clampLimit(0), 20);
    assert.strictEqual(mail.clampLimit('abc'), 20);
});

test('parseWhen understands relative offsets and ISO dates', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');

    assert.strictEqual(mail.parseWhen('7d', now).toISOString(), '2026-07-21T12:00:00.000Z');
    assert.strictEqual(mail.parseWhen('24h', now).toISOString(), '2026-07-27T12:00:00.000Z');
    assert.strictEqual(mail.parseWhen('30m', now).toISOString(), '2026-07-28T11:30:00.000Z');
    assert.strictEqual(mail.parseWhen('2026-01-15', now).toISOString(), '2026-01-15T00:00:00.000Z');
    assert.strictEqual(mail.parseWhen('', now), null);
    assert.strictEqual(mail.parseWhen('whenever', now), null);
});

test('buildSearchQuery maps tool input onto IMAP search keys', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const query = mail.buildSearchQuery(
        { from: ' billing@acme.nl ', subject: 'invoice', unread: true, flagged: true, since: '2d' },
        now
    );

    assert.strictEqual(query.from, 'billing@acme.nl');
    assert.strictEqual(query.subject, 'invoice');
    // `unread` is the user-facing name — IMAP searches the \Seen flag.
    assert.strictEqual(query.seen, false);
    assert.strictEqual(query.flagged, true);
    assert.strictEqual(query.since.toISOString(), '2026-07-26T12:00:00.000Z');
    assert.strictEqual(query.all, undefined);
});

test('buildSearchQuery searches everything when no filter is given', () => {
    assert.deepStrictEqual(mail.buildSearchQuery({}), { all: true });
    // Blank strings are not filters either.
    assert.deepStrictEqual(mail.buildSearchQuery({ from: '   ', subject: '' }), { all: true });
});

test('buildSearchQuery treats unread:false as "read only"', () => {
    assert.strictEqual(mail.buildSearchQuery({ unread: false }).seen, true);
});

test('formatAddressList renders names and caps long lists', () => {
    assert.strictEqual(
        mail.formatAddressList([{ name: 'Tom Smit', address: 'tom@beeflow.nl' }, { address: 'a@b.nl' }]),
        'Tom Smit <tom@beeflow.nl>, a@b.nl'
    );
    assert.strictEqual(mail.formatAddressList(undefined), '');

    const many = Array.from({ length: 12 }, (_, i) => ({ address: `u${i}@b.nl` }));
    assert.ok(mail.formatAddressList(many).endsWith('(+2 more)'));
});

test('hasAttachments walks nested body structures', () => {
    const withAttachment = {
        type: 'multipart/mixed',
        childNodes: [
            { type: 'multipart/alternative', childNodes: [{ type: 'text/plain' }, { type: 'text/html' }] },
            { type: 'application/pdf', disposition: 'attachment' },
        ],
    };
    const inlineOnly = {
        type: 'multipart/related',
        childNodes: [{ type: 'text/html' }, { type: 'image/png', disposition: 'inline' }],
    };

    assert.strictEqual(mail.hasAttachments(withAttachment), true);
    assert.strictEqual(mail.hasAttachments(inlineOnly), false);
    assert.strictEqual(mail.hasAttachments(null), false);
});

test('summarizeMessage produces a compact summary from a fetch result', () => {
    const summary = mail.summarizeMessage(
        {
            uid: 42,
            size: 2048,
            flags: new Set(['\\Seen', '\\Flagged']),
            envelope: {
                date: new Date('2026-07-20T08:30:00.000Z'),
                subject: 'Factuur juli',
                from: [{ name: 'Acme', address: 'billing@acme.nl' }],
                to: [{ address: 'tom@example.nl' }],
            },
            bodyStructure: { type: 'application/pdf', disposition: 'attachment' },
        },
        'INBOX'
    );

    assert.deepStrictEqual(summary, {
        uid: 42,
        mailbox: 'INBOX',
        date: '2026-07-20T08:30:00.000Z',
        from: 'Acme <billing@acme.nl>',
        to: 'tom@example.nl',
        subject: 'Factuur juli',
        unread: false,
        flagged: true,
        hasAttachments: true,
        size: 2048,
    });
});

test('summarizeMessage marks messages without \\Seen as unread', () => {
    const summary = mail.summarizeMessage({ uid: 1, flags: new Set(), envelope: {} }, 'INBOX');

    assert.strictEqual(summary.unread, true);
    assert.strictEqual(summary.subject, '(no subject)');
    assert.strictEqual(summary.size, null);
});

test('extractBody prefers text/plain and truncates long bodies', () => {
    assert.deepStrictEqual(mail.extractBody({ text: '  Hallo Tom  ' }, 100), {
        body: 'Hallo Tom',
        truncated: false,
    });

    const long = mail.extractBody({ text: 'x'.repeat(50) }, 10);
    assert.strictEqual(long.truncated, true);
    assert.ok(long.body.startsWith('x'.repeat(10)));
    assert.match(long.body, /40 more characters/);
});

test('extractBody falls back to stripped HTML when there is no text part', () => {
    const { body } = mail.extractBody(
        { html: '<style>p{}</style><p>Hallo</p><p>Tom &amp; co</p>' },
        1000
    );

    assert.strictEqual(body, 'Hallo\nTom & co');
});

test('summarizeAttachments exposes metadata only, never bytes', () => {
    const summary = mail.summarizeAttachments([
        { filename: 'factuur.pdf', contentType: 'application/pdf', size: 1234, content: Buffer.from('secret') },
        {},
    ]);

    assert.deepStrictEqual(summary, [
        { filename: 'factuur.pdf', contentType: 'application/pdf', size: 1234 },
        { filename: '(unnamed)', contentType: 'application/octet-stream', size: null },
    ]);
    assert.ok(!JSON.stringify(summary).includes('secret'));
});

test('buildReplyHeaders threads the reply and does not double the Re: prefix', () => {
    const headers = mail.buildReplyHeaders({
        subject: 'Offerte',
        messageId: '<abc@soverin.net>',
        inReplyTo: '<root@soverin.net>',
    });

    assert.strictEqual(headers.subject, 'Re: Offerte');
    assert.strictEqual(headers.inReplyTo, '<abc@soverin.net>');
    assert.deepStrictEqual(headers.references, ['<root@soverin.net>', '<abc@soverin.net>']);

    assert.strictEqual(mail.buildReplyHeaders({ subject: 'RE: Offerte' }).subject, 'RE: Offerte');
    assert.strictEqual(mail.buildReplyHeaders({}).subject, 'Re: (no subject)');
});

test('pickMailbox prefers SPECIAL-USE and falls back to (Dutch) folder names', () => {
    const withSpecialUse = [
        { path: 'INBOX', name: 'INBOX' },
        { path: 'Verzonden', name: 'Verzonden', specialUse: '\\Sent' },
    ];
    assert.strictEqual(mail.pickMailbox(withSpecialUse, 'sent'), 'Verzonden');

    const nameOnly = [
        { path: 'INBOX', name: 'INBOX' },
        { path: 'INBOX/Prullenbak', name: 'Prullenbak' },
    ];
    assert.strictEqual(mail.pickMailbox(nameOnly, 'trash'), 'INBOX/Prullenbak');

    assert.strictEqual(mail.pickMailbox(nameOnly, 'sent'), null);
    assert.strictEqual(mail.pickMailbox([], 'nonsense'), null);
});

test('normalizeRecipients accepts both address forms and rejects junk', () => {
    assert.deepStrictEqual(mail.normalizeRecipients('a@b.nl, Tom <tom@beeflow.nl>'), [
        'a@b.nl',
        'Tom <tom@beeflow.nl>',
    ]);
    assert.deepStrictEqual(mail.normalizeRecipients(['a@b.nl']), ['a@b.nl']);
    assert.deepStrictEqual(mail.normalizeRecipients(undefined), []);
    assert.throws(() => mail.normalizeRecipients('not-an-address', 'to'), /Invalid e-mail address in "to"/);
    assert.throws(() => mail.normalizeRecipients(['ok@b.nl', 'bad@'], 'cc'), /Invalid e-mail address in "cc"/);
});
