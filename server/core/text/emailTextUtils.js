// @typecheck noImplicitAny
/**
 * Email/ticket text utilities — HTML→text cleanup, PII redaction, and the
 * KB-article merge prompt.
 *
 * Extracted so the Support Studio inbox (services/supportTranscript.js) and the
 * KB-ingest automation tools (integrations/kbIngestTools.js) share ONE
 * implementation. Pure functions: same input → same output, no I/O.
 *
 * NOTE: guard-service/app/services/pii_regex.py and pii_bsn.py are Python ports
 * of the PII logic below — keep them in step when changing these patterns.
 */

// ──────────────────────────────────────────────
// Stage 1: HTML → Clean Text
// Ported directly from n8n Code node "Code: Cleanup HTML/Email"
// ──────────────────────────────────────────────

/** @type {Record<string, string>} */
const NAMED_ENTITIES = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä',
    iacute: 'í', icirc: 'î', iuml: 'ï', oacute: 'ó', ocirc: 'ô', ouml: 'ö', uacute: 'ú', ucirc: 'û',
    uuml: 'ü', ccedil: 'ç', ntilde: 'ñ', szlig: 'ß', euro: '€', pound: '£', yen: '¥', copy: '©',
    reg: '®', trade: '™', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“',
    rdquo: '”', bull: '•', middot: '·', laquo: '«', raquo: '»', deg: '°',
};

/** @param {string} str */
function decodeHtmlEntities(str) {
    if (!str) return '';
    return str.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (/** @type {string} */ m, /** @type {string} */ body) => {
        if (body[0] === '#') {
            const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
            return valid ? String.fromCodePoint(cp) : m;
        }
        return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? m;
    });
}

// Elements whose content is never text, plus comments. Removed with indexOf
// scans (no backtracking), to the close tag or, when it is missing, to the end.
const DROP_BLOCKS = new Set(['head', 'script', 'style', 'title', 'noscript', 'template']);

/**
 * Index just past the `>` of the close tag `</name  >` found after `from`, or -1.
 * @param {string} s
 * @param {string} lower
 * @param {string} name
 * @param {number} from
 */
function findCloseEnd(s, lower, name, from) {
    const needle = `</${name}`;
    let at = lower.indexOf(needle, from);
    while (at !== -1) {
        let k = at + needle.length;
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a one-character whitespace test with no repetition
        while (k < s.length && /\s/.test(s[k])) k++;
        if (s[k] === '>') return k + 1;
        at = lower.indexOf(needle, at + needle.length);
    }
    return -1;
}

/** @param {string} s */
function dropBlocks(s) {
    const lower = s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));
    const out = [];
    let i = 0;
    for (;;) {
        const lt = s.indexOf('<', i);
        if (lt === -1) { out.push(s.slice(i)); break; }
        out.push(s.slice(i, lt));
        if (lower.startsWith('<!--', lt)) {
            const end = s.indexOf('-->', lt + 4);
            if (end === -1) break;
            i = end + 3;
            continue;
        }
        let k = lt + 1;
        while (k < s.length && /[a-z0-9]/.test(lower[k])) k++;
        const name = lower.slice(lt + 1, k);
        const boundary = k >= s.length || /[\s/>]/.test(s[k]);
        if (DROP_BLOCKS.has(name) && boundary) {
            const end = findCloseEnd(s, lower, name, k);
            if (end === -1) break;
            i = end;
            continue;
        }
        out.push('<');
        i = lt + 1;
    }
    return out.join('');
}

/** @param {unknown} input */
function stripHtmlToText(input) {
    let s = dropBlocks(String(input || ''));

    // Every tag pattern excludes '<' as well as '>', so a stray '<' ends the
    // scan and the whole function stays linear on hostile input.

    // Remove images entirely
    s = s.replace(/<img\b[^<>]*>/gi, '');

    // Links: keep link text only
    s = s.replace(/<\/?a\b[^<>]*>/gi, '');

    // Basic formatting
    s = s.replace(/<\/?(?:strong|b)\b[^<>]*>/gi, '**');
    s = s.replace(/<\/?(?:em|i)\b[^<>]*>/gi, '*');

    // Line breaks / blocks
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|tr|table|thead|tbody|tfoot)\s*>/gi, '\n');
    s = s.replace(/<(p|div|tr|table|thead|tbody|tfoot)\b[^<>]*>/gi, '');

    // Lists
    s = s.replace(/<li\b[^<>]*>/gi, '- ');
    s = s.replace(/<\/li\s*>/gi, '\n');
    s = s.replace(/<\/?(ul|ol)\b[^<>]*>/gi, '\n');

    // Remove remaining tags
    s = s.replace(/<\/?[a-zA-Z!][^<>]*>/g, '');

    // Decode entities + normalize whitespace
    s = decodeHtmlEntities(s);
    s = s.replace(/\r\n/g, '\n')
         .split('\n').map(l => l.trimEnd()).join('\n')
         .replace(/\n{3,}/g, '\n\n')
         .trim();

    return s;
}

/** @param {unknown} text */
function removeUrls(text) {
    let s = String(text || '');

    // Markdown image/link forms
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt) => (alt || '').trim());
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

    // <https://...>
    s = s.replace(/<https?:\/\/[^>]+>/gi, '');

    // Bare URLs
    s = s.replace(/https?:\/\/\S+/gi, '');

    // mailto:
    s = s.replace(/\bmailto:\S+/gi, '');

    // cleanup
    s = s.replace(/[ \t]+\n/g, '\n')
         .replace(/\n{3,}/g, '\n\n')
         .trim();

    return s;
}

/** @param {string} line */
function looksLikePercentEncodedJunk(line) {
    const l = String(line || '');
    const matches = l.match(/%[0-9A-Fa-f]{2}/g);
    const pctCount = matches ? matches.length : 0;

    const trackingHints =
        /(\bexcomponenttype\b|\bsignature\b|&data=|reserved=0|safelinks|originalsrc|target="_blank")/i.test(l);

    if (l.length > 180 && (pctCount >= 6 || trackingHints)) return true;
    if (pctCount >= 10) return true;
    return false;
}

/** @param {unknown} text */
function cleanEmailNoise(text) {
    let s = String(text || '');

    // Remove common leftover HTML attribute fragments
    s = s.replace(/\boriginalsrc\s*=\s*["'][^"']*["']/gi, '');
    s = s.replace(/\btarget\s*=\s*["'][^"']*["']/gi, '');
    s = s.replace(/\brel\s*=\s*["'][^"']*["']/gi, '');
    s = s.replace(/"\s*>\s*/g, ' ');
    s = s.replace(/<"\s*>\s*/g, ' ');
    s = s.replace(/[ \t]+\n/g, '\n');

    let lines = s.split('\n').map(l => l.replace(/\s+$/g, ''));

    // Cut off quoted threads / disclaimers / signature blocks
    const CUT_FROM_LINE_PATTERNS = [
        /^\*\*\s*(van|from)\s*:\s*\*\*/i,
        /^\s*(van|from)\s*:/i,
        /^\*\*\s*(verzonden|sent)\s*:\s*\*\*/i,
        /^\*\*\s*(aan|to)\s*:\s*\*\*/i,
        /^\*\*\s*onderwerp\s*:\s*\*\*/i,
        /^-----\s*original message\s*-----/i,
        /^-----\s*oorspronkelijk bericht\s*-----/i,
        /^on .* wrote\s*:/i,
        /^op .* schreef.*:/i,
        /^de informatie in deze e-?mail kan vertrouwelijk zijn/i,
        /^this (e-?mail|message) (and any attachments )?may contain confidential/i,
        /^\s*disclaimer\b/i,
        /^\s*met vriendelijke groet\s*,?\s*$/i,
        /^\s*vriendelijke groet\s*,?\s*$/i,
        /^\s*kind regards\s*,?\s*$/i,
        /^\s*best regards\s*,?\s*$/i,
        /^\s*regards\s*,?\s*$/i,
        /^\s*mijn werkdagen zijn\s*:/i,
        /^\s*my working days are\s*:/i,
        /^\s*cordialement\s*,?\s*$/i,
        /^\s*mit freundlichen grüßen\s*,?\s*$/i,
    ];

    let cutIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || '').trim();
        if (!line) continue;
        if (CUT_FROM_LINE_PATTERNS.some(re => re.test(line))) {
            cutIndex = i;
            break;
        }
    }
    if (cutIndex >= 0) lines = lines.slice(0, cutIndex);

    // Drop noisy lines
    const DROP_LINE_PATTERNS = [
        /^\s*\.{3,}\s*$/i,
        /^\s*-{3,}\s*$/i,
        /^\s*_{3,}\s*$/i,
        /^\s*is onderdeel van\s*$/i,
        /^\s*algemene voorwaarden\s*\|\s*$/i,
        /^\s*privacybeleid\s*$/i,
        /^\s*www\.\S+\s*$/i,
        /^\s*\d{2,4}\s*[--]\s*\d{2,4}\s*\d{2,4}\s*$/i,
    ];

    const cleaned = [];
    for (const rawLine of lines) {
        const line = (rawLine || '').trim();
        if (!line) { cleaned.push(''); continue; }
        if (DROP_LINE_PATTERNS.some(re => re.test(line))) continue;
        if (looksLikePercentEncodedJunk(line)) continue;
        cleaned.push(line);
    }

    let out = cleaned.join('\n');
    out = out.replace(/[ \t]+\n/g, '\n')
             .replace(/\n{3,}/g, '\n\n')
             .trim();

    return out;
}

/**
 * Stage 1: Full email cleanup pipeline.
 * HTML → Text → Remove URLs → Clean noise
 * @param {unknown} rawContent
 */
function cleanEmail(rawContent) {
    let text = stripHtmlToText(rawContent);
    text = removeUrls(text);
    text = cleanEmailNoise(text);
    return text;
}

// ──────────────────────────────────────────────
// Stage 2: PII Redaction
// ──────────────────────────────────────────────

const PII_PATTERNS = [
    { key: 'email', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
    { key: 'phone', regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{2,4}/g, replacement: '[PHONE]' },
    { key: 'ip', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP]' },
    { key: 'asset', regex: /\b[A-Z]{2,4}-\d{6,10}\b/g, replacement: '[ASSET]' },
];

// Dutch BSN 11-proof (elfproef).
// BSN is 9 digits; 9*d1 + 8*d2 + ... + 2*d8 - 1*d9 must be divisible by 11
// and the result must also be non-zero. This catches most false positives
// (order numbers, tracking codes) that happen to be 9 digits.
/** @param {string} digits */
function isValidBsn(digits) {
    if (!/^\d{9}$/.test(digits)) return false;
    const weights = [9, 8, 7, 6, 5, 4, 3, 2, -1];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += weights[i] * parseInt(digits[i], 10);
    return sum !== 0 && sum % 11 === 0;
}

// MAC match should be preceded (within 40 chars) by a word like MAC/hwaddr/ether
// — otherwise it's almost certainly an asset ID, which we already redact via [ASSET].
const MAC_ANCHOR_RE = /(?:mac|hwaddr|ether|bssid)[\s:=]{0,10}$/i;
const MAC_RE = /\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;
const BSN_CANDIDATE_RE = /\b\d{9}\b/g;

/**
 * @param {string} text
 * @param {RegExp} regex
 * @param {string} replacement
 * @param {(match: string, before: string) => boolean} accept
 */
function replaceWithContext(text, regex, replacement, accept) {
    let s = '';
    let lastIndex = 0;
    let count = 0;
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        if (accept(m[0], before)) {
            s += text.slice(lastIndex, m.index) + replacement;
            lastIndex = m.index + m[0].length;
            count++;
        }
    }
    s += text.slice(lastIndex);
    return { text: s, count };
}

/**
 * Redact PII and return { text, counts } where counts is keyed by PII class.
 * The `disable` array can suppress specific classes: e.g. ['mac','bsn'].
 * @param {unknown} text
 * @param {{ disable?: string[] }} [opts]
 */
function redactPIIWithCounts(text, { disable = [] } = {}) {
    const disabled = new Set((disable || []).map(s => String(s).toLowerCase()));
    let s = String(text || '');
    /** @type {Record<string, number>} */
    const counts = { email: 0, phone: 0, ip: 0, asset: 0, bsn: 0, mac: 0 };

    for (const { key, regex, replacement } of PII_PATTERNS) {
        if (disabled.has(key)) continue;
        regex.lastIndex = 0;
        s = s.replace(regex, () => { counts[key]++; return replacement; });
    }

    if (!disabled.has('bsn')) {
        const r = replaceWithContext(s, BSN_CANDIDATE_RE, '[ID]', (match) => isValidBsn(match));
        s = r.text;
        counts.bsn = r.count;
    }

    if (!disabled.has('mac')) {
        const r = replaceWithContext(s, MAC_RE, '[MAC]', (_m, before) => MAC_ANCHOR_RE.test(before));
        s = r.text;
        counts.mac = r.count;
    }

    return { text: s, counts };
}

/**
 * @param {unknown} text
 * @param {{ disable?: string[] }} [opts]
 */
function redactPII(text, opts) {
    return redactPIIWithCounts(text, opts).text;
}

const DEFAULT_MERGE_PROMPT = `You receive multiple existing knowledge base articles from the same category. Rewrite them into ONE comprehensive, deduplicated knowledge base article in **Markdown**.

Output rules (hard):
* Return only the rewritten Markdown.
* Use only \`##\` headers (no #, ###).
* Do not add sections that are not relevant; if something does not apply: omit the entire section.
* Do not invent facts that are not in the source articles. You may add general, safe clarification as long as it does not speculate.

Anti-duplication (hard):
* Each instruction or piece of knowledge appears exactly once in the entire document.
* If multiple source articles describe the same problem or solution: merge them into one entry, combining the most complete details.
* Remove redundant or overlapping content — keep the most informative version.
* Use consistent terminology throughout.

Writing style:
* Clear, concrete and task-oriented.
* Write completely impersonally (no person references).
* Add sub-steps within numbered lists where useful (e.g. 1.1, 1.2).
* Group related problems/solutions together logically.

Privacy & security (hard):
* Never include sensitive data or contact information (names, emails, phones, IPs, credentials, tokens, etc.).
* If such information appears: generalize or omit.

Structure (use only sections that are relevant):

## {Category Name} — Knowledge Base

## Overview
Brief summary of what this category covers.

## Common Problems & Solutions
For each distinct problem, use a ### sub-header:
### Problem description (concise)
**Problem:** ...
**Solution:** ...
**Steps:** ...

## Notes
Only if relevant.

IMPORTANT: Detect the language of the source articles and write in that SAME language.`;

module.exports = {
    cleanEmail,
    stripHtmlToText,
    redactPII,
    redactPIIWithCounts,
    isValidBsn,
    DEFAULT_MERGE_PROMPT,
};
