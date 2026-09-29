'use strict';

/**
 * Decide which objects on a page identify a person or the customer.
 *
 * Text is matched by rules (contact patterns, the customer's own terms, the value next to an
 * "Author"/"Checked" style label) and by ids an AI pass flagged. Graphics are matched by where
 * they sit: a logo is the coloured or densely drawn artwork right next to the company's text.
 */

// A run is as long as the uploaded file makes it, so no pattern here may repeat without a
// bound: an unbounded `[\w-]+` before a literal backtracks quadratically over a long run that
// does not match (20,000 characters took ~170 ms, a crafted run of a few MB minutes). The
// bounds are the real limits: 64 for a mail local part, 63 for a DNS label, 253 for a host.
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/i;
const URL = /\b(?:https?:\/\/|www\.)[\w.-]{1,253}\.[a-z]{2,63}\b|\b[\w-]{1,63}\.(?:com|nl|be|de|eu|org|net|co\.uk|fr|io)\b/i;
// A phone number needs a label, an international prefix or a separated local format: a bare
// run of digits is an article number and "03-02-2025" is a date.
const PHONE_LABEL = /\b(?:phone|tel|telefoon|fax|mobile|mob|gsm)\b\s*[:.]/i;
const PHONE_INTL = /(?:\+|\[\+|\(\+|\b00)\d{1,3}\]?\)?[\s./-]*\(?\d{1,4}\)?(?:[\s./-]+\d{2,5}){1,4}/;
const PHONE_LOCAL = /\b0\d{1,3}[\s-]\d{3,4}[\s-]?\d{3,4}\b/;
const DATE = /^\s*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\s*$/;
const IBAN = /\b[A-Z]{2}\d{2}\s?[A-Z]{4}\s?(?:\d{4}\s?){2}\d{2}\b/;
const POSTCODE_NL = /\b\d{4}\s?[A-Z]{2}\b\s+[A-Z][a-z]+/;
const LEGAL = /\b(property of|all rights reserved|unauthori[sz]ed use|eigendom van|alle rechten voorbehouden|confidential|vertrouwelijk)\b/i;

const PERSON_LABEL = new RegExp('^(' + [
    'author', 'drawn( by)?', 'checked( by)?', 'approved( by)?', 'designed( by)?', 'designer', 'engineer',
    'contact( person)?', 'customer', 'client', 'getekend( door)?', 'tekenaar', 'gecontroleerd( door)?',
    'goedgekeurd( door)?', 'ontwerper', 'klant', 'opdrachtgever', 'gezeichnet', 'gepr(ü|ue)ft', 'freigegeben',
    'bearbeiter', 'kunde',
].join('|') + ')\\s*:?$', 'i');
// Field labels that sit on the same row but are never a person's value.
const OTHER_LABEL = /^(date|datum|scale|schaal|format|page|sheet|blad|rev\.?|revision|material|finish|weight|gewicht)\b/i;
const EMPTY_VALUE = /^[-–—_./\s]*$/;
const GENERIC_DOMAINS = new Set(['gmail', 'hotmail', 'outlook', 'yahoo', 'live', 'icloud', 'example', 'mail', 'info', 'online', 'www']);

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const width = (b) => b[2] - b[0];
const height = (b) => b[3] - b[1];
const area = (b) => Math.max(0, width(b)) * Math.max(0, height(b));
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const intersect = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const insideShare = (b, zone) => {
    const i = intersect(b, zone);
    if (i[2] <= i[0] || i[3] <= i[1]) return 0;
    return area(i) / Math.max(area(b), 1e-6);
};
const chroma = (c) => (c ? Math.max(...c) - Math.min(...c) : 0);

/** Terms a document gives away about its owner: the name in its own web and mail domains. */
function deriveTerms(texts) {
    const out = new Set();
    for (const t of texts) {
        for (const m of String(t).matchAll(/(?:www\.|@|https?:\/\/)([\w-]{1,63})\.[a-z]{2,63}/gi)) {
            const label = m[1].toLowerCase();
            if (label.length >= 4 && !GENERIC_DOMAINS.has(label)) out.add(label);
        }
    }
    return [...out];
}

/** Why a text run identifies someone, or null. `terms` are normalised. */
function textReason(text, terms) {
    if (!text || !text.trim()) return null;
    // Every pattern above repeats a bounded number of times, so each test is linear in the
    // length of the run (the hostile-input test in detectMarks.test.js holds it to that).
    const is = (re) => re.test(text); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    if (is(EMAIL) || is(URL)) return 'contact';
    if (is(PHONE_LABEL) || (!is(DATE) && (is(PHONE_INTL) || is(PHONE_LOCAL)))) return 'contact';
    if (is(IBAN)) return 'contact';
    if (is(POSTCODE_NL)) return 'address';
    const n = norm(text);
    if (n && terms.some((t) => t && n.includes(t))) return 'company';
    return null;
}

/**
 * Find the marks on one page.
 * @param {object} page       analyzePage() output
 * @param {object} opts
 * @param {string[]} opts.terms       normalised customer terms (user-given + derived)
 * @param {Map<number,string>} [opts.aiMarks]  object id → category the AI assigned
 * @returns {{ marks: Array<{id, category, text?}>, blocked: Array<{id, category, text?}> }}
 */
function detectMarks(page, { terms = [], aiMarks = new Map() } = {}) {
    const objs = page.objects;
    const pageArea = area(page.box);
    const texts = objs.filter((o) => o.kind === 'text' && o.text && o.text.trim());
    const marks = new Map();
    const mark = (o, category) => { if (!marks.has(o.id)) marks.set(o.id, { id: o.id, category, text: o.kind === 'text' ? o.text.trim() : undefined }); };

    // 1. Text that names the customer or a way to reach them.
    const company = [];
    for (const o of texts) {
        const reason = textReason(o.text, terms) || aiMarks.get(o.id) || null;
        if (!reason) continue;
        mark(o, reason === 'person' ? 'person' : reason);
        if (reason !== 'person') company.push(o);
    }

    // 2. A disclaimer paragraph goes as a whole once one of its lines names the customer:
    //    lines stacked tight in the same column.
    let grew = company.length > 0;
    while (grew) {
        grew = false;
        for (const o of texts) {
            if (marks.has(o.id)) continue;
            // Only real lines of prose at the paragraph's own size: never a grid label or a "-".
            if ((o.text.match(/\p{L}/gu) || []).length < 3) continue;
            const h = height(o.bbox);
            const hit = company.find((c) => {
                const gap = Math.max(c.bbox[1] - o.bbox[3], o.bbox[1] - c.bbox[3]);
                const sameColumn = Math.abs(o.bbox[0] - c.bbox[0]) < 5 * Math.max(c.size, 1)
                    || (o.bbox[0] >= c.bbox[0] - 2 && o.bbox[2] <= c.bbox[2] + 2);
                const sameSize = Math.abs(o.size - c.size) <= 0.25 * Math.max(c.size, 1);
                return gap <= 0.6 * h && sameColumn && sameSize && (LEGAL.test(o.text) || LEGAL.test(c.text));
            });
            if (hit) { mark(o, 'company'); company.push(o); grew = true; }
        }
    }

    // 3. The value printed right of a person-field label, on its own row. Column-header style
    //    fields (label on top, value under it) are left to the AI pass: guessing "the text
    //    below" picks up the next field's label.
    for (const label of texts) {
        if (!PERSON_LABEL.test(label.text.trim())) continue;
        const s = Math.max(label.size, 1);
        const lb = label.bbox;
        const sameRow = texts.filter((o) => o !== label
            && Math.min(o.bbox[3], lb[3]) - Math.max(o.bbox[1], lb[1]) >= 0.5 * Math.min(height(o.bbox), height(lb))
            && o.bbox[0] >= lb[2] - 1 && o.bbox[0] - lb[2] <= 8 * s)
            .sort((a, b) => a.bbox[0] - b.bbox[0]);
        const value = sameRow[0];
        if (value && !OTHER_LABEL.test(value.text.trim()) && !PERSON_LABEL.test(value.text.trim())
            && !EMPTY_VALUE.test(value.text) && value.text.trim().length <= 60) mark(value, 'person');
    }

    // 4. Logos: artwork right next to the company's text. Cluster the company text first so a
    //    footer and a header each get their own zone instead of one page-wide box.
    const clusters = [];
    for (const o of company) {
        const s = Math.max(o.size, 1);
        const c = clusters.find((cl) => Math.max(cl.box[0] - o.bbox[2], o.bbox[0] - cl.box[2], cl.box[1] - o.bbox[3], o.bbox[1] - cl.box[3]) <= 4 * s);
        if (c) { c.box = union(c.box, o.bbox); c.size = Math.max(c.size, s); } else clusters.push({ box: [...o.bbox], size: s });
    }
    const brand = new Set();
    for (const cl of clusters) {
        const s = cl.size;
        const zone = [cl.box[0] - 2.5 * s, cl.box[1] - 1.7 * s, cl.box[2] + 2.5 * s, cl.box[3] + 6 * s];
        for (const o of objs) {
            if (marks.has(o.id) || o.kind === 'text' && o.text.trim()) continue;
            if (insideShare(o.bbox, zone) <= 0.8 || area(o.bbox) > pageArea * 0.05) continue;
            if (o.kind === 'image') { mark(o, 'logo'); continue; }
            if (o.kind === 'text') { mark(o, 'logo'); continue; } // unreadable text inside the logo zone
            if (o.kind !== 'path') continue;
            const coloured = chroma(o.fill) > 25 || chroma(o.stroke) > 25;
            const dense = o.segments >= 20 && area(o.bbox) < pageArea * 0.02;
            if (!coloured && !dense) continue;
            mark(o, 'logo');
            for (const c of [o.fill, o.stroke]) if (chroma(c) > 25) brand.add(c.join(','));
        }
    }
    // The same brand colour elsewhere on the page is the same logo somewhere else (a report header).
    if (brand.size) {
        for (const o of objs) {
            if (o.kind !== 'path' || marks.has(o.id) || area(o.bbox) > pageArea * 0.05) continue;
            if ((o.fill && brand.has(o.fill.join(','))) || (o.stroke && brand.has(o.stroke.join(',')))) mark(o, 'logo');
        }
    }

    const all = [...marks.values()];
    return {
        marks: all.filter((m) => objs[m.id].removable),
        blocked: all.filter((m) => !objs[m.id].removable),
    };
}

module.exports = { detectMarks, deriveTerms, textReason, norm, PERSON_LABEL };
