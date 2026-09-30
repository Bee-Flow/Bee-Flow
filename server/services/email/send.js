/**
 * Outbound e-mail — the shared send layer.
 *
 * Extracted from services/supportMailer.js so the support inbox is no longer the
 * only thing that can send threaded mail. Everything here is store-agnostic:
 * callers pass a token blob + an `onRefresh` callback (the contract
 * email/providerClients.js already uses) plus a mailbox descriptor.
 *
 * Two axes the support inbox never needed, and this layer adds:
 *
 *   • mailbox.mode 'personal' | 'shared' — Graph calls swap `/me` for
 *     `/users/{address}`, which is how an Outlook SHARED mailbox is reached with
 *     a delegated user's token (needs Mail.*.Shared consent). Gmail has no
 *     equivalent: the Gmail API cannot touch a delegated mailbox at all, so a
 *     "shared" Gmail send is really a verified send-as alias on the user's own
 *     mailbox and still goes out over userId:'me'.
 *
 *   • replyStrategy 'reply' | 'createReply' — `createReply` (draft → PATCH →
 *     send) needs Mail.ReadWrite; plain `reply` needs only Mail.Send. New callers
 *     should use 'reply'. The support inbox stays pinned to 'createReply' so this
 *     extraction changes nothing for it.
 */

const crypto = require('crypto');
const MailComposer = require('nodemailer/lib/mail-composer').default;
const { gmailClientFromTokens, graphFetchFromTokens } = require('./providerClients');

// ── Pure helpers (moved verbatim from supportMailer.js) ──────────────────────

function senderDomain(email) {
    const at = String(email || '').split('@')[1];
    return (at && at.trim()) || 'beeflow.nl';
}

/**
 * Sanitise an outbound HTML body.
 *
 * This used to be five regexes over the string. That is fine against the
 * markdown renderer's own output — the only thing it ever saw — but the reply
 * editor now sends author-written HTML with pasted fragments in it, and a
 * regex that looks for `<script>` does not see `<img src=x onerror=…>` written
 * with a newline in the attribute, or `<svg><script>`, or a `<base>` that
 * silently reroutes every relative link in the message.
 *
 * DOMPurify parses instead of matching, which is the whole difference. The
 * allowlist below is deliberately MAIL-shaped rather than web-shaped:
 *   • inline `style` SURVIVES — it is the only styling mail clients honour, and
 *     stripping it would throw away exactly the formatting the author wrote;
 *   • `<style>` blocks and `class` do NOT — Gmail and Outlook discard or mangle
 *     them anyway, and a Word paste drags in kilobytes of both;
 *   • `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<base>` and
 *     every `on*` handler are gone, which DOMPurify does by default;
 *   • `cid:` and `data:` stay usable on an image so a signature logo works.
 *
 * Falls back to the old regex pass if DOMPurify cannot be loaded — a mail must
 * still go out on a self-host with a broken optional dependency, and the regex
 * is strictly better than nothing.
 */
const MAIL_ALLOWED_TAGS = [
    'p', 'div', 'span', 'br', 'hr', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
    'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
    'img', 'font', 'small', 'sub', 'sup',
];
const MAIL_ALLOWED_ATTR = [
    'href', 'title', 'target', 'rel',
    'src', 'alt', 'width', 'height',
    'style', 'align', 'valign', 'bgcolor', 'color', 'face', 'size',
    'colspan', 'rowspan', 'cellpadding', 'cellspacing', 'border', 'dir',
];

let mailPurify = null;
function getMailPurify() {
    if (mailPurify !== null) return mailPurify;
    try {
        const createDOMPurify = require('dompurify');
        const { JSDOM } = require('jsdom');
        mailPurify = createDOMPurify(new JSDOM('').window);
    } catch (_) {
        mailPurify = false;
    }
    return mailPurify;
}

function sanitizeHtmlRegex(html) {
    return String(html)
        .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
        .replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '')
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
        .replace(/javascript:/gi, '');
}

function sanitizeHtml(html) {
    if (!html) return '';
    const purify = getMailPurify();
    if (!purify) return sanitizeHtmlRegex(html);
    return purify.sanitize(String(html), {
        ALLOWED_TAGS: MAIL_ALLOWED_TAGS,
        ALLOWED_ATTR: MAIL_ALLOWED_ATTR,
        // An inline logo travels as a cid: reference or a data: URI; neither is
        // in DOMPurify's default URI allowlist for src.
        ADD_DATA_URI_TAGS: ['img'],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|cid|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    });
}

function textToHtml(text) {
    if (!text) return '';
    const esc = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(/\n/g, '<br>');
}

function _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline markdown on ALREADY-HTML-ESCAPED text: links, bold, italic, code.
function _inlineMd(escaped) {
    return String(escaped)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Minimal, dependency-free Markdown → HTML for outbound email bodies. Covers
 * what an agent emits: headings, ordered/unordered lists, paragraphs,
 * bold/italic/code, links. Output is further sanitised by sanitizeHtml().
 */
function markdownToHtml(md) {
    if (!md) return '';
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let listType = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { flushPara(); closeList(); continue; }
        let m;
        if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
            flushPara(); closeList();
            const level = Math.min(m[1].length + 1, 6);
            out.push(`<h${level}>${_inlineMd(_escapeHtml(m[2]))}</h${level}>`);
        } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
            flushPara();
            if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
            out.push(`<li>${_inlineMd(_escapeHtml(m[1]))}</li>`);
        } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
            flushPara();
            if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
            out.push(`<li>${_inlineMd(_escapeHtml(m[1]))}</li>`);
        } else {
            if (listType) closeList();
            para.push(_inlineMd(_escapeHtml(line)));
        }
    }
    flushPara(); closeList();
    return out.join('\n');
}

function htmlToText(html) {
    if (!html) return '';
    return String(html)
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildRawMime({ fromName, fromEmail, to, cc, subject, text, html, inReplyTo, references, messageId, attachments }) {
    const composer = new MailComposer({
        from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
        to,
        cc: cc || undefined,
        subject,
        text: text || undefined,
        html: html || undefined,
        inReplyTo: inReplyTo || undefined,
        references: references || undefined,
        messageId,
        attachments: (attachments && attachments.length) ? attachments : undefined,
    });
    return new Promise((resolve, reject) => {
        composer.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
    });
}

// ── Header hygiene ───────────────────────────────────────────────────────────

/**
 * Strip CR/LF from a value destined for a mail header.
 *
 * MailComposer encodes headers properly, but the Graph JSON path does not go
 * through it at all — an unescaped newline in a subject or address there is a
 * header-injection primitive. Cheap enough to apply on every path.
 */
function stripHeaderValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function toRecipientList(value) {
    if (!value) return [];
    const list = Array.isArray(value) ? value : String(value).split(',');
    return list.map((v) => stripHeaderValue(v)).filter(Boolean);
}

/** Graph wants `[{ emailAddress: { address } }]`. */
function graphRecipients(value) {
    return toRecipientList(value).map((address) => ({ emailAddress: { address } }));
}

/**
 * The reply's References chain: everything the parent already referenced, plus
 * the parent's own Message-ID. Clients thread on this.
 */
function buildReferenceChain(references, inReplyTo) {
    return [references, inReplyTo].filter(Boolean).join(' ').trim() || undefined;
}

/** RFC822 Message-ID we mint ourselves so the reply can be threaded on later. */
function mintMessageId(seed, fromEmail) {
    return `<support-${seed}-${crypto.randomUUID()}@${senderDomain(fromEmail)}>`;
}

// ── Provider senders ─────────────────────────────────────────────────────────

async function sendViaGmail({
    tokens, onRefresh, mailbox, to, cc, subject, textBody, htmlBody,
    inReplyTo, references, providerThreadId, messageId, attachments,
}) {
    const gmail = await gmailClientFromTokens(tokens, onRefresh);
    const raw = await buildRawMime({
        fromName: mailbox.displayName,
        // For a Gmail "shared" mailbox this is the send-as alias; Gmail rejects
        // it with 400 unless the alias is verified on this account.
        fromEmail: mailbox.address,
        to: toRecipientList(to).join(', '),
        cc: toRecipientList(cc).join(', ') || undefined,
        subject: stripHeaderValue(subject),
        text: textBody,
        html: sanitizeHtml(htmlBody),
        inReplyTo: inReplyTo || undefined,
        references: buildReferenceChain(references, inReplyTo),
        messageId,
        attachments,
    });
    const encoded = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const requestBody = { raw: encoded };
    if (providerThreadId) requestBody.threadId = providerThreadId;
    // Always 'me': the Gmail API cannot act on any other mailbox, delegated or not.
    const sent = await gmail.users.messages.send({ userId: 'me', requestBody });
    return {
        providerMessageId: sent.data.id || null,
        providerThreadId: sent.data.threadId || providerThreadId || null,
        rfc822MessageId: messageId,
    };
}

async function sendViaOutlook({
    tokens, onRefresh, mailbox, to, cc, subject, htmlBody,
    sourceProviderMessageId, providerThreadId, replyStrategy,
}) {
    const html = sanitizeHtml(htmlBody);
    // A shared mailbox is addressed by UPN/SMTP; `/me` is the signed-in user's own.
    const base = mailbox.mode === 'shared' && mailbox.address
        ? `/users/${encodeURIComponent(mailbox.address)}`
        : '/me';

    if (sourceProviderMessageId && replyStrategy === 'createReply') {
        // Draft → PATCH → send. Preserves conversationId, but needs Mail.ReadWrite.
        const draft = await graphFetchFromTokens(tokens, onRefresh,
            `${base}/messages/${encodeURIComponent(sourceProviderMessageId)}/createReply`,
            { method: 'POST', body: JSON.stringify({}) });
        const draftId = draft.id;
        await graphFetchFromTokens(tokens, onRefresh, `${base}/messages/${draftId}`, {
            method: 'PATCH',
            body: JSON.stringify({ body: { contentType: 'HTML', content: html } }),
        });
        await graphFetchFromTokens(tokens, onRefresh, `${base}/messages/${draftId}/send`, { method: 'POST' });
        return { providerMessageId: draftId, providerThreadId: providerThreadId || null, rfc822MessageId: null };
    }

    if (sourceProviderMessageId) {
        // One call, and only Mail.Send / Mail.Send.Shared is required.
        const message = {};
        const toList = graphRecipients(to);
        const ccList = graphRecipients(cc);
        if (toList.length) message.toRecipients = toList;
        if (ccList.length) message.ccRecipients = ccList;
        await graphFetchFromTokens(tokens, onRefresh,
            `${base}/messages/${encodeURIComponent(sourceProviderMessageId)}/reply`,
            { method: 'POST', body: JSON.stringify({ message, comment: html }) });
        return { providerMessageId: null, providerThreadId: providerThreadId || null, rfc822MessageId: null };
    }

    const message = {
        subject: stripHeaderValue(subject),
        body: { contentType: 'HTML', content: html },
        toRecipients: graphRecipients(to),
    };
    const ccList = graphRecipients(cc);
    if (ccList.length) message.ccRecipients = ccList;
    await graphFetchFromTokens(tokens, onRefresh, `${base}/sendMail`, {
        method: 'POST',
        body: JSON.stringify({ message, saveToSentItems: true }),
    });
    return { providerMessageId: null, providerThreadId: providerThreadId || null, rfc822MessageId: null };
}

const PROVIDER_SENDERS = { gmail: sendViaGmail, outlook: sendViaOutlook };

/**
 * Send one message from a mailbox, optionally threaded into an existing
 * conversation.
 *
 * @param {object}   p
 * @param {'gmail'|'outlook'} p.provider
 * @param {object}   p.tokens         { accessToken, refreshToken, scope?, expiryDate? }
 * @param {Function} p.onRefresh      called with the refreshed blob — MUST persist it
 * @param {object}   p.mailbox        { address, displayName?, mode: 'personal'|'shared' }
 * @param {string|string[]} p.to
 * @param {string|string[]} [p.cc]
 * @param {string}   p.subject
 * @param {string}   [p.textBody]
 * @param {string}   [p.htmlBody]
 * @param {string}   [p.inReplyTo]                 parent Message-ID
 * @param {string}   [p.references]                parent's References chain
 * @param {string}   [p.providerThreadId]          Gmail threadId / Graph conversationId
 * @param {string}   [p.sourceProviderMessageId]   the message being replied to
 * @param {string}   [p.messageId]                 override the minted Message-ID
 * @param {string}   [p.messageIdSeed]             used when minting one
 * @param {Array}    [p.attachments]               MailComposer attachments (Gmail only)
 * @param {'reply'|'createReply'} [p.replyStrategy='reply']
 * @returns {Promise<{providerMessageId, providerThreadId, rfc822MessageId}>}
 */
async function sendMailMessage(p) {
    const sender = PROVIDER_SENDERS[p.provider];
    if (!sender) throw new Error(`Unsupported provider: ${p.provider}`);
    if (!p.tokens || !p.tokens.accessToken) {
        throw new Error('Mailbox is not connected — reconnect the mailbox.');
    }
    const mailbox = p.mailbox || {};
    if (!mailbox.address) throw new Error('No mailbox address to send from.');

    return sender({
        ...p,
        mailbox: { ...mailbox, mode: mailbox.mode === 'shared' ? 'shared' : 'personal' },
        replyStrategy: p.replyStrategy === 'createReply' ? 'createReply' : 'reply',
        messageId: p.messageId || mintMessageId(p.messageIdSeed || 'msg', mailbox.address),
    });
}

module.exports = {
    sendMailMessage,
    // Pure helpers, re-exported by supportMailer for its existing callers.
    sanitizeHtml,
    textToHtml,
    markdownToHtml,
    htmlToText,
    buildRawMime,
    senderDomain,
    stripHeaderValue,
    toRecipientList,
    graphRecipients,
    buildReferenceChain,
    mintMessageId,
    _escapeHtml,
};
