/**
 * Parameters a code step declares, read from the JSDoc on `main`.
 *
 * The standard JavaScript way, so editors understand it and a model writes it
 * without being taught a house format:
 *
 *   /**
 *    * Adds VAT to an amount.
 *    *
 *    * @param {object} inputs
 *    * @param {number} inputs.amount - The amount without VAT
 *    * @param {number} [inputs.vatRate=21] - VAT percentage
 *    * @param {'EUR'|'USD'} [inputs.currency='EUR'] - Currency of the amount
 *    * @returns {{ total: number }} The amount including VAT
 *    *\/
 *   async function main(inputs, ctx) { ... }
 *
 * Also read: `@param {number} amount - ...` (no prefix), any first-parameter
 * name as the prefix, and defaults written in a destructured first parameter
 * (`function main({ amount, vatRate = 21 }, ctx)`) when the JSDoc gives none.
 * A tag this parser cannot read is skipped, never guessed: the input stays
 * editable as an undeclared one.
 */

'use strict';

const ACRONYMS = new Set([
    'vat', 'id', 'ids', 'url', 'urls', 'uri', 'api', 'iban', 'bic', 'pdf', 'csv', 'json', 'html', 'http', 'https',
    'uuid', 'sku', 'kvk', 'btw', 'ip', 'xml', 'eur', 'usd', 'gbp', 'sms', 'cc', 'bcc', 'ai', 'crm', 'erp', 'nl', 'en',
    'utc', 'iso', 'ocr', 'faq', 'kpi', 'hr', 'po', 'vpn', 'dns', 'smtp', 'imap',
]);

const NAME_RE = /^[A-Za-z_$][\w$]*$/;

/** "vatRate" -> "VAT rate", "customer_email" -> "Customer email", "invoiceID" -> "Invoice ID". */
function humanise(name) {
    const words = String(name || '')
        .replace(/[_\-\s]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (!words.length) return String(name || '');
    return words.map((w, i) => {
        const lower = w.toLowerCase();
        if (ACRONYMS.has(lower)) return lower.toUpperCase();
        return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    }).join(' ');
}

/** Split on `sep` at nesting depth 0, outside quotes. */
function splitTopLevel(text, sep) {
    const out = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            cur += ch;
            if (ch === '\\') { cur += text[++i] || ''; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
        if ('<({['.includes(ch)) depth++;
        if ('>)}]'.includes(ch)) depth = Math.max(0, depth - 1);
        if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function unquote(s) {
    const m = /^(['"`])([\s\S]*)\1$/.exec(s);
    return m ? m[2].replace(/\\(['"`\\])/g, '$1') : null;
}

const SIMPLE_TYPES = {
    string: { type: 'string' },
    number: { type: 'number' },
    float: { type: 'number' },
    double: { type: 'number' },
    integer: { type: 'integer' },
    int: { type: 'integer' },
    boolean: { type: 'boolean' },
    bool: { type: 'boolean' },
    object: { type: 'object' },
    array: { type: 'array' },
    date: { type: 'string', format: 'date' },
    datetime: { type: 'string', format: 'datetime' },
    'date-time': { type: 'string', format: 'datetime' },
    email: { type: 'string', format: 'email' },
    url: { type: 'string', format: 'url' },
    uri: { type: 'string', format: 'url' },
};

/**
 * A JSDoc type expression as the parameter shape the form renders:
 * `{ type, format?, items?, enum? }`. Unknown types read as string.
 */
function parseType(raw) {
    let text = String(raw || '').trim();
    let optional = false;
    if (text.endsWith('=')) { optional = true; text = text.slice(0, -1).trim(); }
    text = text.replace(/^[?!]/, '').trim();
    const parts = splitTopLevel(text.replace(/^\((.*)\)$/, '$1'), '|')
        .filter((p) => !/^(null|undefined|void)$/i.test(p));
    if (!parts.length) return { type: 'string', optional };

    const strings = parts.map(unquote);
    if (strings.every((s) => s !== null)) return { type: 'string', enum: strings, optional };
    if (parts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) {
        const nums = parts.map(Number);
        return { type: nums.every(Number.isInteger) ? 'integer' : 'number', enum: nums, optional };
    }

    const first = parts[0];
    if (first.startsWith('{')) return { type: 'object', optional };
    const arr = /^(.+)\[\]$/.exec(first) || /^Array\.?<(.+)>$/i.exec(first);
    if (arr) return { type: 'array', items: { type: parseType(arr[1]).type }, optional };
    if (/^Array$/i.test(first)) return { type: 'array', optional };
    if (/^Object\.?<.*>$/i.test(first) || /^Record<.*>$/.test(first)) return { type: 'object', optional };
    const simple = SIMPLE_TYPES[first] || SIMPLE_TYPES[first.toLowerCase()];
    if (simple) return { ...simple, optional };
    return { type: 'string', optional };
}

/** A default value written in JSDoc (`[vatRate=21]`), JSON-ish. */
function parseDefault(raw) {
    const text = String(raw).trim();
    if (text === '') return undefined;
    const quoted = unquote(text);
    if (quoted !== null) return quoted;
    try { return JSON.parse(text); } catch (_) { /* try the single-quoted form below */ }
    try {
        return JSON.parse(text.replace(/'((?:[^'\\]|\\.)*)'/g, (_, s) => JSON.stringify(s.replace(/\\'/g, "'"))));
    } catch (_) {
        return text;
    }
}

/** Bring a default in line with the declared type where that is unambiguous. */
function typedDefault(value, shape) {
    if (value === undefined) return undefined;
    if ((shape.type === 'number' || shape.type === 'integer') && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    if (shape.type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
    return value;
}

/** Read a balanced `{...}` or `[...]` group at the start of `text`. */
function readGroup(text, open, close) {
    if (text[0] !== open) return null;
    let depth = 0;
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === open) depth++;
        if (ch === close) {
            depth--;
            if (depth === 0) return { inner: text.slice(1, i), rest: text.slice(i + 1) };
        }
    }
    return null;
}

/**
 * The lines of a block comment's text (acorn's `value`, between the slash-star
 * and the star-slash) with the leading ` * ` gutter removed.
 */
function commentLines(value) {
    return String(value || '').split('\n').map((line, i) => {
        let l = i === 0 ? line.replace(/^\*+/, '') : line;
        l = l.replace(/^\s*\*(?!\/)\s?/, '');
        return l.replace(/\s+$/, '');
    });
}

/**
 * Parse one JSDoc block.
 *
 * @param {string} value           the comment text (between the delimiters)
 * @param {number} startLine        1-based line the comment starts on
 * @param {{ inputsName?: string|null, ctxName?: string|null }} names
 * @returns {{ description: string|null, params: object[], returns: object|null }}
 */
function parseJsDoc(value, startLine, { inputsName = 'inputs', ctxName = 'ctx' } = {}) {
    const lines = commentLines(value);
    const descLines = [];
    const tags = [];
    let current = null;
    lines.forEach((line, i) => {
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- one anchored tag pattern over a single comment line: linear
        const trimmed = line.trim();
        const m = /^@(\w+)\b\s*(.*)$/.exec(trimmed);
        if (m) {
            current = { tag: m[1], text: m[2], line: startLine + i };
            tags.push(current);
            return;
        }
        if (current) {
            current.text += (current.text && trimmed ? ' ' : '') + trimmed;
            return;
        }
        descLines.push(trimmed);
    });

    // The first paragraph is the step description.
    const firstPara = [];
    for (const l of descLines) {
        if (!l) { if (firstPara.length) break; continue; }
        firstPara.push(l);
    }
    const description = firstPara.length ? firstPara.join(' ') : null;

    const params = [];
    const seen = new Set();
    let returns = null;
    const prefixes = new Set([inputsName || 'inputs']);
    for (const t of tags) {
        if ((t.tag === 'returns' || t.tag === 'return') && !returns) {
            let text = t.text.trim();
            let type = null;
            const g = readGroup(text, '{', '}');
            if (g) { type = g.inner.trim() || null; text = g.rest.trim(); }
            returns = { type, description: text.replace(/^-\s*/, '').trim() || null };
            continue;
        }
        if (t.tag !== 'param' && t.tag !== 'arg' && t.tag !== 'argument') continue;
        let text = t.text.trim();
        let typeText = '';
        const g = readGroup(text, '{', '}');
        if (g) { typeText = g.inner; text = g.rest.trim(); }

        let rawName;
        let optional = false;
        let defaultText;
        const b = readGroup(text, '[', ']');
        if (b) {
            optional = true;
            const eq = b.inner.indexOf('=');
            rawName = (eq >= 0 ? b.inner.slice(0, eq) : b.inner).trim();
            defaultText = eq >= 0 ? b.inner.slice(eq + 1) : undefined;
            text = b.rest.trim();
        } else {
            const nm = /^(\S+)/.exec(text);
            if (!nm) continue;
            rawName = nm[1];
            text = text.slice(nm[1].length).trim();
        }

        let name = rawName;
        const dot = rawName.indexOf('.');
        if (dot >= 0) {
            const prefix = rawName.slice(0, dot);
            if (!prefixes.has(prefix)) continue;         // ctx.x, options.x: not an input
            name = rawName.slice(dot + 1);
            if (name.includes('.') || name.includes('[')) continue; // a nested field
        } else if (rawName === inputsName || rawName === ctxName || rawName === 'ctx') {
            continue;                                     // the containers themselves
        }
        if (!NAME_RE.test(name) || seen.has(name)) continue;
        seen.add(name);

        const shape = parseType(typeText);
        if (shape.optional) optional = true;
        const def = defaultText !== undefined ? typedDefault(parseDefault(defaultText), shape) : undefined;
        const descr = text.replace(/^-\s*/, '').trim();
        const param = {
            name,
            label: humanise(name),
            description: descr || null,
            type: shape.type,
            ...(shape.format ? { format: shape.format } : {}),
            ...(shape.items ? { items: shape.items } : {}),
            ...(shape.enum ? { enum: shape.enum } : {}),
            required: !optional && def === undefined,
            ...(def !== undefined ? { default: def } : {}),
            line: t.line,
        };
        params.push(param);
    }
    return { description, params, returns };
}

module.exports = { parseJsDoc, parseType, parseDefault, humanise, commentLines };
