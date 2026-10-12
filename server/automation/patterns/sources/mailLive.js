// @typecheck
'use strict';
/**
 * Pattern source: the user's mail, read live at scan time.
 *
 * The SERVER picks every call and every argument; no model is involved:
 *   gmail           gmail_search, received and sent, each capped at 200
 *   outlook         outlook_list_recent on inbox and sentitems, `since` the
 *                   window start, paged, capped at 200 each
 *   nextcloud_mail  list_accounts → list_mailboxes → the inbox and the sent
 *                   mailbox, nextcloud_mail_search capped at 100 each and
 *                   filtered to the window here (the tool has no date filter)
 *
 * Each message becomes an event the moment it is read: the subject turns into
 * a template (subjectTemplate), the sender's or first recipient's domain into
 * a per-scan pseudonym (d1, d2, …, and the same pseudonym replaces that
 * domain where a subject spells it out). Addresses, names in the From line,
 * snippets and ids are never copied; nothing of the raw result outlives the
 * loop that reads it.
 *
 * Bulk mail (List-Unsubscribe / Precedence from Gmail, or a no-reply style
 * sender) is flagged, not dropped: the miner only keeps it when the user
 * reliably acts on it.
 */

const { makeEvent } = require('../events');
const { subjectTemplate, replaceBareDomains } = require('../templating');
const { checkToolResult, throwIfAborted, toMs, inWindow } = require('./common');

const GMAIL_CAP = 200;
const OUTLOOK_CAP = 200;
const OUTLOOK_PAGES = 4;
const NC_MAIL_CAP = 100;
const NC_ACCOUNTS_CAP = 3;

/** @typedef {import('./common').LiveCtx} LiveCtx */

// ── Domains ─────────────────────────────────────────────────────────────────

const ADDRESS_RE = /[\p{L}\p{N}._%+-]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,})/u;
const LOCAL_PART_RE = /([\p{L}\p{N}._%+-]+)@/u;
// A second-level label under a two-letter country code: acme.co.uk is acme's.
const SLD = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne', 'gv']);

/**
 * The registrable part of a host, lower-cased: mail.acme.com → acme.com.
 * @param {string} host
 */
function registrable(host) {
    const labels = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    if (labels.length <= 2) return labels.join('.');
    const tld = labels[labels.length - 1];
    const sld = labels[labels.length - 2];
    const keep = tld.length === 2 && SLD.has(sld) ? 3 : 2;
    return labels.slice(-keep).join('.');
}

/** Domain of the first address in a From/To value ("Name <a@x.nl>, b@y"). */
function domainOf(value) {
    const m = ADDRESS_RE.exec(String(value ?? ''));
    return m ? registrable(m[1]) : null;
}

const BULK_SENDER_RE = /^(?:no-?reply|do-?not-?reply|donotreply|newsletters?|news|notifications?|notify|mailer(?:-daemon)?|marketing|digest|bounces?|postmaster)(?:[._+-].*)?$/i;

/** A no-reply style sender. Only this verdict is kept, never the address. */
function bulkSender(value) {
    const m = LOCAL_PART_RE.exec(String(value ?? ''));
    return !!m && BULK_SENDER_RE.test(m[1]);
}

/**
 * Per-scan domain pseudonyms. The map lives as long as one scan: the next
 * scan starts again at d1, so a pseudonym means nothing outside its scan.
 * @returns {(domain: string) => string}
 */
function makeDomainPseudonymiser() {
    /** @type {Map<string, string>} */
    const map = new Map();
    return (domain) => {
        const key = registrable(domain);
        let p = map.get(key);
        if (!p) {
            p = `d${map.size + 1}`;
            map.set(key, p);
        }
        return p;
    };
}

/**
 * The mail subject as a template, with any spelled-out domain replaced by its
 * pseudonym. Empty subjects (and the connectors' "(no subject)") give null.
 * @param {string} subject
 * @param {(domain: string) => string} pseudoDomain
 * @returns {string|null}
 */
function mailTemplate(subject, pseudoDomain) {
    const s = String(subject ?? '').trim();
    if (!s || /^\(no subject\)$/i.test(s)) return null;
    // A spelled-out host (and any path after it) becomes the sender's kind of
    // pseudonym; templating's own pass would make it a bare <domain>.
    const masked = replaceBareDomains(s, (host) => ` <domain:${pseudoDomain(host)}> `);
    return subjectTemplate(masked) || null;
}

/**
 * @param {{ app: string, direction: 'in'|'out', subject: any, ts: number, address: any,
 *           bulk?: boolean, hasAttachment?: boolean }} m
 * @param {LiveCtx} ctx
 */
function mailEvent(m, ctx) {
    if (!inWindow(m.ts, ctx)) return null;
    const domain = domainOf(m.address);
    return makeEvent({
        ts: m.ts,
        source: 'mail',
        objectType: 'mail',
        app: m.app,
        verb: m.direction === 'in' ? 'mail.received' : 'mail.sent',
        direction: m.direction,
        template: mailTemplate(m.subject, ctx.pseudoDomain),
        hasAttachment: typeof m.hasAttachment === 'boolean' ? m.hasAttachment : undefined,
        bulk: m.direction === 'in' ? (!!m.bulk || bulkSender(m.address)) : undefined,
        domainPseudo: domain ? ctx.pseudoDomain(domain) : undefined,
    });
}

/** Push each non-null event; returns the list. */
function pushAll(out, items, toEvent) {
    for (const it of items || []) {
        const ev = toEvent(it);
        if (ev) out.push(ev);
    }
    return out;
}

// ── Collectors ──────────────────────────────────────────────────────────────

/**
 * @param {LiveCtx} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectGmail(ctx) {
    const days = Math.max(1, Math.ceil(ctx.windowDays));
    const passes = [
        // Promotions and social are where newsletters live; the cap is better
        // spent on mail a person wrote.
        { direction: 'in', query: `newer_than:${days}d -in:sent -in:drafts -in:chats -category:promotions -category:social` },
        { direction: 'out', query: `in:sent newer_than:${days}d` },
    ];
    const out = [];
    for (const pass of passes) {
        throwIfAborted(ctx.signal);
        const res = checkToolResult(await ctx.executeTool('gmail_search', { query: pass.query, maxResults: GMAIL_CAP }), 'gmail_search');
        const direction = /** @type {'in'|'out'} */ (pass.direction);
        pushAll(out, res.results, (m) => mailEvent({
            app: 'gmail', direction, subject: m?.subject, ts: toMs(m?.date),
            address: direction === 'in' ? m?.from : m?.to, bulk: m?.isBulk === true,
        }, ctx));
    }
    return out;
}

/**
 * @param {LiveCtx} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectOutlook(ctx) {
    const since = new Date(ctx.since).toISOString();
    const out = [];
    for (const [folder, direction] of /** @type {Array<[string, 'in'|'out']>} */ ([['inbox', 'in'], ['sentitems', 'out']])) {
        throwIfAborted(ctx.signal);
        const res = checkToolResult(await ctx.executeTool('outlook_list_recent', {
            folder, since, maxResults: OUTLOOK_CAP, maxPages: OUTLOOK_PAGES,
        }), 'outlook_list_recent');
        pushAll(out, res.results, (m) => mailEvent({
            app: 'outlook', direction, subject: m?.subject, ts: toMs(m?.date),
            address: direction === 'in' ? m?.from : m?.to, hasAttachment: !!m?.hasAttachments,
        }, ctx));
    }
    return out;
}

const SENT_NAME_RE = /^(?:sent|sent items|sent messages|sent mail|inbox[./]sent|verzonden|verzonden items|verzonden berichten|gesendet|gesendete elemente|gesendete objekte|envoy[ée]s|[ée]l[ée]ments envoy[ée]s)$/i;

/**
 * The inbox and the sent mailbox of one account: by special-use role first,
 * by the usual names (EN/NL/DE/FR) otherwise.
 * @param {any[]} mailboxes
 */
function pickMailboxes(mailboxes) {
    const list = Array.isArray(mailboxes) ? mailboxes : [];
    const role = (m) => String(m?.specialRole || '').toLowerCase();
    const names = (m) => [m?.name, m?.displayName].map((v) => String(v || '').trim());
    const inbox = list.find((m) => role(m) === 'inbox') || list.find((m) => names(m).some((n) => /^inbox$/i.test(n)));
    const sent = list.find((m) => role(m) === 'sent') || list.find((m) => names(m).some((n) => SENT_NAME_RE.test(n)));
    /** @type {Array<{ id: any, direction: 'in'|'out' }>} */
    const picked = [];
    if (inbox?.id != null) picked.push({ id: inbox.id, direction: 'in' });
    if (sent?.id != null && sent.id !== inbox?.id) picked.push({ id: sent.id, direction: 'out' });
    return picked;
}

/**
 * @param {LiveCtx} ctx
 * @returns {Promise<import('../events').WorkEvent[]>}
 */
async function collectNextcloudMail(ctx) {
    const accounts = checkToolResult(await ctx.executeTool('nextcloud_mail_list_accounts', {}), 'nextcloud_mail_list_accounts');
    const out = [];
    for (const account of (accounts.accounts || []).slice(0, NC_ACCOUNTS_CAP)) {
        if (account?.id == null) continue;
        throwIfAborted(ctx.signal);
        const boxes = checkToolResult(
            await ctx.executeTool('nextcloud_mail_list_mailboxes', { accountId: account.id }), 'nextcloud_mail_list_mailboxes');
        for (const box of pickMailboxes(boxes.mailboxes)) {
            throwIfAborted(ctx.signal);
            const res = checkToolResult(
                await ctx.executeTool('nextcloud_mail_search', { mailboxId: box.id, limit: NC_MAIL_CAP }), 'nextcloud_mail_search');
            pushAll(out, res.messages, (m) => {
                const flags = m?.flags || {};
                if (flags.junk || flags.$junk) return null;
                return mailEvent({
                    app: 'nextcloud_mail', direction: box.direction, subject: m?.subject, ts: toMs(m?.dateInt),
                    address: box.direction === 'in' ? m?.from : m?.to, hasAttachment: !!m?.hasAttachments,
                }, ctx);
            });
        }
    }
    return out;
}

module.exports = {
    collectGmail,
    collectOutlook,
    collectNextcloudMail,
    makeDomainPseudonymiser,
    mailTemplate,
    domainOf,
    registrable,
    bulkSender,
    pickMailboxes,
};
