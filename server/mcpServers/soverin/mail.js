/**
 * Soverin MCP — pure helpers.
 *
 * Everything here is side-effect free so it can be unit tested without an
 * IMAP/SMTP server; the actual transport work lives in index.mjs.
 *
 * Soverin (soverin.nl) is a Dutch privacy-first mail provider with no public
 * API — it speaks plain IMAP + SMTP, so that is what this server drives.
 * Settings per Soverin's own KB: imap.soverin.net:993 (SSL) / 143 (STARTTLS),
 * smtp.soverin.net:465 (SSL) / 587 (STARTTLS), username = full e-mail address.
 */

'use strict';

const DEFAULT_IMAP_HOST = 'imap.soverin.net';
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_HOST = 'smtp.soverin.net';
const DEFAULT_SMTP_PORT = 465;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_BODY_CHARS = 8000;

/** Tools that mutate the mailbox or send mail — skipped when read-only. */
const WRITE_TOOLS = ['send_message', 'mark_message', 'move_message'];

const isTruthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

const toInt = (v, fallback) => {
    const n = parseInt(String(v ?? '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Read the server's configuration from the environment.
 *
 * Deliberately does NOT throw on missing credentials: the marketplace probes a
 * freshly installed server without any user credentials to discover its tools,
 * so startup must always succeed. Credentials are enforced per call via
 * `requireCredentials()`.
 */
function readConfig(env = process.env) {
    const imapPort = toInt(env.SOVERIN_IMAP_PORT, DEFAULT_IMAP_PORT);
    const smtpPort = toInt(env.SOVERIN_SMTP_PORT, DEFAULT_SMTP_PORT);

    return {
        email: String(env.SOVERIN_EMAIL || '').trim(),
        password: String(env.SOVERIN_PASSWORD || ''),
        imap: {
            host: String(env.SOVERIN_IMAP_HOST || '').trim() || DEFAULT_IMAP_HOST,
            port: imapPort,
            // 993 is implicit TLS; 143 upgrades via STARTTLS.
            secure: imapPort !== 143,
        },
        smtp: {
            host: String(env.SOVERIN_SMTP_HOST || '').trim() || DEFAULT_SMTP_HOST,
            port: smtpPort,
            // 465 is implicit TLS; 587 upgrades via STARTTLS.
            secure: smtpPort === 465,
        },
        // Operator escape hatch: expose search/read only, no sending or mutation.
        readOnly: isTruthy(env.SOVERIN_READ_ONLY),
        maxBodyChars: toInt(env.SOVERIN_MAX_BODY_CHARS, DEFAULT_BODY_CHARS),
    };
}

/** Throw a user-actionable error when the per-user credentials are missing. */
function requireCredentials(config) {
    if (!config.email || !config.password) {
        throw new Error(
            'Soverin credentials are not configured. Add your Soverin e-mail address and password under Settings → Integrations.'
        );
    }
    return config;
}

/** Clamp a caller-supplied result limit into a sane range. */
function clampLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
    const n = parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
}

/**
 * Parse a date filter. Accepts an ISO date/timestamp or a relative offset the
 * models reach for anyway ('7d', '24h', '30m').
 * Returns a Date, or null when the input is absent/unparseable.
 */
function parseWhen(value, now = new Date()) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

    const raw = String(value).trim();
    const relative = raw.match(/^(\d+)\s*([dhm])$/i);
    if (relative) {
        const amount = parseInt(relative[1], 10);
        const unit = relative[2].toLowerCase();
        const ms = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
        return new Date(now.getTime() - amount * ms);
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Build an ImapFlow search query from the tool input.
 * An empty input means "everything in the mailbox" — IMAP needs an explicit ALL.
 */
function buildSearchQuery(input = {}, now = new Date()) {
    const query = {};

    for (const key of ['from', 'to', 'cc', 'subject', 'body', 'text']) {
        const value = typeof input[key] === 'string' ? input[key].trim() : '';
        if (value) query[key] = value;
    }

    // `unread` is the user-facing name; IMAP searches on the \Seen flag.
    if (typeof input.unread === 'boolean') query.seen = !input.unread;
    if (input.flagged === true) query.flagged = true;

    const since = parseWhen(input.since, now);
    if (since) query.since = since;
    const before = parseWhen(input.before, now);
    if (before) query.before = before;

    if (Object.keys(query).length === 0) query.all = true;
    return query;
}

/** ImapFlow hands back flags as a Set; normalise to a plain array. */
function toFlagArray(flags) {
    if (!flags) return [];
    if (Array.isArray(flags)) return flags;
    if (typeof flags[Symbol.iterator] === 'function') return Array.from(flags);
    return [];
}

/** `{ name, address }` → `Name <a@b.nl>` (either half may be missing). */
function formatAddress(addr) {
    if (!addr) return '';
    const name = String(addr.name || '').trim();
    const address = String(addr.address || '').trim();
    if (name && address) return `${name} <${address}>`;
    return address || name;
}

function formatAddressList(list, max = 10) {
    const items = (Array.isArray(list) ? list : []).map(formatAddress).filter(Boolean);
    if (items.length <= max) return items.join(', ');
    return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

/**
 * Walk a BODYSTRUCTURE looking for a part the sender marked as an attachment.
 * Inline images (disposition `inline`) do not count.
 */
function hasAttachments(bodyStructure) {
    if (!bodyStructure || typeof bodyStructure !== 'object') return false;
    if (String(bodyStructure.disposition || '').toLowerCase() === 'attachment') return true;
    return (bodyStructure.childNodes || []).some(hasAttachments);
}

/** Compact, token-cheap summary of a fetched message — used by search results. */
function summarizeMessage(message, mailbox) {
    const envelope = message.envelope || {};
    const flags = toFlagArray(message.flags);
    const date = envelope.date instanceof Date ? envelope.date.toISOString() : envelope.date || null;

    return {
        uid: message.uid,
        mailbox,
        date,
        from: formatAddressList(envelope.from),
        to: formatAddressList(envelope.to),
        subject: envelope.subject || '(no subject)',
        unread: !flags.includes('\\Seen'),
        flagged: flags.includes('\\Flagged'),
        hasAttachments: hasAttachments(message.bodyStructure),
        size: typeof message.size === 'number' ? message.size : null,
    };
}

/** Very small HTML → text fallback for messages that ship no text/plain part. */
function htmlToText(html) {
    return String(html || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        // Opening tags collapse to a space, which would otherwise indent every
        // line produced by the closing tag before it.
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Pick a readable body out of a mailparser result and cap its size — a single
 * newsletter can otherwise blow the model's context on its own.
 */
function extractBody(parsed = {}, maxChars = DEFAULT_BODY_CHARS) {
    const text = String(parsed.text || '').trim() || htmlToText(parsed.html);
    if (text.length <= maxChars) return { body: text, truncated: false };
    return {
        body: `${text.slice(0, maxChars)}\n\n[… truncated, ${text.length - maxChars} more characters]`,
        truncated: true,
    };
}

/** Attachment metadata only — bytes are never pushed through the model. */
function summarizeAttachments(attachments) {
    return (Array.isArray(attachments) ? attachments : []).map((a) => ({
        filename: a.filename || '(unnamed)',
        contentType: a.contentType || 'application/octet-stream',
        size: typeof a.size === 'number' ? a.size : null,
    }));
}

/**
 * Threading headers for a reply, so mail clients keep the conversation intact.
 * `envelope` is the ImapFlow envelope of the message being replied to.
 */
function buildReplyHeaders(envelope = {}) {
    const subject = String(envelope.subject || '').trim();
    const references = [envelope.inReplyTo, envelope.messageId]
        .map((v) => String(v || '').trim())
        .filter(Boolean);

    return {
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`,
        inReplyTo: envelope.messageId || null,
        references: Array.from(new Set(references)),
    };
}

/**
 * Find a mailbox by its role. Prefers the RFC 6154 SPECIAL-USE flag and falls
 * back to name matching (Soverin's webmail creates Dutch folder names).
 */
function pickMailbox(list, role) {
    const boxes = Array.isArray(list) ? list : [];
    const specialUse = {
        sent: '\\Sent',
        trash: '\\Trash',
        drafts: '\\Drafts',
        junk: '\\Junk',
        archive: '\\Archive',
    }[role];
    const names = {
        sent: /^(sent|sent items|sent mail|verzonden(\s|$)|verzonden items)$/i,
        trash: /^(trash|deleted items|prullenbak|verwijderd)$/i,
        drafts: /^(drafts?|concepten)$/i,
        junk: /^(junk|spam|ongewenst)$/i,
        archive: /^(archive|archief)$/i,
    }[role];
    if (!specialUse) return null;

    const bySpecialUse = boxes.find((b) => b && b.specialUse === specialUse);
    if (bySpecialUse) return bySpecialUse.path;

    const byName = boxes.find((b) => b && names.test(String(b.name || '')));
    return byName ? byName.path : null;
}

const ADDRESS_RE = /^[^<>@\s,]+@[^<>@\s,]+\.[^<>@\s,]+$/;

/** Normalise a to/cc/bcc input (string or array) and reject non-addresses. */
function normalizeRecipients(value, field = 'to') {
    const items = (Array.isArray(value) ? value : String(value || '').split(','))
        .map((v) => String(v || '').trim())
        .filter(Boolean);

    for (const item of items) {
        // Accepts both `a@b.nl` and `Name <a@b.nl>`.
        const angled = item.match(/<([^<>]+)>\s*$/);
        const address = angled ? angled[1].trim() : item;
        if (!ADDRESS_RE.test(address)) {
            throw new Error(`Invalid e-mail address in "${field}": ${item}`);
        }
    }
    return items;
}

/** Filter the tool list down to what the current configuration allows. */
function allowedTools(tools, config) {
    if (!config || !config.readOnly) return tools;
    return tools.filter((t) => !WRITE_TOOLS.includes(t.name));
}

module.exports = {
    DEFAULT_IMAP_HOST,
    DEFAULT_IMAP_PORT,
    DEFAULT_SMTP_HOST,
    DEFAULT_SMTP_PORT,
    DEFAULT_LIMIT,
    MAX_LIMIT,
    DEFAULT_BODY_CHARS,
    WRITE_TOOLS,
    readConfig,
    requireCredentials,
    clampLimit,
    parseWhen,
    buildSearchQuery,
    toFlagArray,
    formatAddress,
    formatAddressList,
    hasAttachments,
    summarizeMessage,
    htmlToText,
    extractBody,
    summarizeAttachments,
    buildReplyHeaders,
    pickMailbox,
    normalizeRecipients,
    allowedTools,
};
