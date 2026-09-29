/**
 * Inbound e-mail — the shared read layer.
 *
 * Lists and normalises messages from Gmail or Microsoft Graph into ONE shape,
 * so a caller never has to know which provider it is talking to. Store-agnostic
 * like its sibling send.js: pass a token blob + `onRefresh`.
 *
 * Mailbox modes:
 *   • personal — Gmail `userId:'me'` / Graph `/me/...`
 *   • shared   — Graph `/users/{address}/...` (a real Exchange shared mailbox,
 *                needs Mail.Read.Shared). Gmail has NO equivalent: the Gmail API
 *                refuses any userId but the authenticated one, so a "shared"
 *                Gmail mailbox is really mail DELIVERED to a team alias inside
 *                the user's own mailbox, found with `deliveredto:`.
 *
 * The normalised shape is deliberately snake_case: it maps 1:1 onto the columns
 * of the table these rows get synced into.
 */

const {
    getGmailHeader,
    extractGmailBodies,
    splitMessageIds,
    normalizeSubject,
    detectAutoOrBulk,
    parseAddress,
    parseDisplayName,
} = require('./parse');
const { gmailClientFromTokens, graphFetchFromTokens } = require('./providerClients');
const crypto = require('crypto');

/**
 * Re-fetch a little before the watermark. Both providers index asynchronously,
 * so a message can become visible with a receivedDateTime slightly older than
 * the last run's cutoff. Upserts make the overlap free; without it those
 * messages are lost permanently.
 */
const MAILBOX_OVERLAP_MS = 2 * 60 * 1000;

const MAX_BODY_CHARS = 100_000;
const SNIPPET_CHARS = 500;

const GRAPH_SELECT = [
    'id', 'conversationId', 'internetMessageId', 'subject', 'from', 'toRecipients',
    'ccRecipients', 'receivedDateTime', 'bodyPreview', 'hasAttachments', 'isRead', 'categories',
].join(',');

// ── Threading ────────────────────────────────────────────────────────────────

/**
 * A stable key grouping messages into one conversation.
 *
 * Computed, not looked up: these rows are written straight into a per-app table
 * by the sync engine, which has no read-modify-write hook to resolve a thread
 * the way the support inbox does with a query. Three tiers, best first:
 *   1. the provider's own thread id — reliable, covers virtually all real mail
 *   2. the ROOT of the References chain (not the parent — siblings must agree)
 *   3. a subject+counterparty hash, which can occasionally merge or split
 */
function computeThreadKey(msg) {
    if (msg.provider_thread_id) return `${msg.provider}:${msg.provider_thread_id}`;
    const chain = splitMessageIds(msg.references);
    const root = chain[0] || msg.in_reply_to;
    if (root) return `rfc:${root}`;
    const counterparty = msg.direction === 'outbound'
        ? String(msg.to_emails || '').split(',')[0].trim()
        : msg.from_email;
    const seed = `${msg.mailbox_address || ''}|${msg.subject_normalized || ''}|${counterparty || ''}`;
    return `subj:${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 32)}`;
}

function clamp(value, max) {
    const s = value == null ? '' : String(value);
    return s.length > max ? s.slice(0, max) : s;
}

// ── Gmail ────────────────────────────────────────────────────────────────────

/**
 * Gmail search string for one run.
 *
 * `after:` takes epoch SECONDS. The documented `after:YYYY/MM/DD` form is
 * day-granular, which on a 2-minute sync would re-list the entire day on every
 * tick — fine for correctness, ruinous for quota.
 */
function buildGmailQuery({ mailbox, query, since }) {
    const parts = [];
    if (mailbox.mode === 'shared' && mailbox.address) {
        // Survives group expansion and Bcc, unlike `to:`.
        parts.push(`deliveredto:${mailbox.address}`);
        parts.push('-in:sent');
    }
    if (since) {
        const ts = Math.floor((new Date(since).getTime() - MAILBOX_OVERLAP_MS) / 1000);
        if (Number.isFinite(ts) && ts > 0) parts.push(`after:${ts}`);
    }
    if (query) parts.push(String(query));
    return parts.join(' ').trim();
}

/**
 * Did WE send this, or did it arrive?
 *
 * Gmail labels a message SENT when this account was the sender — including when
 * the account mailed itself, which is how every intake teststand works and how a
 * shared box that CCs itself works too. Those messages carry SENT *and* INBOX,
 * and they are inbound: somebody is asking the desk something.
 *
 * `h` is the caller's own header reader, passed in so the two cannot end up
 * reading different headers. Covered through _normalizeGmail.
 */
function isGmailOutbound(msg, h, mailbox) {
    if (!(msg.labelIds || []).includes('SENT')) return false;
    const address = String(mailbox?.address || '').trim().toLowerCase();
    if (!address) return true; // nothing to compare against — keep the old rule
    const recipients = `${h('To') || ''},${h('Cc') || ''}`.toLowerCase();
    return !recipients.includes(address);
}

function normalizeGmail(msg, { mailbox, includeBody }) {
    const headers = msg.payload?.headers || [];
    const h = (name) => getGmailHeader(headers, name);
    const fromRaw = h('From');
    const fromEmail = parseAddress(fromRaw);
    const bodies = includeBody ? extractGmailBodies(msg.payload) : { text: '', html: '' };
    const subject = h('Subject');
    const auto = detectAutoOrBulk((n) => h(n), { fromAddress: fromEmail, inboxAddress: mailbox.address });

    const out = {
        provider: 'gmail',
        mailbox_address: mailbox.address || '',
        provider_message_id: msg.id,
        provider_thread_id: msg.threadId || '',
        rfc822_message_id: h('Message-ID') || h('Message-Id') || '',
        in_reply_to: h('In-Reply-To') || '',
        references: h('References') || '',
        // SENT alone is not "we sent it": mail addressed to the mailbox ITSELF
        // carries SENT and INBOX together, and that is a message the desk
        // RECEIVED, whoever pressed send. Without this every message in a
        // self-addressed test mailbox lands as outbound, and the conversation
        // paints the customer's own mail as ours. A Bcc-to-self stays outbound —
        // the mailbox is not on To or Cc.
        direction: isGmailOutbound(msg, h, mailbox) ? 'outbound' : 'inbound',
        from_email: fromEmail,
        from_name: parseDisplayName(fromRaw),
        to_emails: h('To'),
        cc_emails: h('Cc'),
        subject,
        subject_normalized: normalizeSubject(subject),
        snippet: clamp(msg.snippet || bodies.text, SNIPPET_CHARS),
        body_text: clamp(bodies.text, MAX_BODY_CHARS),
        body_html: clamp(bodies.html, MAX_BODY_CHARS),
        received_at: msg.internalDate
            ? new Date(Number(msg.internalDate)).toISOString()
            : (h('Date') ? new Date(h('Date')).toISOString() : null),
        is_read: !(msg.labelIds || []).includes('UNREAD'),
        has_attachments: gmailAttachments(msg.payload).length > 0,
        is_auto_or_bulk: auto.skip,
        labels: (msg.labelIds || []).join(','),
        raw_size: Number(msg.sizeEstimate) || 0,
    };
    out.thread_key = computeThreadKey(out);
    return out;
}

/** Walk a Gmail payload tree for parts that are real attachments. */
function gmailAttachments(payload) {
    const out = [];
    const walk = (part) => {
        if (!part) return;
        if (part.filename && part.body?.attachmentId) {
            out.push({
                provider_attachment_id: part.body.attachmentId,
                filename: part.filename,
                mime_type: part.mimeType || 'application/octet-stream',
                size: Number(part.body.size) || 0,
                is_inline: (part.headers || []).some(
                    (x) => x.name?.toLowerCase() === 'content-disposition' && /inline/i.test(x.value || ''),
                ),
            });
        }
        if (Array.isArray(part.parts)) part.parts.forEach(walk);
    };
    walk(payload);
    return out;
}

// ── Graph ────────────────────────────────────────────────────────────────────

function graphBase(mailbox) {
    return mailbox.mode === 'shared' && mailbox.address
        ? `/users/${encodeURIComponent(mailbox.address)}`
        : '/me';
}

function normalizeGraph(msg, { mailbox, includeBody }) {
    const fromEmail = String(msg.from?.emailAddress?.address || '').toLowerCase();
    const recipients = (list) => (list || []).map((r) => r.emailAddress?.address).filter(Boolean).join(', ');
    const subject = msg.subject || '';
    // internetMessageHeaders only come back on a single-message GET, so on a
    // list pass these are empty and threading falls back to conversationId.
    const headerMap = new Map(
        (msg.internetMessageHeaders || []).map((x) => [String(x.name || '').toLowerCase(), x.value]),
    );
    const h = (name) => headerMap.get(name.toLowerCase()) || '';
    const auto = detectAutoOrBulk((n) => h(n), { fromAddress: fromEmail, inboxAddress: mailbox.address });
    const isHtml = (msg.body?.contentType || '').toLowerCase() === 'html';

    const out = {
        provider: 'outlook',
        mailbox_address: mailbox.address || '',
        provider_message_id: msg.id,
        provider_thread_id: msg.conversationId || '',
        rfc822_message_id: msg.internetMessageId || '',
        in_reply_to: h('In-Reply-To'),
        references: h('References'),
        direction: fromEmail && mailbox.address && fromEmail === String(mailbox.address).toLowerCase()
            ? 'outbound' : 'inbound',
        from_email: fromEmail,
        from_name: msg.from?.emailAddress?.name || '',
        to_emails: recipients(msg.toRecipients),
        cc_emails: recipients(msg.ccRecipients),
        subject,
        subject_normalized: normalizeSubject(subject),
        snippet: clamp(msg.bodyPreview, SNIPPET_CHARS),
        body_text: includeBody && !isHtml ? clamp(msg.body?.content, MAX_BODY_CHARS) : '',
        body_html: includeBody && isHtml ? clamp(msg.body?.content, MAX_BODY_CHARS) : '',
        received_at: msg.receivedDateTime || null,
        is_read: Boolean(msg.isRead),
        has_attachments: Boolean(msg.hasAttachments),
        is_auto_or_bulk: auto.skip,
        labels: (msg.categories || []).join(','),
        raw_size: 0,
    };
    out.thread_key = computeThreadKey(out);
    return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List messages received since a watermark.
 *
 * @returns {Promise<{messages: object[], nextPageToken: string|null}>}
 */
async function listMessages({
    provider, tokens, onRefresh, mailbox = {}, folder = 'inbox',
    query = '', since = null, max = 50, includeBody = true, pageToken = null,
}) {
    if (provider === 'gmail') {
        const gmail = await gmailClientFromTokens(tokens, onRefresh);
        const q = buildGmailQuery({ mailbox, query, since });
        const listParams = { userId: 'me', maxResults: Math.min(max, 100) };
        if (q) listParams.q = q;
        if (pageToken) listParams.pageToken = pageToken;
        // A personal mailbox reads its INBOX; a shared alias is found by query
        // across the whole mailbox, so no label restriction there. An explicit
        // query also drops the folder pin: a query-scoped connector (e.g.
        // `label:intake`) is its own boundary, and ANDing INBOX onto it made
        // the standard Gmail-filter setup — apply label + "Skip the Inbox" —
        // sync exactly nothing, while archiving a handled thread hid it too.
        if (mailbox.mode !== 'shared' && folder && !query) listParams.labelIds = [String(folder).toUpperCase()];

        const list = await gmail.users.messages.list(listParams);
        const ids = (list.data.messages || []).map((m) => m.id);
        const messages = [];
        for (const id of ids) {
            const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
            messages.push(normalizeGmail(full.data, { mailbox, includeBody }));
        }
        return { messages, nextPageToken: list.data.nextPageToken || null };
    }

    if (provider === 'outlook') {
        const base = graphBase(mailbox);
        let path;
        if (pageToken) {
            path = pageToken; // Graph hands back an absolute @odata.nextLink
        } else {
            const params = new URLSearchParams();
            params.set('$select', GRAPH_SELECT);
            params.set('$top', String(Math.min(max, 100)));
            if (query) {
                // $search and $filter are mutually exclusive in Graph, and
                // $search cannot be ordered. Filtering by date is the more
                // valuable of the two for a sync, so a query costs us that.
                params.set('$search', `"${String(query).replace(/"/g, '')}"`);
            } else {
                params.set('$orderby', 'receivedDateTime desc');
                if (since) {
                    const from = new Date(new Date(since).getTime() - MAILBOX_OVERLAP_MS).toISOString();
                    params.set('$filter', `receivedDateTime ge ${from}`);
                }
            }
            // URLSearchParams encodes spaces as '+', which OData reads
            // literally — `receivedDateTime+ge+...` is not a valid filter.
            const qs = params.toString().replace(/\+/g, '%20');
            path = `${base}/mailFolders/${encodeURIComponent(folder)}/messages?${qs}`;
        }

        const res = await graphFetchFromTokens(tokens, onRefresh, path);
        const messages = (res.value || []).map((m) => normalizeGraph(m, { mailbox, includeBody }));
        return { messages, nextPageToken: res['@odata.nextLink'] || null };
    }

    throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Fetch one message in full. Pass `includeHeaders` when the RFC822 threading
 * headers are needed — on Graph they are only returned by a single-message GET,
 * and they cost an extra field, so they are opt-in.
 */
async function getMessage({ provider, tokens, onRefresh, mailbox = {}, id, includeBody = true, includeHeaders = false }) {
    if (provider === 'gmail') {
        const gmail = await gmailClientFromTokens(tokens, onRefresh);
        const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        return normalizeGmail(full.data, { mailbox, includeBody });
    }
    if (provider === 'outlook') {
        const select = includeHeaders ? `${GRAPH_SELECT},internetMessageHeaders,body` : `${GRAPH_SELECT},body`;
        const msg = await graphFetchFromTokens(tokens, onRefresh,
            `${graphBase(mailbox)}/messages/${encodeURIComponent(id)}?$select=${select}`);
        return normalizeGraph(msg, { mailbox, includeBody });
    }
    throw new Error(`Unknown provider: ${provider}`);
}

/** Attachment METADATA only — no bytes, so no scanning or quota surface. */
async function listAttachmentMeta({ provider, tokens, onRefresh, mailbox = {}, messageId }) {
    if (provider === 'gmail') {
        const gmail = await gmailClientFromTokens(tokens, onRefresh);
        const full = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
        return gmailAttachments(full.data.payload);
    }
    if (provider === 'outlook') {
        const res = await graphFetchFromTokens(tokens, onRefresh,
            `${graphBase(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`);
        return (res.value || []).map((a) => ({
            provider_attachment_id: a.id,
            filename: a.name || 'bijlage',
            mime_type: a.contentType || 'application/octet-stream',
            size: Number(a.size) || 0,
            is_inline: Boolean(a.isInline),
        }));
    }
    throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Every message in ONE conversation, regardless of labels or the search window.
 *
 * This exists because a mail label is a property of a MESSAGE, not of a thread.
 * `label:support` matches the message somebody labelled; the reply that arrives
 * an hour later carries no label and matches nothing — so a ticket built from
 * that search silently stops updating while the customer keeps writing. That is
 * the worst kind of bug in a support tool: it looks answered.
 */
async function listThreadMessages({ provider, tokens, onRefresh, mailbox = {}, threadId, includeBody = true, max = 100 }) {
    if (provider === 'gmail') {
        const gmail = await gmailClientFromTokens(tokens, onRefresh);
        const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
        return (res.data?.messages || []).slice(0, max).map((m) => normalizeGmail(m, { mailbox, includeBody }));
    }
    if (provider === 'outlook') {
        const select = `${GRAPH_SELECT},internetMessageHeaders,body`;
        const res = await graphFetchFromTokens(tokens, onRefresh,
            `${graphBase(mailbox)}/messages?$filter=conversationId eq '${String(threadId).replace(/'/g, "''")}'`
            + `&$select=${select}&$top=${Math.min(max, 100)}`);
        return (res.value || []).map((m) => normalizeGraph(m, { mailbox, includeBody }));
    }
    throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Fetch ONE attachment's bytes. Deliberately separate from listAttachmentMeta:
 * metadata is free and safe, bytes cost provider quota and carry whatever a
 * stranger mailed you, so every caller has to ask for them explicitly and is
 * expected to scan + account for what it gets back.
 *
 * `maxBytes` is enforced against the DECLARED size before the request and again
 * against what actually arrived — a provider is free to disagree with itself,
 * and only the second check is load-bearing.
 *
 * @returns {Promise<{ buffer: Buffer, mimeType: string, filename: string }>}
 */
async function getAttachmentBytes({ provider, tokens, onRefresh, mailbox = {}, messageId, attachmentId, maxBytes = 10 * 1024 * 1024 }) {
    const tooBig = (n) => {
        const e = new Error(`Attachment is larger than the ${Math.round(maxBytes / 1024 / 1024)}MB limit`);
        e.status = 413;
        e.actualBytes = n;
        return e;
    };

    if (provider === 'gmail') {
        const gmail = await gmailClientFromTokens(tokens, onRefresh);
        const res = await gmail.users.messages.attachments.get({
            userId: 'me', messageId, id: attachmentId,
        });
        const declared = Number(res.data?.size) || 0;
        if (declared > maxBytes) throw tooBig(declared);
        // Gmail returns URL-SAFE base64. Feeding that to Buffer.from(.., 'base64')
        // without the swap yields a buffer that is subtly wrong — a PDF that
        // opens as garbage rather than failing loudly.
        const data = String(res.data?.data || '').replace(/-/g, '+').replace(/_/g, '/');
        const buffer = Buffer.from(data, 'base64');
        if (buffer.length > maxBytes) throw tooBig(buffer.length);
        return { buffer, mimeType: null, filename: null };
    }

    if (provider === 'outlook') {
        // graphBase, not a hardcoded /me: a delegated shared mailbox is exactly
        // the case where attachments matter, and /me would silently read the
        // agent's own mailbox instead.
        const att = await graphFetchFromTokens(tokens, onRefresh,
            `${graphBase(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
            + '?$select=id,name,contentType,size,contentBytes');
        // Item and reference attachments (a forwarded mail, a OneDrive link)
        // carry no contentBytes at all — refusing them by type beats handing a
        // caller an empty buffer.
        if (att['@odata.type'] && att['@odata.type'] !== '#microsoft.graph.fileAttachment') {
            const e = new Error('That attachment is a link or an embedded item, not a file');
            e.status = 415;
            throw e;
        }
        const declared = Number(att.size) || 0;
        if (declared > maxBytes) throw tooBig(declared);
        const buffer = Buffer.from(String(att.contentBytes || ''), 'base64');
        if (buffer.length > maxBytes) throw tooBig(buffer.length);
        return { buffer, mimeType: att.contentType || null, filename: att.name || null };
    }

    throw new Error(`Unknown provider: ${provider}`);
}

/** The address the token itself belongs to — the "personal" mailbox. */
async function resolveMailboxAddress({ provider, tokens, onRefresh }) {
    if (provider === 'gmail') {
        const gmail = await gmailClientFromTokens(tokens, onRefresh);
        const profile = await gmail.users.getProfile({ userId: 'me' });
        return String(profile.data.emailAddress || '').toLowerCase();
    }
    if (provider === 'outlook') {
        const me = await graphFetchFromTokens(tokens, onRefresh, '/me?$select=mail,userPrincipalName');
        return String(me.mail || me.userPrincipalName || '').toLowerCase();
    }
    throw new Error(`Unknown provider: ${provider}`);
}

/**
 * Can this token actually reach `address` as a shared mailbox? Called when a
 * connector is saved so a misconfiguration fails loudly at configure time
 * instead of silently producing an empty sync forever.
 */
async function probeSharedAccess({ provider, tokens, onRefresh, address }) {
    if (!address) return { ok: false, reason: 'no_address' };

    if (provider === 'outlook') {
        try {
            await graphFetchFromTokens(tokens, onRefresh,
                `/users/${encodeURIComponent(address)}/mailFolders/inbox?$select=id`);
            return { ok: true, reason: null };
        } catch (err) {
            if (err.status === 403) return { ok: false, reason: 'shared_mailbox_denied' };
            if (err.status === 404) return { ok: false, reason: 'mailbox_not_found' };
            return { ok: false, reason: 'probe_failed' };
        }
    }

    if (provider === 'gmail') {
        // Gmail cannot delegate. The only thing that makes a "shared" Gmail
        // mailbox work is a VERIFIED send-as alias on this account, so that is
        // what we check.
        try {
            const aliases = await listSendAsAliases({ tokens, onRefresh });
            const hit = aliases.find((a) => a.email === String(address).toLowerCase());
            if (!hit) return { ok: false, reason: 'alias_not_found' };
            if (!hit.verified) return { ok: false, reason: 'alias_not_verified' };
            return { ok: true, reason: null };
        } catch {
            // gmail.settings.basic is not in our scope set, so this lookup may
            // legitimately fail. Don't block the save on it — the send itself
            // will report a bad From.
            return { ok: true, reason: 'alias_unverifiable' };
        }
    }

    throw new Error(`Unknown provider: ${provider}`);
}

/** Gmail send-as aliases. Needs the gmail.settings.basic scope. */
async function listSendAsAliases({ tokens, onRefresh }) {
    const gmail = await gmailClientFromTokens(tokens, onRefresh);
    const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
    return (res.data.sendAs || []).map((a) => ({
        email: String(a.sendAsEmail || '').toLowerCase(),
        verified: a.verificationStatus === 'accepted' || Boolean(a.isPrimary),
        isPrimary: Boolean(a.isPrimary),
    }));
}

module.exports = {
    listMessages,
    getMessage,
    listAttachmentMeta,
    listThreadMessages,
    getAttachmentBytes,
    resolveMailboxAddress,
    probeSharedAccess,
    listSendAsAliases,
    computeThreadKey,
    MAILBOX_OVERLAP_MS,
    _buildGmailQuery: buildGmailQuery,
    _normalizeGmail: normalizeGmail,
    _normalizeGraph: normalizeGraph,
    _gmailAttachments: gmailAttachments,
};
