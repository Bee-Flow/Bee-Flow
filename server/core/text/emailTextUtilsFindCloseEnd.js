// @typecheck strict

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

// MAC match should be preceded (within 40 chars) by a word like MAC/hwaddr/ether
// — otherwise it's almost certainly an asset ID, which we already redact via [ASSET].
const MAC_ANCHOR_RE = /(?:mac|hwaddr|ether|bssid)[\s:=]{0,10}$/i;

const MAC_RE = /\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g;

const BSN_CANDIDATE_RE = /\b\d{9}\b/g;

module.exports = { decodeHtmlEntities, DROP_BLOCKS, findCloseEnd, looksLikePercentEncodedJunk, MAC_ANCHOR_RE, MAC_RE, BSN_CANDIDATE_RE };
