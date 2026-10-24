/**
 * webpageBindings — what the page ITSELF does.
 *
 * The column "Lets happen" of "Data & connections" answers a different question than the cards next to it. Those are about what the page READS; this is about
 * what it LETS HAPPEN. Until the `bf-*` vocabulary exists (W4) that surface is still empty — buttons, forms and the Agent block get their
 * elements there — and the column shows the existing bridge grants plus this one piece:
 *
 *   "DOES SOMETHING IN OWN CODE" — a static scan of ALL own text files
 *   of the page for `fetch(` and `XMLHttpRequest` to a host that does not belong to
 *   this installation. Such a call bypasses the automations: it is not in
 *   Runs, knows no approval and nobody sees it back. The card therefore
 *   offers "Make an automation of it", which scaffolds an `http_request`-automation with
 *   that same URL.
 *
 * ── THE SECOND READER: THE MARKINGS IN THE CODE TAB ─────────────────
 *
 * Since W4 this module reads the same files once more, with a different
 * question: on WHICH LINE stands a `bf-*` element? That is `scanBfElements`, and
 * the Code tab draws its Monaco markings with it.
 *
 * Why here and not in the frontend: a second regex in the client would be a second
 * reading of the same vocabulary — precisely the drift that
 * core/webpages/bfElements.js exists to prevent. The names and the pattern by which they are
 * recognized in markup therefore come from the registry; this file writes no tag name.
 *
 * The same three states apply: unreadable files give `scanned:false`, and
 * the Code tab MUST show that difference. A page without markings may not
 * look like a page without bindings.
 *
 * ── THE THIRD READER: THE USAGE INDEX ───────────────────────────────
 *
 * From those same markings comes `collectUses`: WHICH table, WHICH automation,
 * WHICH agent hangs on this page via an element? That is what the middle column
 * shows and what "Used by" will reverse.
 *
 * The families come from the registry (`binding.kind`), not from a list here —
 * this file writes no tag name and no family name. And the index counts only
 * what it CAN actually point to; everything around it comes back as
 * `unresolved`, with the reason:
 *
 *   built-at-runtime      the address stood there as an expression (`source={id}` in
 *                         JSX, `${…}` in a template). The page builds it
 *                         while it runs, so it cannot be read here;
 *   no-target             a required attribute is missing;
 *   page-binding-unknown  the element falls back to the binding of the PAGE, and that is
 *                         not there;
 *   page-binding-unreadable  idem, but the grants could not be READ. That is
 *                         a malfunction and not a choice of the author, so those two
 *                         may not come out for the same reason;
 *   unknown-fallback      the vocabulary knows a fallback for which this
 *                         module has no answer. Then something was added to the
 *                         registry without answering it here — and that may not silently drop an element from the index.
 *
 * An invented id is the ONLY answer that we may not give: `{id}` as a datatable id
 * looks exactly as real in a usage index as `tbl_1`, and afterwards belongs nowhere.
 *
 * ── "ALL FILES" IS NOT "THE THREE SLOTS" ───────────────────────────
 *
 * The three slots (`index.html` / `style.css` / `script.js`) are NOT the whole project, and for most
 * pages they are not even the main part. A react-mui project — and that is, since `integrations/webpageFramework.js`
 * (`DEFAULT_NEW_FRAMEWORK`), what EVERY NEW page becomes — writes its whole app as
 * EXTRA files under `src/` (`src/main.jsx`, `src/App.jsx`, …); the
 * html is generated at render time and the js slot stays empty. A vanilla project may
 * also put `modules/state.js` or `about.html` next to the slots.
 *
 * Whoever reads only `readAllSlots` here reads three empty strings and cheerfully reports "nothing
 * found" about code he has never seen. Therefore `readPageCode` also fetches the text extras, and they carry
 * their own path as `source` in the result, so that the author knows WHICH file to open.
 *
 * ── THIS IS A READING AID, NOT A SECURITY MEASURE ──────────────────
 *
 * Read that literally. The scan reads text; it executes nothing and does not understand
 * JavaScript. Everything below escapes it:
 *
 *   - `window[atob('ZmV0Y2g=')](url)`, `const f = fetch; f(url)`, a call from
 *     a `<script src>` elsewhere, `import()`, `<img src>`, `<form action>`,
 *     `navigator.sendBeacon`, a WebSocket;
 *   - a URL that comes from a variable (`fetch(endpoint)`);
 *   - a regex literal that the mini parser below reads as a string;
 *   - an extra file that the storage knows as BINARY (`isText` false): no text
 *     can be read from there, so what is in it stays out of view.
 *
 * That is why no consumer of this module may say "this page does nothing". The outcome has three
 * states and they MUST remain different:
 *
 *   scanned:false          the files were not readable — unknown;
 *   unresolved > 0         something was found that could not be traced;
 *   calls: [] + scanned    it was looked at and nothing was found — which still is
 *                          not the same as "nothing happens".
 *
 * What the parser loses comes back as `unresolved`, not as silence: the number of
 * `fetch(` / `new XMLHttpRequest` in the RAW text is compared with what is left in the
 * masked text, and the difference is reported as "not checkable". That counts a
 * commented-out `fetch(` as unknown — an annoying but safe direction: the other
 * direction is a real call that the scan silently makes disappear.
 *
 * ── WHAT "OURS" IS ─────────────────────────────────────────────────
 *
 * Only a relative URL and the explicitly configured own host count as
 * internal. Every other host is external, also if it could be from Bee Flow: a
 * false warning is annoying, a concealed outgoing call is a gap. There is deliberately no
 * `beeflow.nl` hard-coded in the list — on a self-hosted installation that is a
 * third party.
 */

'use strict';

const bfElements = require('./bfElements');
const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const storageStore = require('../../stores/storageStore');
const webpageStore = require('../../stores/webpageStore');
const log = require('../../telemetry/log');

/** Hoeveel externe oproepen we hoogstens uitschrijven; de rest wordt geteld. */
const MAX_REPORTED_CALLS = 20;

/**
 * How many marked lines we write out at most.
 *
 * Higher than MAX_REPORTED_CALLS because this has a DIFFERENT consumer: the
 * Code tab draws markings with it in the editor, and a page that has more
 * than this gets some of its lines unmarked. What falls away is
 * counted (`truncated`), so that the legend can say so instead of silently showing less.
 */
const MAX_REPORTED_MARKS = 300;

/** How far beyond a `<bf-…` we look for attributes. */
const MAX_OPEN_TAG_LENGTH = 4096;

/** Attributen uit de ruwe tekst van één openingstag. */
const RE_ATTRIBUTE = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

/**
 * A value that the page builds ON THE SPOT: `source={id}` (JSX) or a
 * `${…}` in a template literal. Something stands there, but not something that can be read here.
 *
 * This distinction must exist because the alternative is worse than silence: without this
 * check the text `{id}` lands as DATATABLE ID in the usage index, where it looks exactly as real as
 * `tbl_1` and never belongs to a table again. "Not readable" is an answer; an invented id is not.
 *
 * The check is BEGINS-WITH-`{`, not begins-and-ends: `run={`auto_${n}`}` yields
 * only one character when the tag is read (the attribute reader stops at the backtick), and precisely such a half-read
 * value is the one that otherwise slips through as id. A real id never begins with a brace.
 */
const RE_EXPRESSION_VALUE = /^\{|\$\{/;

function isExpressionValue(value) {
    return typeof value === 'string' && RE_EXPRESSION_VALUE.test(value.trim());
}

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
        try { hosts.add(new URL(raw.trim()).host.toLowerCase()); } catch (err) { log.debug('onbruikbare env → geen host', err); }
    }
    return hosts;
}

/**
 * The code of the page, with an EXPLICIT readability flag.
 *
 * `webpageStore.readAllSlots` gives empty strings back when the object storage is
 * not available — not distinguishable from a page without script. Therefore
 * `storageStore.isAvailable()` is asked for here separately: without storage the answer is "unknown",
 * never "empty".
 *
 * The same rule applies to the extra files (see the header): if listing or reading them
 * fails, then the WHOLE outcome is unreadable. A page of which we could not fetch half of
 * the files may not yield "nothing found".
 *
 * `css` has been included since W4. The call scan does nothing with it, but the
 * element scan must have seen EVERY text file that the editor shows: a slot that is
 * not read cannot yield a marking, and that is not distinguishable from "nothing is here".
 *
 * @returns {{readable:boolean, html:string, css:string, js:string, extras:Array<{path:string,text:string}>}}
 */
async function readPageCode(userId, webpageId) {
    const unreadable = { readable: false, html: '', css: '', js: '', extras: [] };
    try {
        if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) return unreadable;
    } catch { return unreadable; }
    let slots = null;
    try { slots = await webpageStore.readAllSlots(userId, webpageId); }
    catch { return unreadable; }
    if (!slots || typeof slots !== 'object') return unreadable;

    const extras = [];
    try {
        const metas = await webpageStore.listExtraFiles(webpageId);
        for (const meta of (Array.isArray(metas) ? metas : [])) {
            if (!meta || !meta.path) continue;
            // Binary extras (images, fonts) are not script source; they stand
            // as a blind spot in the header.
            if (!meta.isText) continue;
            const res = await webpageStore.readExtraFile({ webpageId, userId, path: meta.path });
            if (!res || typeof res.text !== 'string') return unreadable;
            extras.push({ path: String(meta.path), text: res.text });
        }
    } catch { return unreadable; }

    return {
        readable: true,
        html: String(slots.html || ''),
        css: String(slots.css || ''),
        js: String(slots.js || ''),
        extras,
    };
}

// ── mini-parser ───────────────────────────────────────────────────────

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
 */
function maskCode(text) {
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
 * Strip ONLY COMMENTS, character for character, keeping the length.
 *
 * `maskCode` above cannot do this: that one also masks string literals, and
 * precisely a string must stay — `el.innerHTML = '<bf-button run="a1">'`
 * is a real element that the page puts down. Conversely, commented-out
 * code is NOT a binding: the author saw a marked line with an address next to it
 * on code that is switched off, and the usage index claimed that the page uses that table.
 *
 * Length AND line endings stay equal, so that every index in the output still points
 * to exactly the same place in the input — the markings carry line numbers, so that is not negotiable.
 *
 * @param {string} text
 * @param {'html'|'css'|'js'|null} kind  language; anything else masks nothing, because
 *   guessing what is a comment in an unknown format can only strip too much —
 *   and counting an element too few is worse than counting one too many.
 */
function maskComments(text, kind) {
    const src = String(text || '');
    if (!src || !kind) return src;
    const blank = (from, to) => src.slice(from, to).replace(/[^\n]/g, ' ');
    let out = '';
    let i = 0;
    const n = src.length;

    if (kind === 'html') {
        while (i < n) {
            const start = src.indexOf('<!--', i);
            if (start === -1) { out += src.slice(i); break; }
            out += src.slice(i, start);
            let end = src.indexOf('-->', start + 4);
            end = end === -1 ? n : end + 3;
            out += blank(start, end);
            i = end;
        }
        return out;
    }

    // css and js share `/* … */`; js additionally has `//` and must spare strings,
    // otherwise a `//` in "https://…" cuts off the rest of the line.
    const stringAware = kind === 'js';
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        if (c === '/' && c2 === '*') {
            let j = src.indexOf('*/', i + 2);
            j = j === -1 ? n : j + 2;
            out += blank(i, j);
            i = j;
            continue;
        }
        if (stringAware && c === '/' && c2 === '/') {
            let j = i + 2;
            while (j < n && src[j] !== '\n') j++;
            out += blank(i, j);
            i = j;
            continue;
        }
        if (stringAware && (c === '"' || c === "'" || c === '`')) {
            const quote = c;
            let j = i + 1;
            while (j < n) {
                const d = src[j];
                if (d === '\\') { j += 2; continue; }
                if (d === quote) { j++; break; }
                if (quote !== '`' && d === '\n') break;
                j++;
            }
            out += src.slice(i, j);
            i = j;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** The language of a file, for `maskComments`. Unknown → do not mask. */
function commentKindOf(source, slot) {
    if (slot === 'html' || slot === 'css' || slot === 'js') return slot;
    const name = String(source || '').toLowerCase();
    if (/\.(html?|xhtml)$/.test(name)) return 'html';
    if (/\.css$/.test(name)) return 'css';
    if (/\.(m?jsx?|tsx?)$/.test(name)) return 'js';
    return null;
}

/** 1-gebaseerd regelnummer van een index in de gemaskeerde tekst. */
function lineAt(masked, index) {
    let line = 1;
    const upto = Math.min(index, masked.length);
    for (let i = 0; i < upto; i++) if (masked[i] === '\n') line++;
    return line;
}

/** The part of a literal that is fixed: everything before the first `${`. */
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
 */
function classifyUrl(prefix, dynamic, hosts) {
    const raw = String(prefix || '');
    if (!raw) return { verdict: 'unknown' };
    if (NON_NETWORK_SCHEMES.test(raw)) return { verdict: 'internal' };
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

/** Aantal treffers van `re` in `text` (re moet /g hebben). */
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
    const found = [];
    let unresolved = 0;
    let internal = 0;
    if (!text) return { found, unresolved, internal };

    const { masked, literals } = maskCode(text);

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

/** De inline `<script>`-blokken uit index.html, met hun regeloffset. */
function inlineScripts(html) {
    const out = [];
    if (!html) return out;
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
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

/** The three states of the scan in one form, so that the client does not have to guess. */
function codeSection(scan) {
    if (!scan) return { scanned: false, calls: [], externalCount: 0, unresolved: 0, internal: 0 };
    return { scanned: true, ...scan };
}

// ── de elementscan: WAAR staat een bf-element? ────────────────────────

/**
 * The raw attribute text of one opening tag, from `from` up to the `>`.
 *
 * Quotes count, so that a `>` IN an attribute value does not cut the tag short early.
 * An unclosed tag stops at the next `<` or at the upper bound — nothing is repaired
 * here, only read.
 */
function openTagText(src, from) {
    const stop = Math.min(src.length, from + MAX_OPEN_TAG_LENGTH);
    let quote = null;
    for (let i = from; i < stop; i++) {
        const c = src[i];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === '\'') { quote = c; continue; }
        if (c === '>' || c === '<') return src.slice(from, i);
    }
    return src.slice(from, stop);
}

/** De geschreven attributen van een openingstag, op kleine letter. */
function parseAttributes(text) {
    const out = {};
    const re = new RegExp(RE_ATTRIBUTE.source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = String(m[1]).toLowerCase();
        // The first spelling wins; a second time the same attribute is what
        // the browser also ignores.
        if (out[name] === undefined) out[name] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return out;
}

/**
 * The value as the author WROTE it for the attribute that carries the binding.
 * Via the registry, because that attribute may also stand under an older
 * spelling (`datatable` beside `source`).
 */
function writtenBindingValue(tag, attrs, from) {
    for (const [name, value] of Object.entries(attrs)) {
        if (bfElements.canonicalAttribute(tag, name) === from) return value;
    }
    return null;
}

/**
 * One file: where does a `bf-*` element stand, and what does it bind?
 *
 * The pattern comes from the registry (`BF_TAG_SCAN`) — this file knows no
 * single tag name and no own idea of what an element looks like.
 *
 * @param {string} text
 * @param {string} source  the name that the author sees ('index.html', 'src/App.jsx')
 * @param {string|null} slot  'html'|'css'|'js' for one of the three slots, otherwise null
 */
function scanBfElementsIn(text, source, slot) {
    const marks = [];
    const unknown = [];
    if (!text) return { marks, total: 0, unknown };

    // Commented-out code is not a binding. `maskComments` keeps length
    // and line endings equal, so every index below still points to the same
    // place in the ORIGINAL — and the attributes are also read from the masked
    // text, so that an element half inside a comment does not yield an address after all.
    text = maskComments(text, commentKindOf(source, slot));

    const re = new RegExp(bfElements.BF_TAG_SCAN.source, 'gi');
    let m;
    let total = 0;
    // Regelnummer meelopend bijhouden: de treffers komen in oplopende volgorde,
    // dus dit is één keer door de tekst in plaats van één keer per treffer.
    let cursor = 0;
    let line = 1;
    while ((m = re.exec(text)) !== null) {
        total++;
        for (let i = cursor; i < m.index; i++) if (text[i] === '\n') line++;
        cursor = m.index;

        const tag = String(m[1] || '').toLowerCase();
        const attrs = parseAttributes(openTagText(text, m.index + m[0].length));
        const info = bfElements.inspectBfElement(tag, attrs);
        const def = bfElements.getBfElement(tag);
        if (!info.known && !unknown.includes(tag)) unknown.push(tag);
        // Was there an EXPRESSION in the place of the address? Then the address
        // is not readable — and that is something other than a missing attribute,
        // because the author DID write it down. So `missing` stays empty
        // and `targetId` becomes `null`, with `dynamic` as the distinction.
        const dynamic = info.binding
            ? isExpressionValue(writtenBindingValue(tag, attrs, info.binding.from))
            : false;
        marks.push({
            source,
            slot,
            line,
            tag,
            known: info.known,
            // The FAMILY is what the element hangs on, not what it is called: the
            // Code tab tints on it. It comes from the DEFINITION, not from the
            // filled-in binding: a `<bf-table>` without `source` is still
            // a table element, and setting the family to `null` because the author
            // forgot the address would make "I do not know WHICH table" indistinguishable
            // from "this hangs on no table at all".
            // `null` therefore means: this KIND of element binds nothing.
            family: (def && def.binding) ? def.binding.kind : null,
            targetId: (info.binding && !dynamic) ? info.binding.id : null,
            dynamic,
            fallback: (def && def.binding) ? (def.binding.fallback || null) : null,
            // `null` for an unknown element — "nothing is missing" is a
            // statement that you cannot make about it (see missingAttributes).
            missing: info.missing,
            reason: info.reason,
        });
    }
    return { marks, total, unknown };
}

/**
 * Where do the `bf-*` elements of this page stand? Pure: pass the text along.
 *
 * Every text file that the editor can open is read — the three slots and
 * the extras. A react-mui page has its elements standing in `src/*.jsx`,
 * and an element that is not read yields no marking; that would not be
 * distinguishable from a page without bindings.
 *
 * @returns {{marks:Array, counts:{total:number,known:number,unknown:number},
 *            unknownTags:string[], truncated:number}}
 */
function scanBfElements({ html = '', css = '', js = '', extras = [] } = {}) {
    const parts = [
        scanBfElementsIn(html, 'index.html', 'html'),
        scanBfElementsIn(css, 'style.css', 'css'),
        scanBfElementsIn(js, 'script.js', 'js'),
    ];
    for (const file of (Array.isArray(extras) ? extras : [])) {
        if (!file || typeof file.text !== 'string') continue;
        parts.push(scanBfElementsIn(file.text, String(file.path || 'extra file'), null));
    }

    const all = [];
    const unknownTags = [];
    let total = 0;
    for (const part of parts) {
        total += part.total;
        for (const mark of part.marks) all.push(mark);
        for (const tag of part.unknown) if (!unknownTags.includes(tag)) unknownTags.push(tag);
    }

    const marks = all.slice(0, MAX_REPORTED_MARKS);
    return {
        marks,
        counts: {
            total,
            known: all.filter(mk => mk.known).length,
            unknown: all.filter(mk => !mk.known).length,
        },
        unknownTags,
        // What could no longer fit is counted and not hidden.
        truncated: Math.max(0, all.length - marks.length),
    };
}

/** Dezelfde drie standen als `codeSection`, om dezelfde reden. */
function elementsSection(scan) {
    if (!scan) {
        return {
            scanned: false,
            marks: [],
            counts: { total: 0, known: 0, unknown: 0 },
            unknownTags: [],
            truncated: 0,
        };
    }
    return { scanned: true, ...scan };
}


// ── de usage-index: welke tabel, welke automatisering, welke agent ───────────

/**
 * The families that the vocabulary knows, from the registry.
 *
 * Deliberately not `['datatable','automation','agent']` here: that would be a
 * second list, and a family added to it would then silently drop
 * out of the index instead of appearing in it as an empty list.
 */
function bindingKinds() {
    const kinds = [];
    for (const def of bfElements.BF_ELEMENTS) {
        if (def.binding && !kinds.includes(def.binding.kind)) kinds.push(def.binding.kind);
    }
    return kinds;
}

/** Every fallback that the vocabulary knows — for which the caller must have an answer. */
function declaredFallbacks() {
    const out = [];
    for (const def of bfElements.BF_ELEMENTS) {
        const fb = def.binding && def.binding.fallback;
        if (fb && !out.includes(fb)) out.push(fb);
    }
    return out;
}

/**
 * The answer to one fallback, by FOLLOWING THE PATH from the registry.
 *
 * A fallback is a path in the bridge grants (`bridge_grants.agent`), so the
 * answer really is there. Following this path instead of setting a little table
 * "which fallback means what" beside it: such a little table would give the answer of the first
 * to a SECOND fallback, and that is a wrong id — the one answer that we may not give.
 *
 * The grants carry their id as `<something>Id` (`agentId`, `datatableId`). If this
 * function finds none, the answer is `null` and the element remains
 * `unresolved`: not determinable, never guessed.
 */
function fallbackIdFromGrants(path, grants) {
    const parts = String(path || '').split('.');
    if (parts.shift() !== 'bridge_grants' || !parts.length) return null;
    let node = grants;
    for (const part of parts) {
        if (!node || typeof node !== 'object') return null;
        node = node[part];
    }
    if (typeof node === 'string') return node || null;
    if (!node || typeof node !== 'object') return null;
    const key = Object.keys(node).find(k => /Id$/.test(k) && typeof node[k] === 'string' && node[k]);
    return key ? node[key] : null;
}

function emptyTargets() {
    const out = {};
    for (const kind of bindingKinds()) out[kind] = [];
    return out;
}

/**
 * What hangs via a `bf-*` ELEMENT on this page?
 *
 * Two things that must stay apart, and that is the whole reason this function exists alongside the markings:
 *
 *   targets     what we CAN point to — per family a list with, per id,
 *               the places where it is used;
 *   unresolved  an element that does bind something, but of which it is not
 *               determinable WHAT. That is not "nothing": a page with three buttons of which
 *               the automation id is built on the spot is not a page without automations.
 *
 * @param {object|null} scan          the result of `scanBfElements`
 * @param {object} args
 * @param {Object<string,string|null>} args.fallbackIds  answer per fallback from
 *   the registry (`bridge_grants.agent` → the agent of the page). A fallback
 *   that is missing here is `unknown-fallback` — never a silent omission.
 */
/**
 * "This field could not be read" — as value, not as absence.
 *
 * `null` means here "the page has none"; this means "we do not know". A Symbol,
 * so that no real id can collide with it.
 */
const FALLBACK_UNREADABLE = Symbol('fallback-unreadable');

function collectUses(scan, { fallbackIds = {} } = {}) {
    const targets = emptyTargets();
    const perKind = new Map();
    const unresolved = [];

    for (const mark of (scan && Array.isArray(scan.marks) ? scan.marks : [])) {
        // An unknown element is already in `unknownTags`; there is nothing to bind
        // from it because we do not know what it would bind.
        if (!mark.known || !mark.family) continue;
        const where = { tag: mark.tag, source: mark.source, line: mark.line };
        const miss = (reason) => unresolved.push({
            ...where,
            kind: mark.family,
            reason,
            missing: mark.missing,
            dynamic: !!mark.dynamic,
        });

        let id = mark.targetId;
        let fromPage = false;
        if (!id && mark.fallback) {
            if (!Object.prototype.hasOwnProperty.call(fallbackIds, mark.fallback)) {
                miss('unknown-fallback');
                continue;
            }
            id = fallbackIds[mark.fallback];
            if (id === FALLBACK_UNREADABLE) { miss('page-binding-unreadable'); continue; }
            fromPage = true;
        }
        if (!id) {
            miss(mark.dynamic ? 'built-at-runtime' : (mark.fallback ? 'page-binding-unknown' : 'no-target'));
            continue;
        }

        if (!perKind.has(mark.family)) perKind.set(mark.family, new Map());
        const byId = perKind.get(mark.family);
        const entry = byId.get(id) || { id, fromPage: false, elements: [] };
        // "Did this id (also) come from the page itself?" — that distinction the column
        // should show: an agent that is named nowhere hangs on the PAGE and disappears
        // as soon as that binding is detached.
        entry.fromPage = entry.fromPage || fromPage;
        entry.elements.push(where);
        byId.set(id, entry);
    }

    for (const [kind, byId] of perKind) {
        if (!targets[kind]) targets[kind] = [];
        for (const entry of byId.values()) targets[kind].push({ ...entry, count: entry.elements.length });
    }
    return { targets, unresolved };
}

/** Dezelfde drie standen als `codeSection`, om dezelfde reden. */
function usesSection(scan, opts) {
    if (!scan) return { scanned: false, targets: emptyTargets(), unresolved: [] };
    return { scanned: true, ...collectUses(scan, opts) };
}

/**
 * The model behind the column "Lets happen".
 *
 * @param {object} args
 * @param {string} args.webpageId
 * @param {string} args.userId  the OWNER (the route is owner-only, just like
 *                              the grants beside it: this shows code content)
 */
async function describePageActions({ webpageId, userId }) {
    const code = await readPageCode(userId, webpageId);
    const scan = code.readable ? scanOutboundCalls(code) : null;
    const elements = code.readable ? scanBfElements(code) : null;

    let grants = null;
    let agentId = null;
    let agentKnown = true;
    try {
        grants = await bridgeGrants.getBridgeGrants(webpageId);
        agentId = grants && grants.agent && grants.agent.agentId ? grants.agent.agentId : null;
    } catch {
        // Unreadable grants are not "no agent": that difference is carried by `known`,
        // so that the card can stay silent instead of asserting.
        agentKnown = false;
    }

    // The answer to EVERY fallback that the vocabulary knows — today one: a
    // `<bf-agent>` without its own id runs the agent of the PAGE. The list comes
    // from the registry and the answer from the grants themselves, so a second
    // fallback gets its own answer automatically instead of that of the
    // first. Unreadable grants give `null`, and that is something other than "there is
    // none": the element then remains `unresolved` instead of disappearing.
    const fallbackIds = {};
    for (const path of declaredFallbacks()) {
        // FALLBACK_UNREADABLE, not `null`: both of them yielded `null`, and then
        // "this page has no agent bound" got the same reason as "the
        // grants could not be read". The comment above promised that
        // distinction; within `uses` it did not exist.
        fallbackIds[path] = agentKnown ? fallbackIdFromGrants(path, grants) : FALLBACK_UNREADABLE;
    }

    return {
        code: codeSection(scan),
        // Where the `bf-*` elements stand, per file and per line. The Code tab
        // draws its markings with this; `scanned:false` means there that the
        // legend must say that the marking could not be computed.
        elements: elementsSection(elements),
        // WELKE tabel, WELKE automatisering, WELKE agent — per familie, met de plekken
        // erbij. Dit is wat de middenkolom toont en wat de usage-index omdraait.
        uses: usesSection(elements, { fallbackIds }),
        // The elements THEMSELVES stand in `elements.marks`, each with its `tag`; these
        // two fields only say what the column may claim about that kind. They used to exist as
        // "we do not know this yet" placeholders; since `<bf-form>` and `<bf-agent>` really exist that is no longer true,
        // and `scanned` now carries the difference between "none" and "not looked at".
        forms: { supported: true, scanned: elements !== null },
        // The Agent block is INTERNAL-ONLY: `ai.ask` is deliberately kept out of the anonymous
        // bridge (services/publicShareBridge.js knows only /ai/chat and /ai/stream), so
        // a public share never runs it. The card says so
        // instead of letting the block silently do nothing.
        agent: {
            known: agentKnown,
            agentId: agentKnown ? agentId : null,
            supported: true,
            internalOnly: true,
            scanned: elements !== null,
        },
    };
}

module.exports = {
    describePageActions,
    scanOutboundCalls,
    scanBfElements,
    collectUses,
    readPageCode,
    // Voor de tests én voor W4, dat op dezelfde maskeerder verder bouwt.
    maskCode,
    maskComments,
    FALLBACK_UNREADABLE,
    classifyUrl,
    inlineScripts,
};
