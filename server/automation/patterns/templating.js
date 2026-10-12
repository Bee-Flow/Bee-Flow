// @typecheck
'use strict';
/**
 * Templating: turn a mail subject or file name into a template whose variable
 * parts are placeholders, then group templates that differ only in those parts.
 *
 *   maskText          regex masks: <url> <email> <domain> <date> <id> <n>
 *   subjectTemplate   strips Re:/Fw:/AW:/Fwd: prefixes and [EXT] tags, then masks
 *   filenameStem      drops the path, the extension and copy markers, then masks
 *   clusterTemplates  Drain-lite: a prefix tree on the first token, positional
 *                     similarity for equal lengths, token Jaccard otherwise
 *   maskNames         person/org masking for the FEW cluster templates of a scan,
 *                     one batched detectPii call; deterministic fallback when the
 *                     guard is absent
 *
 * Accents and non-Latin letters are kept: every class here is Unicode-aware
 * (\p{L}/\p{N}), never [a-z0-9]. JS `\b` is ASCII-only, so boundaries are
 * written as lookarounds on \p{L}\p{N}.
 *
 * Pure: no I/O. detectPii is injected by the caller.
 */

const crypto = require('crypto');

// ── Regex masks ─────────────────────────────────────────────────────────────

const NB = '(?<![\\p{L}\\p{N}])';   // not preceded by a letter or digit
const NA = '(?![\\p{L}\\p{N}])';    // not followed by a letter or digit

// Any scheme, not just http(s): ftp://, smb://, sftp:// name a host as well.
const URL_RE = /(?:[a-z][a-z0-9+.-]{1,15}:\/\/|www\.)[^\s<>"']+/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;

// A bare host in running text ("Invoice from acme.com", "acme.sharepoint.com/
// sites/x"): a real domain is an organisation identifier and never reaches an
// evidence card. Groups: host, top-level label, an optional path (then it is
// a link). A file extension is not a domain: "report.pdf" stays as it is.
const BARE_HOST_RE = /(?<![\p{L}\p{N}@._%+-])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(\p{L}{2,24}))(?![\p{L}\p{N}@-]|\.[\p{L}\p{N}])((?:\/[^\s<>"']*)?)/gu;
const FILE_EXTENSIONS = new Set(`pdf doc docx xls xlsx xlsm csv ppt pptx txt rtf odt ods odp png jpg jpeg gif svg webp heic
tif tiff zip rar gz tgz tar json xml html htm md eml msg ics vcf mp3 mp4 mov wav avi mkv key pages numbers js ts py sh bak tmp log`.split(/\s+/));
// File names use dots as separators ("Weekly.Report"), so there a host needs a
// top-level label that really is one: any two letters (country codes) or a
// common generic one.
const COMMON_TLDS = new Set('com net org info biz io ai app dev cloud online shop site tech xyz eu gov edu mil int name'.split(' '));

/**
 * Replace every bare host (with its path, when it has one) by what `replacer`
 * returns for it. `strictTld` is for file names, see COMMON_TLDS.
 * @param {string} text
 * @param {(host: string, path: string) => string} replacer
 * @param {{ strictTld?: boolean }} [opts]
 * @returns {string}
 */
function replaceBareDomains(text, replacer, { strictTld = false } = {}) {
    return String(text ?? '').replace(BARE_HOST_RE, (whole, host, tld, path) => {
        const t = String(tld).toLowerCase();
        if (FILE_EXTENSIONS.has(t)) return whole;
        if (strictTld && !(t.length === 2 || COMMON_TLDS.has(t))) return whole;
        return replacer(host, path || '');
    });
}

// Long month names (EN, NL, DE, FR) are unambiguous on their own: a monthly
// "Expenses October" / "Declaratie oktober" must template to one thing.
const MONTHS_LONG = [
    'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'januari', 'februari', 'maart', 'mei', 'juni', 'juli', 'augustus', 'oktober',
    'januar', 'februar', 'märz', 'oktober', 'dezember',
    'janvier', 'février', 'mars', 'avril', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];
// Short forms only count next to a number ("3 Oct", "Oct 2026"): "may", "mar"
// and "jan" are ordinary words or names on their own.
const MONTHS_SHORT = 'jan|feb|mar|mrt|apr|may|jun|jul|aug|sep|sept|oct|okt|nov|dec';

const DATE_RES = [
    new RegExp(`${NB}\\d{4}-\\d{1,2}-\\d{1,2}(?:[T ]\\d{1,2}:\\d{2}(?::\\d{2})?(?:Z|[+-]\\d{2}:?\\d{2})?)?${NA}`, 'gu'),
    new RegExp(`${NB}\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}${NA}`, 'gu'),
    new RegExp(`${NB}\\d{1,2}\\s+(?:${MONTHS_SHORT})\\.?(?:\\s+\\d{4})?${NA}`, 'giu'),
    new RegExp(`${NB}(?:${MONTHS_SHORT})\\.?\\s+\\d{1,4}(?:,\\s*\\d{4})?${NA}`, 'giu'),
    new RegExp(`${NB}(?:\\d{1,2}\\s+)?(?:${MONTHS_LONG.join('|')})(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?(?:,?\\s+\\d{4})?${NA}`, 'giu'),
    new RegExp(`${NB}(?:week|wk|w)\\s*\\.?\\s*\\d{1,2}${NA}`, 'giu'),
    new RegExp(`${NB}q[1-4](?:\\s*[-/]?\\s*\\d{4})?${NA}`, 'giu'),
    new RegExp(`${NB}\\d{1,2}:\\d{2}(?::\\d{2})?${NA}`, 'gu'),
    new RegExp(`${NB}(?:19|20)\\d{2}${NA}`, 'gu'),
];

const ID_RES = [
    // "#4711", "nr. 4711" style references.
    new RegExp(`#\\s?[\\p{L}\\p{N}-]*\\p{N}[\\p{L}\\p{N}-]*`, 'gu'),
    // Anything mixing letters and digits: INV-2026-0042, AB12CD, 3f9a2c…
    new RegExp(`${NB}(?=[\\p{L}\\p{N}_-]*\\p{N})(?=[\\p{L}\\p{N}_-]*\\p{L})[\\p{L}\\p{N}][\\p{L}\\p{N}_-]*${NA}`, 'gu'),
];

const NUMBER_RE = new RegExp(`${NB}[-+]?\\d+(?:[.,]\\d+)*${NA}`, 'gu');

// A placeholder this module (or a source) already wrote: <n>, <*>, <domain:d9>.
// A closed list: "<pieter>" in a raw subject is text, not a placeholder.
const PLACEHOLDER_SRC = '<(?:\\*|n|date|id|email|url|name|org|domain(?::[A-Za-z0-9_-]{1,24})?)>';
const PLACEHOLDER_RE = new RegExp(`^${PLACEHOLDER_SRC}$`);
const PLACEHOLDER_SPLIT_RE = new RegExp(`(${PLACEHOLDER_SRC})`);

/**
 * Mask the variable parts of a short text. Case and accents are kept, and
 * placeholders already in the text stay whole: masking twice is a no-op, and
 * a pseudonym like <domain:d9> must not have its digit masked.
 * @param {string} text
 * @returns {string}
 */
function maskText(text) {
    const parts = String(text ?? '').split(PLACEHOLDER_SPLIT_RE);
    return parts.map((p, i) => (i % 2 ? ` ${p} ` : maskPlain(p))).join(' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} text */
function maskPlain(text) {
    let s = text;
    s = s.replace(URL_RE, ' <url> ');
    s = s.replace(EMAIL_RE, ' <email> ');
    s = replaceBareDomains(s, (_host, path) => (path ? ' <url> ' : ' <domain> '));
    // Numeric dates and week/quarter labels first (Q3 and wk41 would otherwise
    // read as ids), then ids (INV-2026-0042 must not lose its year to a date
    // mask), then the remaining date forms.
    for (const re of DATE_RES.slice(0, 2)) s = s.replace(re, ' <date> ');
    for (const re of DATE_RES.slice(5, 7)) s = s.replace(re, ' <date> ');
    for (const re of ID_RES) s = s.replace(re, ' <id> ');
    for (const re of [...DATE_RES.slice(2, 5), ...DATE_RES.slice(7)]) s = s.replace(re, ' <date> ');
    s = s.replace(NUMBER_RE, ' <n> ');
    return s.replace(/\s+/g, ' ').trim();
}

const CONTACT_WORDS = { url: 'a link', email: 'an email address', domain: 'a website' };

/**
 * Hide only what reaches a person or an organisation directly: links of any
 * scheme, e-mail addresses and bare hosts. Numbers and words stay, so a
 * sentence stays a sentence. For text the model wrote (a title, a build
 * prompt) before it is kept: `words` reads "an email address" where a
 * template would say <email>.
 * @param {string} text
 * @param {{ words?: boolean }} [opts]
 * @returns {string}
 */
function maskContacts(text, { words = false } = {}) {
    const ph = (k) => (words ? CONTACT_WORDS[k] : `<${k}>`);
    let s = String(text ?? '');
    s = s.replace(URL_RE, ph('url'));
    s = s.replace(EMAIL_RE, ph('email'));
    return replaceBareDomains(s, (_host, path) => ph(path ? 'url' : 'domain'));
}

const SUBJECT_PREFIX_RE = /^\s*(?:(?:re|fw|fwd|aw|wg|antw|tr|sv|vs|rv|doorst)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/iu;
const SUBJECT_TAG_RE = /^\s*\[(?:ext|external|extern|externe?|spam|suspicious)\]\s*/iu;

/**
 * @param {string} subject
 * @returns {string}
 */
function subjectTemplate(subject) {
    let s = String(subject ?? '');
    // Prefixes and tags can interleave ("[EXT] RE: FW: …"): strip until stable.
    for (let i = 0; i < 5; i++) {
        const next = s.replace(SUBJECT_TAG_RE, '').replace(SUBJECT_PREFIX_RE, '');
        if (next === s) break;
        s = next;
    }
    return maskText(s);
}

/**
 * @param {string} name
 * @returns {string}
 */
function filenameStem(name) {
    let s = String(name ?? '');
    s = s.split(/[\\/]/).pop() || '';
    s = s.replace(/\.[\p{L}\p{N}]{1,5}$/u, '');
    s = s.replace(/\s*(?:\(\d+\)|-\s*(?:copy|kopie|kopie van)|\bcopy\b|\bkopie\b)\s*$/iu, '');
    // Dates before the separators go: 2026-10-05 must stay one <date>. So do
    // hosts: once the dots are spaces, "acme.nl" is two harmless-looking words.
    for (const re of DATE_RES.slice(0, 2)) s = s.replace(re, ' <date> ');
    s = replaceBareDomains(s, () => ' <domain> ', { strictTld: true });
    s = s.replace(/[_.\-]+/g, ' ');
    return maskText(s);
}

/**
 * Stable 12-hex id of a template (case-insensitive).
 * @param {string} template
 * @returns {string}
 */
function templateIdOf(template) {
    const norm = String(template ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_sha1 -- a short content fingerprint for de-duplicating templates, not a security hash
    return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

/**
 * Tokens for comparison: lower-cased words with outer punctuation stripped;
 * placeholders stay whole.
 * @param {string} template
 * @returns {string[]}
 */
function tokenize(template) {
    const out = [];
    for (const raw of String(template ?? '').split(/\s+/)) {
        if (!raw) continue;
        if (PLACEHOLDER_RE.test(raw)) { out.push(raw); continue; }
        const w = raw.toLowerCase().replace(/^[^\p{L}\p{N}<]+|[^\p{L}\p{N}>]+$/gu, '');
        if (w) out.push(w);
    }
    return out;
}

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function jaccard(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    if (A.size === 0 && B.size === 0) return 1;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
}

const isPlaceholder = (t) => PLACEHOLDER_RE.test(t);

/** Positional similarity for equal-length token lists (Drain's simSeq). */
function positionalSim(a, b) {
    let same = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i] || (isPlaceholder(a[i]) && isPlaceholder(b[i]))) same++;
    }
    return same / a.length;
}

/**
 * Group near-identical templates. Drain-lite: the first token (a placeholder
 * counts as a wildcard) is the tree level; within a node, equal-length lists
 * merge when their positional similarity is high enough and differing
 * positions become `<*>`; unequal lengths merge on token Jaccard.
 *
 * @param {string[]} templates
 * @param {{ simThreshold?: number, jaccardThreshold?: number }} [opts]
 * @returns {{ clusters: Array<{ template: string, templateId: string, members: number[] }>, assignment: number[] }}
 */
function clusterTemplates(templates, opts = {}) {
    const simThreshold = opts.simThreshold ?? 0.6;
    const jaccardThreshold = opts.jaccardThreshold ?? 0.75;
    /** @type {Map<string, Array<{ tokens: string[], display: string[], members: number[] }>>} */
    const tree = new Map();
    /** @type {Array<{ tokens: string[], display: string[], members: number[] }>} */
    const all = [];
    const assignment = new Array(templates.length).fill(-1);

    templates.forEach((tpl, idx) => {
        const display = String(tpl ?? '').split(/\s+/).filter(Boolean);
        const tokens = tokenize(tpl);
        if (tokens.length === 0) return;
        const key = isPlaceholder(tokens[0]) ? '*' : tokens[0];
        const node = tree.get(key) || [];
        tree.set(key, node);
        let match = null;
        for (const c of node) {
            if (c.tokens.length === tokens.length) {
                const sim = positionalSim(c.tokens, tokens);
                // At least one fixed token has to survive besides the key.
                const diffs = Math.round((1 - sim) * tokens.length);
                if (sim >= simThreshold && diffs <= Math.max(1, Math.floor(tokens.length * 0.4))) { match = c; break; }
            } else if (Math.abs(c.tokens.length - tokens.length) <= 2 && jaccard(c.tokens, tokens) >= jaccardThreshold) {
                match = c;
                break;
            }
        }
        if (!match) {
            match = { tokens, display: display.length === tokens.length ? display : tokens.slice(), members: [] };
            node.push(match);
            all.push(match);
        } else if (match.tokens.length === tokens.length) {
            for (let i = 0; i < tokens.length; i++) {
                if (match.tokens[i] === tokens[i]) continue;
                const bothPh = isPlaceholder(match.tokens[i]) && isPlaceholder(tokens[i]);
                const ph = bothPh && match.tokens[i] === tokens[i] ? tokens[i] : '<*>';
                match.tokens[i] = ph;
                match.display[i] = ph;
            }
        }
        match.members.push(idx);
    });

    const clusters = all.map((c) => {
        const template = c.display.join(' ');
        return { template, templateId: templateIdOf(template), members: c.members };
    });
    clusters.forEach((c, ci) => { for (const m of c.members) assignment[m] = ci; });
    return { clusters, assignment };
}

// ── Person / organisation masking ───────────────────────────────────────────

// Words the deterministic fallback may keep. Everything else, and every
// capitalised word that does not open the text, becomes <name>. Deliberately
// small and free of words that double as first names (mark, will, bill, jan).
const COMMON_WORDS = new Set(`
a an the and or of to in on at for from by with without about as is are was be new your our my you we it this that these those
not no yes all any per via up out re fw fwd
weekly daily monthly yearly annual quarterly week month day today tomorrow update updates report reports summary overview
invoice invoices receipt receipts payment payments order orders quote quotation offer statement expense expenses claim claims
reminder request requests approval approved rejected pending confirmation confirmed booking reservation ticket tickets issue issues
meeting meetings agenda notes minutes action actions items item follow followup follow-up call review planning plan sprint standup
project projects team status task tasks backlog release deploy deployment build sales marketing finance hr it support
customer customers client clients supplier suppliers vendor contract contracts proposal document documents file files folder
sheet spreadsheet data export import backup log logs newsletter digest notification alert alerts subscription renewal account
password security access shared share invitation invite welcome thanks thank please urgent important fyi asap draft final version
timesheet hours salary payroll budget forecast kpi kpis btw vat tax pdf csv xlsx doc docx
voor van de het een en of op in met naar bij uit over aan als is zijn was wordt nieuw nieuwe uw onze mijn je jij wij
wekelijks wekelijkse dagelijks dagelijkse maandelijks maandelijkse jaarlijks rapport rapportage overzicht samenvatting
factuur facturen betaling betalingen bestelling offerte declaratie declaraties bon bonnen herinnering aanvraag verzoek goedkeuring
bevestiging boeking afspraak vergadering overleg notulen actiepunten agenda planning taak taken klant klanten leverancier
contract document bestand bestanden map gedeeld uitnodiging welkom bedankt graag dringend concept definitief urenregistratie
uren salaris begroting nieuwsbrief melding storing
`.split(/\s+/).filter(Boolean));

const CATEGORY_PLACEHOLDER = { Person: '<name>', Organization: '<org>', Email: '<email>', URL: '<url>' };

/** Deterministic fallback: no guard, so mask anything that could be a name. */
function fallbackMask(template) {
    const parts = String(template ?? '').split(/\s+/).filter(Boolean);
    let first = true;
    const out = parts.map((raw) => {
        if (isPlaceholder(raw)) { first = false; return raw; }
        const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (!word) return raw;
        const lower = word.toLowerCase();
        const capitalised = /^\p{Lu}/u.test(word);
        const initial = first;
        first = false;
        if (!COMMON_WORDS.has(lower) || (capitalised && !initial)) return raw.replace(word, '<name>');
        return raw;
    });
    return collapseRepeats(out.join(' '));
}

/** "<name> <name>" → "<name>": a full name is one placeholder, not two. */
function collapseRepeats(s) {
    return s.replace(/(<(?:name|org)>)(?:\s+\1)+/g, '$1');
}

/**
 * Mask person and organisation names in the scan's cluster templates.
 * ONE detectPii call for the whole batch (texts joined by newlines, offsets
 * mapped back per line). When detectPii is missing, returns null, or throws,
 * every template goes through the deterministic fallback instead: a missing
 * or degraded guard must never mean names reach an evidence card.
 * Signature of detectPii: core/privacy/piiDetection.detectPii(text,
 * enabledCategories, confidenceThreshold, opts) → null when the guard is not
 * installed, { entities: [{ category, offset, length }], degraded? } otherwise.
 *
 * @param {string[]} templates
 * @param {{ detectPii?: ((text: string, categories?: any, threshold?: any, opts?: any) => Promise<any>) | null }} [opts]
 * @returns {Promise<{ templates: string[], method: 'guard'|'fallback', categories: string[] }>}
 */
async function maskNames(templates, opts = {}) {
    const list = (templates || []).map((t) => String(t ?? '').replace(/\n/g, ' '));
    if (list.length === 0) return { templates: [], method: 'guard', categories: [] };
    let result = null;
    if (typeof opts.detectPii === 'function') {
        try {
            result = await opts.detectPii(list.join('\n'), null, undefined, { priority: 'bulk' });
        } catch {
            result = null;
        }
    }
    // A degraded scan (guard unreachable, circuit open, GLiNER tier down) comes
    // back with an empty or regex-only entity list: "no names found" would be
    // a lie, so it takes the fallback like a missing guard.
    if (!result || !Array.isArray(result.entities) || result.degraded) {
        return { templates: list.map(fallbackMask), method: 'fallback', categories: [] };
    }
    // Line start offsets in the joined text.
    const starts = [];
    let pos = 0;
    for (const t of list) { starts.push(pos); pos += t.length + 1; }
    /** @type {Array<Array<{ start: number, end: number, ph: string }>>} */
    const perLine = list.map(() => []);
    const categories = new Set();
    for (const e of result.entities) {
        const off = Number(e?.offset);
        const len = Number(e?.length);
        if (!Number.isFinite(off) || !Number.isFinite(len) || len <= 0) continue;
        let line = starts.length - 1;
        while (line > 0 && starts[line] > off) line--;
        const start = off - starts[line];
        const end = Math.min(start + len, list[line].length);
        if (start < 0 || start >= list[line].length) continue;
        categories.add(String(e.category));
        perLine[line].push({ start, end, ph: CATEGORY_PLACEHOLDER[e.category] || '<id>' });
    }
    const masked = list.map((t, i) => {
        const spans = perLine[i].sort((a, b) => b.start - a.start);
        let s = t;
        let lastStart = Infinity;
        for (const sp of spans) {
            if (sp.end > lastStart) continue; // overlapping span: keep the later one
            s = s.slice(0, sp.start) + sp.ph + s.slice(sp.end);
            lastStart = sp.start;
        }
        return collapseRepeats(s.replace(/\s+/g, ' ').trim());
    });
    return { templates: masked, method: 'guard', categories: [...categories].sort() };
}

module.exports = {
    maskText,
    subjectTemplate,
    filenameStem,
    templateIdOf,
    tokenize,
    jaccard,
    clusterTemplates,
    maskNames,
    fallbackMask,
    replaceBareDomains,
    maskContacts,
    COMMON_WORDS,
};
