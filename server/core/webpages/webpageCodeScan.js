// @typecheck

const { bestEffort } = require('../../utils/bestEffort');

/** Hoeveel externe oproepen we hoogstens uitschrijven; de rest wordt geteld. */
const MAX_REPORTED_CALLS = 20;

/** Schemes that are not a network call to a foreign host. */
const NON_NETWORK_SCHEMES = /^(data|blob|javascript|mailto|tel|about):/i;

/** Extra files that are read as markup: only their inline scripts. */
const MARKUP_FILE = /\.(html?|svg|xml)$/i;

/** Methodenamen die een `.open(` tot een XHR-oproep maken. */
const XHR_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** Placeholder around the index number of a string literal in the masked text. */
const MARK = '\u0001';

const RE_FETCH = /\bfetch\s*\(/g;

const RE_NEW_XHR = /\bnew\s+XMLHttpRequest\b/g;

const RE_LITERAL_AFTER_PAREN = new RegExp(`^\\s*${MARK}(\\d+)${MARK}`);

const RE_XHR_OPEN = new RegExp(`\\.open\\s*\\(\\s*${MARK}(\\d+)${MARK}\\s*,\\s*${MARK}(\\d+)${MARK}`, 'g');

/**
 * The host of this installation, from the same environment variables as the
 * share URL builder (`services/webpageSnapshot.js`). No default: without configuration there is no host
 * of which we are CERTAIN that it is ours, and unknown should narrow here to "external".
 */
function ownHosts() {
    const hosts = new Set();
    for (const raw of [process.env.PUBLIC_SHARE_BASE_URL, process.env.PUBLIC_APP_URL]) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        try { hosts.add(new URL(raw.trim()).host.toLowerCase()); } catch (err) { bestEffort('core/webpages/webpageCodeScan:ownHosts', err); /* onbruikbare env → geen host */ }
    }
    return hosts;
}

/**
 * Replace comments and string literals with placeholders, so that a `//` or
 * a quote IN a URL does not confuse the scan.
 *
 * Line numbers remain correct: comments are replaced character for character
 * with spaces while newlines are kept, and a multi-line template gets its newlines
 * after the placeholder. Columns do shift — we do not use those.
 *
 * Regex literals are NOT recognized (`/['"]/` is read as a string start).
 * That is the known blind spot; the safety net in `scanSource` turns it into
 * `unresolved` instead of silence.
 * @param {string} text
 */
function maskCode(text) {
    /** @type {{ value: string; template: boolean; hasSubstitution: boolean; }[]} */
    const literals = [];
    let masked = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        const c2 = text[i + 1];
        if (c === '/' && c2 === '/') {
            let j = i + 2;
            while (j < n && text[j] !== '\n') j++;
            masked += ' '.repeat(j - i);
            i = j;
            continue;
        }
        if (c === '/' && c2 === '*') {
            let j = i + 2;
            while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
            j = Math.min(n, j + 2);
            masked += text.slice(i, j).replace(/[^\n]/g, ' ');
            i = j;
            continue;
        }
        if (c === '"' || c === '\'' || c === '`') {
            const quote = c;
            let j = i + 1;
            let value = '';
            let hasSubstitution = false;
            while (j < n) {
                const d = text[j];
                if (d === '\\') { value += text[j + 1] === undefined ? '' : text[j + 1]; j += 2; continue; }
                if (d === quote) { j++; break; }
                // An unterminated ordinary string does not run on over a line ending — otherwise
                // one stray quote would swallow the rest.
                if (quote !== '`' && d === '\n') break;
                if (quote === '`' && d === '$' && text[j + 1] === '{') { hasSubstitution = true; value += '${'; j += 2; continue; }
                value += d;
                j++;
            }
            const raw = text.slice(i, j);
            literals.push({ value, template: quote === '`', hasSubstitution });
            masked += `${MARK}${literals.length - 1}${MARK}` + '\n'.repeat((raw.match(/\n/g) || []).length);
            i = j;
            continue;
        }
        masked += c;
        i++;
    }
    return { masked, literals };
}

/**
 * 1-gebaseerd regelnummer van een index in de gemaskeerde tekst.
 * @param {string} masked
 * @param {number} index
 */
function lineAt(masked, index) {
    let line = 1;
    const upto = Math.min(index, masked.length);
    for (let i = 0; i < upto; i++) if (masked[i] === '\n') line++;
    return line;
}

/**
 * The part of a literal that is fixed: everything before the first `${`.
 * @param {{ value: string; template: boolean; hasSubstitution: boolean; }} literal
 */
function fixedPrefixOf(literal) {
    const raw = String(literal.value || '');
    if (!literal.hasSubstitution) return { text: raw.trim(), dynamic: false };
    const cut = raw.indexOf('${');
    return { text: (cut === -1 ? raw : raw.slice(0, cut)).trim(), dynamic: true };
}

/**
 * Where does this URL go?
 *
 * @returns {{verdict:'internal'|'external'|'unknown', host?:string}}
 *   'unknown' means "not determinable" and counts as `unresolved` — never
 *   as internal, because then the call would disappear from view.
 * @param {string} prefix
 * @param {boolean} dynamic
 * @param {Set<string>} hosts
 */
function classifyUrl(prefix, dynamic, hosts) {
    const raw = String(prefix || '');
    if (!raw) return { verdict: 'unknown' };
    if (NON_NETWORK_SCHEMES.test(raw)) return { verdict: 'internal' };
    /** @type {string | null} */
    let host = null;
    if (/^https?:\/\//i.test(raw)) {
        try { host = new URL(raw).host.toLowerCase(); } catch { return { verdict: 'unknown' }; }
    } else if (raw.startsWith('//')) {
        try { host = new URL(`https:${raw}`).host.toLowerCase(); } catch { return { verdict: 'unknown' }; }
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        // A scheme that we do not know (ws:, chrome-extension:, …).
        return { verdict: 'unknown' };
    } else {
        // Relative. Only a prefix that already fixes the origin is certainly
        // internal; `${base}/x` (empty prefix) or `api${x}` is not.
        if (raw.startsWith('/') && !raw.startsWith('//')) return { verdict: 'internal' };
        if (raw.startsWith('./') || raw.startsWith('../')) return { verdict: 'internal' };
        return dynamic ? { verdict: 'unknown' } : { verdict: 'internal' };
    }
    if (!host) return { verdict: 'unknown' };
    return hosts.has(host) ? { verdict: 'internal' } : { verdict: 'external', host };
}

/**
 * Aantal treffers van `re` in `text` (re moet /g hebben).
 * @param {string} text
 * @param {RegExp} re
 */
function countRaw(text, re) {
    return (String(text).match(re) || []).length;
}

/**
 * Scan één fragment.
 *
 * @param {string} text
 * @param {string} source        'script.js' | 'index.html'
 * @param {number} lineOffset    regels die vóór dit fragment stonden
 * @param {Set<string>} hosts    eigen hosts
 */
function scanSource(text, source, lineOffset, hosts) {
    /**
     * @type {{ kind: string; method: string | null; 
    // What stands there, not what we make of it: the author must recognize
    // his own line. A template keeps an ellipsis as its tail.
    url: string; 
    // The part that is REALLY fixed, without the ellipsis: that is what may end up
    // in a scaffolded automation. `dynamic` says alongside it that
    // the page built the rest of the address on the spot, so that nobody
    // regards that automation as complete.
    urlPrefix: string; dynamic: boolean; host: string | undefined; source: string; line: number; }[]}
     */
    const found = [];
    let unresolved = 0;
    let internal = 0;
    if (!text) return { found, unresolved, internal };

    const { masked, literals } = maskCode(text);

    /**
     * @param {string} kind
     * @param {string | null} method
     * @param {number} literalIndex
     * @param {number} at
     */
    const push = (kind, method, literalIndex, at) => {
        const literal = literals[literalIndex];
        if (!literal) { unresolved++; return; }
        const { text: prefix, dynamic } = fixedPrefixOf(literal);
        const verdict = classifyUrl(prefix, dynamic, hosts);
        if (verdict.verdict === 'internal') { internal++; return; }
        if (verdict.verdict === 'unknown') { unresolved++; return; }
        found.push({
            kind,
            method,
            // What stands there, not what we make of it: the author must recognize
            // his own line. A template keeps an ellipsis as its tail.
            url: dynamic ? `${prefix}…` : prefix,
            // The part that is REALLY fixed, without the ellipsis: that is what may end up
            // in a scaffolded automation. `dynamic` says alongside it that
            // the page built the rest of the address on the spot, so that nobody
            // regards that automation as complete.
            urlPrefix: prefix,
            dynamic,
            host: verdict.host,
            source,
            line: lineOffset + lineAt(masked, at),
        });
    };

    // fetch(<literal>) — everything that does not begin directly with a literal is an
    // expression and thus not traceable. The method stays null: `{method:
    // 'POST'}` stands in the second argument and is NOT guessed here.
    const fetchRe = new RegExp(RE_FETCH.source, 'g');
    /** @type {RegExpExecArray | null} */
    let m;
    let fetchSeen = 0;
    while ((m = fetchRe.exec(masked)) !== null) {
        fetchSeen++;
        const lit = RE_LITERAL_AFTER_PAREN.exec(masked.slice(m.index + m[0].length));
        if (lit) push('fetch', null, Number(lit[1]), m.index);
        else unresolved++;
    }

    // XMLHttpRequest: only `.open('METHOD', '<url>')` yields an address.
    // Every `new XMLHttpRequest` without such a pair counts as not traceable —
    // otherwise an XHR with a variable URL would disappear.
    const xhrInstances = countRaw(masked, RE_NEW_XHR);
    let xhrResolved = 0;
    if (/\bXMLHttpRequest\b/.test(masked)) {
        const openRe = new RegExp(RE_XHR_OPEN.source, 'g');
        /** @type {RegExpExecArray | null} */
        let o;
        while ((o = openRe.exec(masked)) !== null) {
            const method = String(literals[Number(o[1])]?.value || '').trim().toUpperCase();
            if (!XHR_METHODS.has(method)) continue;
            xhrResolved++;
            push('xhr', method, Number(o[2]), o.index);
        }
    }
    if (xhrInstances > xhrResolved) unresolved += xhrInstances - xhrResolved;

    // Safety net: if the RAW text contains more than the parser has seen as code,
    // then it sat in a comment, in a string, or in something that the
    // parser misread. That difference is not distinguishable, so it goes to
    // `unresolved` — "not checked", never "nothing found".
    unresolved += Math.max(0, countRaw(text, RE_FETCH) - fetchSeen);
    unresolved += Math.max(0, countRaw(text, RE_NEW_XHR) - xhrInstances);

    return { found, unresolved, internal };
}

/**
 * De inline `<script>`-blokken uit index.html, met hun regeloffset.
 * @param {string} html
 */
function inlineScripts(html) {
    /** @type {{ text: string; lineOffset: number; }[]} */
    const out = [];
    if (!html) return out;
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    /** @type {RegExpExecArray | null} */
    let m;
    while ((m = re.exec(html)) !== null) {
        // A `<script src=…>` has no content that we can read; its
        // behaviour falls outside the scan (and the card says so).
        if (/\bsrc\s*=/i.test(m[1] || '')) continue;
        const before = html.slice(0, m.index + m[0].indexOf('>') + 1);
        out.push({ text: m[2] || '', lineOffset: (before.match(/\n/g) || []).length });
    }
    return out;
}

/**
 * De scan zelf. Puur: geen opslag, geen databank — geef `{html, js}` mee.
 *
 * @returns {{calls:Array, externalCount:number, unresolved:number, internal:number}}
 */
function scanOutboundCalls({ html = '', js = '', extras = [] } = {}) {
    const hosts = ownHosts();
    const results = [scanSource(js, 'script.js', 0, hosts)];
    for (const frag of inlineScripts(html)) {
        results.push(scanSource(frag.text, 'index.html', frag.lineOffset, hosts));
    }
    // Extra files carry their own path as source. A markup file yields
    // only its inline `<script>` blocks — just like `index.html` above
    // and with the same limit; all other text files are read as script
    // source, including `.json` or `.css`: if a `fetch(` stands in there that the parser
    // cannot place, then `unresolved` is the right answer and silence the wrong one.
    for (const file of (Array.isArray(extras) ? extras : [])) {
        if (!file || typeof file.text !== 'string') continue;
        const source = String(file.path || 'extra file');
        if (MARKUP_FILE.test(source)) {
            for (const frag of inlineScripts(file.text)) {
                results.push(scanSource(frag.text, source, frag.lineOffset, hosts));
            }
        } else {
            results.push(scanSource(file.text, source, 0, hosts));
        }
    }

    let unresolved = 0;
    let internal = 0;
    const byKey = new Map();
    for (const r of results) {
        unresolved += r.unresolved;
        internal += r.internal;
        for (const call of r.found) {
            const key = `${call.kind}|${call.method || ''}|${call.url}`;
            const prev = byKey.get(key);
            if (prev) { prev.occurrences++; continue; }
            byKey.set(key, { ...call, occurrences: 1 });
        }
    }

    const all = [...byKey.values()];
    return {
        calls: all.slice(0, MAX_REPORTED_CALLS),
        externalCount: all.length,
        unresolved,
        internal,
    };
}

module.exports = { maskCode, classifyUrl, inlineScripts, scanOutboundCalls };
