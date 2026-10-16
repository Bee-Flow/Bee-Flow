/**
 * vCard text <-> contact object for the Nextcloud contacts tools (vcf for line
 * folding and parameter parsing, manual RFC 6350 escaping).
 */

const vCard = require('vcf');
const log = require('../telemetry/log');

// ─── vCard helpers (vcf for line folding + parameter parsing, with manual
// RFC 6350 escape/unescape since vcf does not transform text values) ───

// Escape a free-text field per RFC 6350 §3.4: backslash → \\, newline → \n,
// comma → \,, semicolon → \;.
function escapeText(s) {
    return String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/\r\n|\n|\r/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');
}

function unescapeText(s) {
    if (s == null) return null;
    return String(s)
        .replace(/\\n/gi, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\');
}

// Split a structured value (N, ORG) on unescaped semicolons.
function splitStructured(s) {
    const parts = [];
    let cur = '';
    let escaped = false;
    for (const ch of String(s)) {
        if (escaped) { cur += '\\' + ch; escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === ';') { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts;
}

function valueOfFirst(card, key) {
    const v = card.get(key);
    if (!v) return null;
    const p = Array.isArray(v) ? v[0] : v;
    return p == null ? null : String(p.valueOf());
}

function valuesOf(card, key) {
    const v = card.get(key);
    if (!v) return [];
    const list = Array.isArray(v) ? v : [v];
    return list.map((p) => String(p.valueOf()));
}

function contactFromVCard(text) {
    if (!text) return null;
    let card;
    try {
        card = new vCard().parse(text);
    } catch (err) {
        // The message can quote a vCard line (EMAIL/TEL): log the error class only.
        log.warn('[nextcloudContacts] vCard parse failed', err?.name);
        return null;
    }

    const nRaw = valueOfFirst(card, 'n');
    let firstName = null;
    let lastName = null;
    if (nRaw) {
        const parts = splitStructured(nRaw);
        lastName = unescapeText(parts[0] || '') || null;
        firstName = unescapeText(parts[1] || '') || null;
    }
    const orgRaw = valueOfFirst(card, 'org');
    const orgFirst = orgRaw ? splitStructured(orgRaw)[0] : null;

    return {
        uid: valueOfFirst(card, 'uid'),
        fullName: unescapeText(valueOfFirst(card, 'fn')),
        firstName,
        lastName,
        emails: valuesOf(card, 'email').map(unescapeText),
        phones: valuesOf(card, 'tel').map(unescapeText),
        organization: unescapeText(orgFirst),
        title: unescapeText(valueOfFirst(card, 'title')),
        notes: unescapeText(valueOfFirst(card, 'note')),
    };
}

function buildVCard(c) {
    const card = new vCard();
    card.set('version', '3.0');
    if (c.uid) card.set('uid', c.uid);
    card.set('fn', escapeText(c.fullName));
    // N is the structured family;given;additional;prefix;suffix — semicolons
    // here are field separators, not literals, so we escape per-segment only.
    card.set('n', `${escapeText(c.lastName)};${escapeText(c.firstName)};;;`);
    if (Array.isArray(c.emails)) {
        c.emails.filter(Boolean).forEach((e, i) => {
            card.add('email', escapeText(e), i === 0 ? { type: ['INTERNET', 'PREF'] } : { type: 'INTERNET' });
        });
    }
    if (Array.isArray(c.phones)) {
        c.phones.filter(Boolean).forEach((p, i) => {
            card.add('tel', escapeText(p), i === 0 ? { type: ['CELL', 'PREF'] } : { type: 'CELL' });
        });
    }
    if (c.organization) card.set('org', escapeText(c.organization));
    if (c.title) card.set('title', escapeText(c.title));
    if (c.notes) card.set('note', escapeText(c.notes));
    return card.toString('3.0');
}

function parseVCard(text) {
    return contactFromVCard(text) || {
        uid: null, fullName: null, firstName: null, lastName: null,
        emails: [], phones: [], organization: null, title: null, notes: null,
    };
}

module.exports = { buildVCard, parseVCard };
