/**
 * Shared inbound e-mail layer.
 *
 * Run: cd server && node --test services/email/fetch.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let gmailListCalls = [];
let gmailGetCalls = [];
let graphPaths = [];
let gmailListResult = { data: { messages: [] } };
let gmailGetResult = {};
let graphResult = { value: [] };
let graphError = null;

stub('./providerClients', {
    gmailClientFromTokens: async () => ({
        users: {
            getProfile: async () => ({ data: { emailAddress: 'IK@Acme.nl' } }),
            settings: { sendAs: { list: async () => ({ data: { sendAs: [
                { sendAsEmail: 'ik@acme.nl', isPrimary: true },
                { sendAsEmail: 'support@acme.nl', verificationStatus: 'accepted' },
                { sendAsEmail: 'nieuw@acme.nl', verificationStatus: 'pending' },
            ] } }) } },
            messages: {
                list: async (p) => { gmailListCalls.push(p); return gmailListResult; },
                get: async (p) => { gmailGetCalls.push(p); return gmailGetResult; },
            },
        },
    }),
    graphFetchFromTokens: async (_t, _r, path) => {
        graphPaths.push(path);
        if (graphError) throw graphError;
        return graphResult;
    },
});

const fetchLayer = require('./fetch');

const TOKENS = { accessToken: 'at', refreshToken: 'rt' };
const PERSONAL = { address: 'ik@acme.nl', mode: 'personal' };
const SHARED = { address: 'support@acme.nl', mode: 'shared' };

test.beforeEach(() => {
    gmailListCalls = []; gmailGetCalls = []; graphPaths = [];
    gmailListResult = { data: { messages: [] } };
    graphResult = { value: [] };
    graphError = null;
});

// ── Query building ───────────────────────────────────────────────────────────

test('gmail query: epoch seconds, with the overlap subtracted', () => {
    // Day-granular `after:YYYY/MM/DD` would re-list the whole day every tick.
    const since = '2026-08-05T12:00:00.000Z';
    const q = fetchLayer._buildGmailQuery({ mailbox: PERSONAL, query: '', since });
    const expected = Math.floor((Date.parse(since) - fetchLayer.MAILBOX_OVERLAP_MS) / 1000);
    assert.strictEqual(q, `after:${expected}`);
});

test('gmail query: a shared alias is found with deliveredto:, excluding our own sent mail', () => {
    const q = fetchLayer._buildGmailQuery({ mailbox: SHARED, query: 'from:klant.nl', since: null });
    assert.strictEqual(q, 'deliveredto:support@acme.nl -in:sent from:klant.nl');
});

test('gmail query: empty when nothing is constrained', () => {
    assert.strictEqual(fetchLayer._buildGmailQuery({ mailbox: PERSONAL, query: '', since: null }), '');
});

// ── Gmail listing ────────────────────────────────────────────────────────────

test('gmail personal reads the INBOX label; shared reads the whole mailbox by query', async () => {
    await fetchLayer.listMessages({ provider: 'gmail', tokens: TOKENS, mailbox: PERSONAL, folder: 'inbox' });
    assert.deepStrictEqual(gmailListCalls[0].labelIds, ['INBOX']);
    assert.strictEqual(gmailListCalls[0].userId, 'me');

    gmailListCalls = [];
    await fetchLayer.listMessages({ provider: 'gmail', tokens: TOKENS, mailbox: SHARED, folder: 'inbox' });
    assert.strictEqual(gmailListCalls[0].labelIds, undefined,
        'a delivered alias is not confined to INBOX');
    assert.match(gmailListCalls[0].q, /deliveredto:support@acme\.nl/);
});

test('gmail personal with an explicit query drops the folder pin', async () => {
    // A query-scoped connector (label:intake) is its own boundary. ANDing the
    // INBOX label onto it made the standard Gmail-filter setup — apply label +
    // "Skip the Inbox" — sync exactly nothing.
    await fetchLayer.listMessages({ provider: 'gmail', tokens: TOKENS, mailbox: PERSONAL, folder: 'inbox', query: 'label:intake' });
    assert.strictEqual(gmailListCalls[0].labelIds, undefined,
        'the label query scopes the mailbox; INBOX must not be ANDed on top');
    assert.match(gmailListCalls[0].q, /label:intake/);
});

// ── Normalisation ────────────────────────────────────────────────────────────

const GMAIL_MSG = {
    id: 'gm-1',
    threadId: 'gm-th-1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Hoi, waar blijft mijn pakket',
    internalDate: '1785931200000',
    sizeEstimate: 4096,
    payload: {
        mimeType: 'multipart/mixed',
        headers: [
            { name: 'From', value: 'Jan Klant <jan@example.com>' },
            { name: 'To', value: 'support@acme.nl' },
            { name: 'Cc', value: 'chef@acme.nl' },
            { name: 'Subject', value: 'Re: Bestelling 123' },
            { name: 'Message-ID', value: '<m1@example.com>' },
            { name: 'In-Reply-To', value: '<parent@example.com>' },
            { name: 'References', value: '<root@example.com> <parent@example.com>' },
        ],
        parts: [
            { mimeType: 'text/plain', body: { data: Buffer.from('Waar blijft mijn pakket?').toString('base64url') } },
            { mimeType: 'text/html', body: { data: Buffer.from('<p>Waar blijft mijn pakket?</p>').toString('base64url') } },
            { filename: 'bon.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-1', size: 1234 } },
        ],
    },
};

test('gmail normalisation produces the canonical shape', () => {
    const out = fetchLayer._normalizeGmail(GMAIL_MSG, { mailbox: SHARED, includeBody: true });

    assert.strictEqual(out.provider, 'gmail');
    assert.strictEqual(out.provider_message_id, 'gm-1');
    assert.strictEqual(out.provider_thread_id, 'gm-th-1');
    assert.strictEqual(out.rfc822_message_id, '<m1@example.com>');
    assert.strictEqual(out.in_reply_to, '<parent@example.com>');
    assert.strictEqual(out.from_email, 'jan@example.com');
    assert.strictEqual(out.from_name, 'Jan Klant');
    assert.strictEqual(out.cc_emails, 'chef@acme.nl');
    assert.strictEqual(out.subject_normalized, 'bestelling 123');
    assert.strictEqual(out.body_text, 'Waar blijft mijn pakket?');
    assert.strictEqual(out.body_html, '<p>Waar blijft mijn pakket?</p>');
    assert.strictEqual(out.direction, 'inbound');
    assert.strictEqual(out.is_read, false);
    assert.strictEqual(out.has_attachments, true);
    assert.strictEqual(out.received_at, new Date(1785931200000).toISOString());
    assert.strictEqual(out.thread_key, 'gmail:gm-th-1');
});

test('gmail normalisation can omit bodies', () => {
    const out = fetchLayer._normalizeGmail(GMAIL_MSG, { mailbox: SHARED, includeBody: false });
    assert.strictEqual(out.body_text, '');
    assert.strictEqual(out.body_html, '');
    assert.strictEqual(out.snippet, 'Hoi, waar blijft mijn pakket', 'the snippet survives regardless');
});

test('auto-replies are FLAGGED, never silently dropped', () => {
    // The reader marks; whether to ingest is the caller's policy decision.
    const msg = JSON.parse(JSON.stringify(GMAIL_MSG));
    msg.payload.headers.push({ name: 'Auto-Submitted', value: 'auto-replied' });
    const out = fetchLayer._normalizeGmail(msg, { mailbox: SHARED, includeBody: true });
    assert.strictEqual(out.is_auto_or_bulk, true);
    assert.strictEqual(out.provider_message_id, 'gm-1');
});

test('gmail attachments are read out of the payload tree', () => {
    const atts = fetchLayer._gmailAttachments(GMAIL_MSG.payload);
    assert.strictEqual(atts.length, 1);
    assert.deepStrictEqual(atts[0], {
        provider_attachment_id: 'att-1',
        filename: 'bon.pdf',
        mime_type: 'application/pdf',
        size: 1234,
        is_inline: false,
    });
});

const GRAPH_MSG = {
    id: 'AAMk-1',
    conversationId: 'conv-1',
    internetMessageId: '<m2@example.com>',
    subject: 'RE: Bestelling 456',
    from: { emailAddress: { address: 'Jan@Example.com', name: 'Jan Klant' } },
    toRecipients: [{ emailAddress: { address: 'support@acme.nl' } }],
    ccRecipients: [],
    receivedDateTime: '2026-08-05T10:00:00Z',
    bodyPreview: 'Waar blijft mijn pakket',
    body: { contentType: 'html', content: '<p>Waar blijft mijn pakket?</p>' },
    hasAttachments: false,
    isRead: true,
    categories: ['Klant'],
};

test('graph normalisation produces the same canonical shape', () => {
    const out = fetchLayer._normalizeGraph(GRAPH_MSG, { mailbox: SHARED, includeBody: true });

    assert.strictEqual(out.provider, 'outlook');
    assert.strictEqual(out.provider_thread_id, 'conv-1');
    assert.strictEqual(out.from_email, 'jan@example.com', 'addresses are lowercased');
    assert.strictEqual(out.subject_normalized, 'bestelling 456');
    assert.strictEqual(out.body_html, '<p>Waar blijft mijn pakket?</p>');
    assert.strictEqual(out.body_text, '');
    assert.strictEqual(out.is_read, true);
    assert.strictEqual(out.labels, 'Klant');
    assert.strictEqual(out.thread_key, 'outlook:conv-1');
});

test('graph: mail sent FROM the mailbox is outbound', () => {
    const msg = { ...GRAPH_MSG, from: { emailAddress: { address: 'support@acme.nl' } } };
    assert.strictEqual(fetchLayer._normalizeGraph(msg, { mailbox: SHARED, includeBody: true }).direction, 'outbound');
});

// ── Thread key tiers ─────────────────────────────────────────────────────────

test('thread key tier 2: the ROOT of the References chain, not the parent', () => {
    // Siblings must land on the same key; keying on the parent would split them.
    const key = fetchLayer.computeThreadKey({
        provider: 'gmail', provider_thread_id: '',
        references: '<root@x> <mid@x> <parent@x>', in_reply_to: '<parent@x>',
    });
    assert.strictEqual(key, 'rfc:<root@x>');
});

test('thread key tier 2 falls back to In-Reply-To when there is no chain', () => {
    assert.strictEqual(
        fetchLayer.computeThreadKey({ provider: 'gmail', provider_thread_id: '', references: '', in_reply_to: '<p@x>' }),
        'rfc:<p@x>',
    );
});

test('thread key tier 3: stable subject+counterparty hash', () => {
    const base = {
        provider: 'gmail', provider_thread_id: '', references: '', in_reply_to: '',
        mailbox_address: 'support@acme.nl', subject_normalized: 'bestelling 123',
        from_email: 'jan@example.com', direction: 'inbound',
    };
    const a = fetchLayer.computeThreadKey(base);
    const b = fetchLayer.computeThreadKey({ ...base });
    assert.strictEqual(a, b, 'must be deterministic across runs');
    assert.match(a, /^subj:[0-9a-f]{32}$/);

    const other = fetchLayer.computeThreadKey({ ...base, subject_normalized: 'iets anders' });
    assert.notStrictEqual(a, other);
});

// ── Graph paths ──────────────────────────────────────────────────────────────

test('graph list: personal uses /me, shared uses /users/{address}', async () => {
    await fetchLayer.listMessages({ provider: 'outlook', tokens: TOKENS, mailbox: PERSONAL, folder: 'inbox' });
    assert.match(graphPaths[0], /^\/me\/mailFolders\/inbox\/messages\?/);

    graphPaths = [];
    await fetchLayer.listMessages({ provider: 'outlook', tokens: TOKENS, mailbox: SHARED, folder: 'inbox' });
    assert.match(graphPaths[0], /^\/users\/support%40acme\.nl\/mailFolders\/inbox\/messages\?/);
});

test('graph list: a watermark becomes a receivedDateTime filter with the overlap', async () => {
    const since = '2026-08-05T12:00:00.000Z';
    await fetchLayer.listMessages({ provider: 'outlook', tokens: TOKENS, mailbox: PERSONAL, since });

    const expected = new Date(Date.parse(since) - fetchLayer.MAILBOX_OVERLAP_MS).toISOString();
    assert.ok(decodeURIComponent(graphPaths[0]).includes(`receivedDateTime ge ${expected}`));
    // Spaces must be %20, never '+' — OData reads '+' literally and the filter
    // silently stops matching.
    assert.ok(!graphPaths[0].includes('+'), 'no + encoding in an OData query string');
});

test('graph list: a query switches to $search and drops $filter', async () => {
    // Graph forbids combining them — this is a real capability trade-off, not
    // an oversight, so it is pinned by a test.
    await fetchLayer.listMessages({
        provider: 'outlook', tokens: TOKENS, mailbox: PERSONAL,
        query: 'factuur', since: '2026-08-05T12:00:00.000Z',
    });
    const path = decodeURIComponent(graphPaths[0]);
    assert.ok(path.includes('$search="factuur"'));
    assert.ok(!path.includes('$filter'));
});

test('graph list follows @odata.nextLink verbatim', async () => {
    graphResult = { value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc' };
    const first = await fetchLayer.listMessages({ provider: 'outlook', tokens: TOKENS, mailbox: PERSONAL });
    assert.strictEqual(first.nextPageToken, graphResult['@odata.nextLink']);

    graphPaths = [];
    await fetchLayer.listMessages({ provider: 'outlook', tokens: TOKENS, mailbox: PERSONAL, pageToken: first.nextPageToken });
    assert.strictEqual(graphPaths[0], first.nextPageToken);
});

test('graph getMessage only asks for threading headers when told to', async () => {
    graphResult = GRAPH_MSG;
    await fetchLayer.getMessage({ provider: 'outlook', tokens: TOKENS, mailbox: PERSONAL, id: 'AAMk-1' });
    assert.ok(!graphPaths[0].includes('internetMessageHeaders'));

    graphPaths = [];
    await fetchLayer.getMessage({ provider: 'outlook', tokens: TOKENS, mailbox: PERSONAL, id: 'AAMk-1', includeHeaders: true });
    assert.ok(graphPaths[0].includes('internetMessageHeaders'));
});

// ── Shared-access probe ──────────────────────────────────────────────────────

test('probe: outlook 403 reports a denied shared mailbox', async () => {
    const err = new Error('Graph API 403: denied');
    err.status = 403;
    graphError = err;
    const res = await fetchLayer.probeSharedAccess({
        provider: 'outlook', tokens: TOKENS, address: 'support@acme.nl',
    });
    assert.deepStrictEqual(res, { ok: false, reason: 'shared_mailbox_denied' });
});

test('probe: outlook success', async () => {
    graphResult = { id: 'folder-1' };
    const res = await fetchLayer.probeSharedAccess({ provider: 'outlook', tokens: TOKENS, address: 'support@acme.nl' });
    assert.strictEqual(res.ok, true);
});

test('probe: gmail checks for a VERIFIED send-as alias', async () => {
    assert.strictEqual(
        (await fetchLayer.probeSharedAccess({ provider: 'gmail', tokens: TOKENS, address: 'support@acme.nl' })).ok,
        true,
    );
    assert.deepStrictEqual(
        await fetchLayer.probeSharedAccess({ provider: 'gmail', tokens: TOKENS, address: 'nieuw@acme.nl' }),
        { ok: false, reason: 'alias_not_verified' },
    );
    assert.deepStrictEqual(
        await fetchLayer.probeSharedAccess({ provider: 'gmail', tokens: TOKENS, address: 'vreemd@acme.nl' }),
        { ok: false, reason: 'alias_not_found' },
    );
});

test('probe: no address is never OK', async () => {
    assert.deepStrictEqual(
        await fetchLayer.probeSharedAccess({ provider: 'outlook', tokens: TOKENS, address: '' }),
        { ok: false, reason: 'no_address' },
    );
});

test('resolveMailboxAddress lowercases both providers', async () => {
    assert.strictEqual(await fetchLayer.resolveMailboxAddress({ provider: 'gmail', tokens: TOKENS }), 'ik@acme.nl');
    graphResult = { mail: 'IK@Acme.nl' };
    assert.strictEqual(await fetchLayer.resolveMailboxAddress({ provider: 'outlook', tokens: TOKENS }), 'ik@acme.nl');
});

test('an unknown provider is rejected everywhere', async () => {
    await assert.rejects(() => fetchLayer.listMessages({ provider: 'imap', tokens: TOKENS }), /Unknown provider/);
    await assert.rejects(() => fetchLayer.getMessage({ provider: 'imap', tokens: TOKENS, id: 'x' }), /Unknown provider/);
    await assert.rejects(() => fetchLayer.listAttachmentMeta({ provider: 'imap', tokens: TOKENS, messageId: 'x' }), /Unknown provider/);
});

// ── direction: SENT is not the same as "we sent it" ──────────────────
//
// Gmail labels a message SENT whenever this account was the sender — including
// when the account mails ITSELF, which is how every intake teststand works and
// how a shared box that CCs itself works. Those carry SENT *and* INBOX, and
// they are messages the desk received. Reading SENT alone painted the
// customer's own mail as ours in the conversation view.

function gmailWith({ labels, to, cc }) {
    const msg = JSON.parse(JSON.stringify(GMAIL_MSG));
    msg.labelIds = labels;
    msg.payload.headers = msg.payload.headers.map((hdr) => {
        if (hdr.name === 'To' && to !== undefined) return { name: 'To', value: to };
        if (hdr.name === 'Cc' && cc !== undefined) return { name: 'Cc', value: cc };
        return hdr;
    });
    return msg;
}

test('mail addressed to the mailbox itself is INBOUND even with the SENT label', () => {
    const msg = gmailWith({ labels: ['SENT', 'INBOX'], to: 'support@acme.nl' });
    assert.strictEqual(fetchLayer._normalizeGmail(msg, { mailbox: SHARED, includeBody: false }).direction, 'inbound');
});

test('the mailbox on Cc counts too, and the match ignores case and display names', () => {
    const msg = gmailWith({ labels: ['SENT'], to: 'iemand@elders.nl', cc: 'Support Desk <SUPPORT@ACME.NL>' });
    assert.strictEqual(fetchLayer._normalizeGmail(msg, { mailbox: SHARED, includeBody: false }).direction, 'inbound');
});

test('a real reply we sent stays OUTBOUND', () => {
    const msg = gmailWith({ labels: ['SENT'], to: 'jan@example.com', cc: '' });
    assert.strictEqual(fetchLayer._normalizeGmail(msg, { mailbox: SHARED, includeBody: false }).direction, 'outbound');
});

test('a Bcc-to-self stays outbound — the mailbox is not on To or Cc', () => {
    // The archival copy of a reply is still a reply. Bcc never appears in the
    // received headers, so there is nothing to mistake it for.
    const msg = gmailWith({ labels: ['SENT'], to: 'jan@example.com', cc: '' });
    assert.strictEqual(fetchLayer._normalizeGmail(msg, { mailbox: SHARED, includeBody: false }).direction, 'outbound');
});

test('without a mailbox address the old rule stands', () => {
    // A personal Gmail box has no configured address to compare against;
    // guessing would be worse than the label.
    const msg = gmailWith({ labels: ['SENT'], to: 'support@acme.nl' });
    const personal = { address: '', mode: 'personal' };
    assert.strictEqual(fetchLayer._normalizeGmail(msg, { mailbox: personal, includeBody: false }).direction, 'outbound');
});

test('no SENT label is still inbound, whoever it is addressed to', () => {
    const msg = gmailWith({ labels: ['INBOX', 'UNREAD'], to: 'support@acme.nl' });
    assert.strictEqual(fetchLayer._normalizeGmail(msg, { mailbox: SHARED, includeBody: false }).direction, 'inbound');
});
