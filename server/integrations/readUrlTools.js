/**
 * read_url: read the full text of ONE web page the user pasted.
 *
 * agent_search answers from summaries and snippets, so a paragraph deep in a long
 * page (a regulation, a standard) never reaches the model. browse_web needs a
 * browser backend and cuts its answer at 8000 characters. read_url is the
 * light middle: a plain GET through the SSRF-guarded fetch, the page cleaned to
 * text, up to ~60k characters back, or with `find` the passages around each hit.
 *
 * Pure HTTP, no JavaScript rendering: a page that only exists after scripts ran
 * comes back thin, and the result says so, which is the model's cue to use browse_web.
 */

'use strict';

const { safeFetch, isPrivateAddressError } = require('../utils/ssrfGuard');
const { stripHtml, PAGE_FETCH_TIMEOUT_MS, PAGE_BYTE_CAP } = require('./nodeSearchTools');

const MAX_TEXT_CHARS = 60000;
const PASSAGE_RADIUS = 1000; // ~2000 characters around each hit
const MAX_PASSAGES = 10;
const MAX_FIND_LENGTH = 200;

const READ_URL_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'read_url',
            description: `Read the full text of one web page by URL (plain HTTP fetch, no browser). Use it whenever the user's message contains a URL, BEFORE answering, and do not answer from search snippets instead.

For a long page (a regulation, a standard, a manual) pass \`find\` with the article, paragraph number or phrase you need (for example "38A"): you then get the passages around every hit instead of only the start of the page.

Limits: no JavaScript rendering, no logins or clicks, no PDF. For interactive or JS-only pages, and for PDFs, use browse_web. To DISCOVER pages when you have no URL, use agent_search.`,
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'Absolute http(s) URL of the page to read.',
                    },
                    find: {
                        type: 'string',
                        description: 'Optional text to look for (case-insensitive), e.g. a paragraph number "38A" or a phrase. Returns the passages around each hit.',
                    },
                },
                required: ['url'],
            },
        },
    },
];

function isReadUrlTool(toolName) {
    return toolName === 'read_url';
}

function err(message) {
    return JSON.stringify({ error: message });
}

function decodeEntitiesMore(t) {
    return t
        .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch (_) { return ' '; } })
        .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (_) { return ' '; } });
}

function extractTitle(html) {
    const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (!m) return '';
    return decodeEntitiesMore(stripHtml(m[1])).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function htmlToText(html) {
    // Keep block structure as line breaks: stripHtml turns every tag into a space.
    const withBreaks = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|pre)>/gi, '\n');
    return decodeEntitiesMore(stripHtml(withBreaks))
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Passages (~2*PASSAGE_RADIUS chars) around each case-insensitive hit, overlapping ones merged. */
function findPassages(text, find) {
    const hay = text.toLowerCase();
    const needle = find.toLowerCase();
    const hits = [];
    let from = 0;
    while (true) {
        const i = hay.indexOf(needle, from);
        if (i === -1) break;
        hits.push(i);
        from = i + needle.length;
    }
    const ranges = [];
    for (const i of hits) {
        const start = Math.max(0, i - PASSAGE_RADIUS);
        const end = Math.min(text.length, i + needle.length + PASSAGE_RADIUS);
        const last = ranges[ranges.length - 1];
        if (last && start <= last.end) {
            last.end = Math.max(last.end, end);
            last.hits += 1;
        } else {
            ranges.push({ start, end, hits: 1 });
        }
    }
    return {
        totalMatches: hits.length,
        passages: ranges.slice(0, MAX_PASSAGES).map(r => ({
            offset: r.start,
            hits: r.hits,
            text: text.slice(r.start, r.end),
        })),
        passagesOmitted: Math.max(0, ranges.length - MAX_PASSAGES),
    };
}

async function readBody(res) {
    const reader = res.body?.getReader();
    if (!reader) return '';
    let decoder;
    const cs = /charset=([\w-]+)/i.exec(res.headers.get('content-type') || '');
    try { decoder = new TextDecoder(cs ? cs[1] : 'utf-8'); } catch (_) { decoder = new TextDecoder('utf-8'); }
    let out = '';
    let bytes = 0;
    let capped = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        out += decoder.decode(value, { stream: true });
        if (bytes >= PAGE_BYTE_CAP) {
            capped = true;
            try { await reader.cancel(); } catch (_) { /* already closed */ }
            break;
        }
    }
    out += decoder.decode();
    return { html: out, capped };
}

/**
 * @param {string} toolName
 * @param {{url?: string, find?: string}} args
 * @param {{fetchImpl?: Function}} [opts] fetchImpl: test seam, defaults to the SSRF-guarded safeFetch
 * @returns {Promise<string>} JSON string
 */
async function executeReadUrlTool(toolName, args = {}, opts = {}) {
    if (!isReadUrlTool(toolName)) return err(`Unknown tool: ${toolName}`);
    const fetchImpl = opts.fetchImpl || safeFetch;
    const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
    if (!rawUrl) return err('url is required.');
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) { return err('url is not a valid absolute URL.'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return err('Only http and https URLs can be read.');
    const find = typeof args.find === 'string' ? args.find.trim().slice(0, MAX_FIND_LENGTH) : '';

    let res;
    try {
        res = await fetchImpl(parsed.href, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; BeeFlowReadBot/1.0; +https://beeflow.nl)',
                Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
        });
    } catch (e) {
        if (isPrivateAddressError(e)) return err('Refused: this address is private or internal and cannot be read.');
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return err(`The page did not respond within ${PAGE_FETCH_TIMEOUT_MS / 1000} seconds.`);
        return err(`Could not fetch the page: ${e?.cause?.code || e?.message || 'network error'}.`);
    }
    if (!res.ok) return err(`The page answered HTTP ${res.status}. If it needs a login or JavaScript, try browse_web.`);

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isHtml = ct.includes('html') || ct.includes('xhtml');
    const isText = ct.startsWith('text/');
    if (!isHtml && !isText) {
        return err(`Content type "${ct || 'unknown'}" cannot be read as text by read_url (PDFs and other documents included). Use browse_web for a PDF.`);
    }

    let body;
    try { body = await readBody(res); } catch (e) { return err(`Reading the page failed: ${e?.message || 'stream error'}.`); }
    const { html, capped } = body;
    const title = isHtml ? extractTitle(html) : '';
    const text = isHtml ? htmlToText(html) : html.trim();
    const totalChars = text.length;

    const out = { url: res.url || parsed.href, title, totalChars };
    if (find) {
        const { totalMatches, passages, passagesOmitted } = findPassages(text, find);
        out.find = find;
        out.totalMatches = totalMatches;
        if (totalMatches > 0) {
            out.matches = passages;
            if (passagesOmitted) out.passagesOmitted = passagesOmitted;
            out.truncated = capped;
            if (capped) out.note = 'The page was larger than the 1.5 MB read limit; hits beyond it are not included.';
            return JSON.stringify(out);
        }
        out.note = `No hits for "${find}" in the page text; the start of the page follows instead.`;
    }
    out.truncated = capped || totalChars > MAX_TEXT_CHARS;
    out.text = text.slice(0, MAX_TEXT_CHARS);
    if (out.truncated) {
        out.note = (out.note ? out.note + ' ' : '') + `Text cut at ${MAX_TEXT_CHARS} characters of ${totalChars}${capped ? ' (the page itself exceeded the read limit)' : ''}. Call read_url again with \`find\` to reach a specific part.`;
    }
    if (totalChars < 200) {
        out.note = (out.note ? out.note + ' ' : '') + 'Very little text: the page may be rendered by JavaScript; try browse_web.';
    }
    return JSON.stringify(out);
}

module.exports = {
    READ_URL_TOOLS,
    isReadUrlTool,
    executeReadUrlTool,
    findPassages,
    MAX_TEXT_CHARS,
};
