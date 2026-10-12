// @typecheck
/**
 * Document templates — turning a stored Studio Document into a filled-in one.
 *
 * A document (stores/documentStore.js) is two slots: `bodyHtml` and `css`. On
 * its own that is ONE invoice. This module is what makes it a TEMPLATE: the
 * body may carry placeholders, and an automation step or an app action hands over
 * a values object per run.
 *
 *     {{customer.name}}                     one value
 *     {{#each lines}} … {{/each}}           one block per item in a list
 *     {{#if discount}} … {{else}} … {{/if}} a block that may not apply
 *
 * WHY A TEMPLATE AND NOT "THE MODEL WRITES THE INVOICE EACH TIME". A layout
 * the model re-authors per run is a layout that differs per run: the totals
 * block moves, the VAT line is called something else, the logo drifts. An
 * invoice is exactly the artefact where that is unacceptable, and it is also
 * the artefact where the layout is designed once and used five hundred times.
 * So the person designs it by hand in the editor and every run fills it.
 *
 * WHY IT IS PARSED AND NOT REGEX-REPLACED. Blocks nest — a per-project block
 * holding a per-line block is an ordinary invoice — and a non-greedy regex
 * pairs the outer `{{#each}}` with the INNER `{{/each}}`, which silently
 * renders half a document. The scanner below walks the tags once and pairs
 * them by depth, so nesting is either correct or reported as an unclosed
 * block; it is never quietly wrong.
 *
 * WHY VALUES ARE ESCAPED, ALWAYS. The values come from run data — a mailbox, a
 * form a stranger filled in, a spreadsheet. `composeDocument` sanitises the
 * composed document afterwards, so markup here cannot execute, but escaping is
 * still the right layer: an ampersand in a company name must print as an
 * ampersand, and a `<` in a note must not silently swallow the rest of the
 * line. There is deliberately NO raw/triple-stache form — a document that
 * prints is never worth an injection hole.
 *
 * WHY A MISSING VALUE IS BLANK *AND* REPORTED. Leaving `{{customer.name}}`
 * standing prints those braces on a PDF that goes to a customer, which is the
 * worst of the three options. Blanking it silently is the second worst. So the
 * hole is blanked and `fillDocumentBody` reports every path it could not
 * resolve; the callers put that list in the step output, where a run log shows
 * it and a step editor can warn before anyone sends anything.
 *
 * ONE KNOWN LIMIT, worth stating because it is invisible when it bites: the
 * placeholders are matched in the markup TEXT. The editor is contenteditable,
 * so a person who bolds half of a placeholder ends up with
 * `{{customer.<b>name</b>}}`, which no longer matches and prints literally.
 * `listPlaceholders` is what the UI uses to show which holes a template really
 * has, so a mangled one shows up as missing rather than as a surprise on paper.
 */

'use strict';

// A path is a dotted key: letters, digits, _ - and dots. Deliberately narrow —
// it is looked up against run data, never evaluated, and keeping the alphabet
// small is what makes "is this a placeholder" a decision and not a parse.
const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

// How deep blocks may nest. A template is a page of paper; three levels is
// already past anything an invoice needs, and the bound is what keeps a
// pathological template from costing exponential work.
const MAX_BLOCK_DEPTH = 3;
// A list that renders 500 rows has escaped its purpose (and the document size
// caps would reject the result anyway). Truncating is reported.
const MAX_LIST_ITEMS = 500;

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── Parsing ──────────────────────────────────────────────────────────
//
// The template becomes a small tree of four node kinds: `text`, `value`,
// `each` (children + the path), `if` (two child lists + the path). Parsing is
// separated from filling so `listPlaceholders` reads the SAME tree the filler
// walks — one description of what a template asks for, not two that drift.

const TAG_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Classify one tag's inner text. Unknown shapes stay literal text. */
function classifyTag(inner) {
    const each = /^#each\s+(\S+)$/.exec(inner);
    if (each) return { kind: 'each_open', path: each[1] };
    if (/^\/each$/.test(inner)) return { kind: 'each_close' };
    const iff = /^#if\s+(\S+)$/.exec(inner);
    if (iff) return { kind: 'if_open', path: iff[1] };
    if (/^\/if$/.test(inner)) return { kind: 'if_close' };
    if (/^else$/.test(inner)) return { kind: 'else' };
    if (inner === 'this') return { kind: 'this' };
    if (PATH_RE.test(inner)) return { kind: 'value', path: inner };
    return null;
}

/**
 * Parse a template body into nodes.
 *
 * A tag that does not pair up — a `{{#each}}` nobody closed, a stray
 * `{{/if}}` — is left as literal text and named in `errors`. Refusing to
 * render would mean one mistyped block loses the whole document; printing the
 * braces would put them on the paper. So the block simply does not act as a
 * block, and the error says so where the caller can show it.
 */
function parseTemplate(source) {
    const src = String(source == null ? '' : source);
    const errors = [];
    const root = [];
    // Every frame is a list of nodes being filled. An `if` frame carries both
    // branches so `{{else}}` is a switch, not a second node kind.
    const stack = [{ type: 'root', nodes: root }];
    const top = () => stack[stack.length - 1];
    const push = (node) => {
        const frame = top();
        if (frame.type === 'if' && frame.inElse) frame.whenFalse.push(node);
        else frame.nodes.push(node);
    };

    let last = 0;
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(src)) !== null) {
        const tag = classifyTag(m[1]);
        if (!tag) continue;                       // not ours — leave it in the text
        if (m.index > last) push({ kind: 'text', text: src.slice(last, m.index) });
        last = m.index + m[0].length;

        switch (tag.kind) {
            case 'each_open':
                stack.push({ type: 'each', path: tag.path, nodes: [], raw: m[0] });
                break;
            case 'if_open':
                stack.push({ type: 'if', path: tag.path, nodes: [], whenFalse: [], inElse: false, raw: m[0] });
                break;
            case 'else': {
                const frame = top();
                if (frame.type !== 'if') { push({ kind: 'text', text: m[0] }); errors.push('An {{else}} outside an {{#if}} block was left as text.'); break; }
                frame.inElse = true;
                break;
            }
            case 'each_close':
            case 'if_close': {
                const want = tag.kind === 'each_close' ? 'each' : 'if';
                const frame = top();
                if (frame.type !== want) {
                    push({ kind: 'text', text: m[0] });
                    errors.push(`A {{/${want}}} with no open {{#${want}}} was left as text.`);
                    break;
                }
                stack.pop();
                push(want === 'each'
                    ? { kind: 'each', path: frame.path, nodes: frame.nodes }
                    : { kind: 'if', path: frame.path, nodes: frame.nodes, whenFalse: frame.whenFalse });
                break;
            }
            case 'value':
                push({ kind: 'value', path: tag.path });
                break;
            case 'this':
                push({ kind: 'this' });
                break;
            default:
                break;
        }
    }
    if (last < src.length) push({ kind: 'text', text: src.slice(last) });

    // Anything still open never closed: put its literal tag back and its
    // children into the parent, so the text survives and only the blockness
    // is lost.
    while (stack.length > 1) {
        const frame = stack.pop();
        errors.push(`The block ${frame.raw} was never closed, so it did not repeat.`);
        const target = top();
        const sink = target.type === 'if' && target.inElse ? target.whenFalse : target.nodes;
        sink.push({ kind: 'text', text: frame.raw });
        for (const n of frame.nodes) sink.push(n);
        if (frame.type === 'if') for (const n of frame.whenFalse) sink.push(n);
    }

    return { nodes: root, errors };
}

// ── Filling ──────────────────────────────────────────────────────────

/**
 * Resolve a dotted path against a scope chain (innermost first).
 *
 * Returns `{ found, value }` rather than a bare value: `undefined` and "the
 * template asked for something nobody supplied" are different answers, and
 * only the second one belongs in the missing list.
 */
function lookup(path, scopes) {
    const parts = String(path).split('.').filter(Boolean);
    if (parts.some(p => ['__proto__','prototype','constructor'].includes(p))) return { found:false, value:undefined };
    for (const scope of scopes) {
        let cur = scope;
        let ok = true;
        for (const part of parts) {
            if (cur === null || cur === undefined || typeof cur !== 'object') { ok = false; break; }
            if (!Object.prototype.hasOwnProperty.call(cur, part)) { ok = false; break; }
            cur = cur[part];
        }
        if (ok && cur !== undefined) return { found: true, value: cur };
    }
    return { found: false, value: undefined };
}

/**
 * How a resolved value prints.
 *
 * Objects and arrays print as nothing: a template that drops `[object Object]`
 * into an invoice is a bug that reaches the customer, so an author who wrote
 * `{{customer}}` where they meant `{{customer.name}}` gets a blank and an
 * entry in the missing list instead. `null`/`false` are VALUES a person chose
 * to bind, so they print as an empty string without complaint.
 */
function renderValue(value, escape = true) {
    if (value === null || value === undefined || value === false) return { text: '', usable: true };
    if (typeof value === 'object') return { text: '', usable: false };
    return { text: escape ? escapeHtml(value) : String(value), usable: true };
}

/**
 * Truthiness for `#if`: an empty list, a blank string and ZERO are all "no".
 *
 * Zero is the case worth stating. `{{#if discount}}` on an invoice with a
 * discount of 0 must not print a discount row reading "0,00" — the whole point
 * of the block is that the row is absent when there is nothing to show.
 */
function isTruthy(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return !!value;
}

/**
 * Render a node list against a scope chain.
 *
 * `self` is what `{{this}}` prints — the current item of the enclosing list.
 * It travels as its own argument rather than as scopes[0] because an item may
 * be a scalar, which is not a scope at all, and pushing one would make every
 * lookup inside the block miss.
 */
function renderNodes(nodes, scopes, report, depth, self) {
    let out = '';
    for (const node of nodes) {
        if (++report.visited > 50000 || out.length > 512 * 1024) throw Object.assign(new Error('Expanded document exceeds the rendering limit.'), { status:422, errorClass:'document_too_large' });
        switch (node.kind) {
            case 'text':
                out += node.text;
                break;
            case 'value': {
                const { found, value } = lookup(node.path, scopes);
                if (!found) { report.missing.add(node.path); break; }
                const rendered = renderValue(value, report.escape);
                if (!rendered.usable) { report.missing.add(node.path); break; }
                out += rendered.text;
                break;
            }
            case 'this': {
                // The item itself — how a list of plain strings prints.
                const printed = renderValue(self, report.escape);
                out += printed.usable ? printed.text : '';
                break;
            }
            case 'each': {
                if (depth > MAX_BLOCK_DEPTH) { report.tooDeep.add(node.path); break; }
                const { found, value } = lookup(node.path, scopes);
                if (!found) { report.missing.add(node.path); break; }
                if (!Array.isArray(value)) { report.notLists.add(node.path); break; }
                let items = value;
                if (items.length > MAX_LIST_ITEMS) {
                    items = items.slice(0, MAX_LIST_ITEMS);
                    report.truncated.add(node.path);
                }
                for (const item of items) {
                    // An object item becomes the innermost scope, so
                    // `{{description}}` reads the line and falls through to the
                    // document's own values when the line has no such field. A
                    // scalar item is not a scope at all — it prints as
                    // `{{this}}`, which travels as `self`.
                    const itemScope = item !== null && typeof item === 'object' && !Array.isArray(item) ? item : null;
                    out += renderNodes(node.nodes, itemScope ? [itemScope, ...scopes] : scopes, report, depth + 1, item);
                }
                                break;
            }
            case 'if': {
                if (depth > MAX_BLOCK_DEPTH) { report.tooDeep.add(node.path); break; }
                const { found, value } = lookup(node.path, scopes);
                if (!found) report.missing.add(node.path);
                const branch = isTruthy(value) ? node.nodes : node.whenFalse;
                out += renderNodes(branch, scopes, report, depth + 1, self);
                break;
            }
            default:
                break;
        }
    }
    return out;
}

/**
 * Fill a document body with values.
 *
 * `escape` is on for markup and OFF for a text body — a presentation's outline
 * (core/documents/deckDocument.js) is markdown that the deck renderer escapes
 * itself when it paints, so a value escaped here would print as "&amp;" on a
 * slide.
 *
 * @param {string} bodyHtml the template's body markup
 * @param {object} values   the run's data
 * @param {{escape?: boolean}} [options]
 * @returns {{bodyHtml: string, missing: string[], notLists: string[], truncated: string[], tooDeep: string[], errors: string[]}}
 */
function fillDocumentBody(bodyHtml, values = {}, { escape = true } = {}) {
    const report = { visited: 0, missing: new Set(), notLists: new Set(), truncated: new Set(), tooDeep: new Set(), escape: escape !== false };
    const scope = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const { nodes, errors } = parseTemplate(bodyHtml);
    const filled = renderNodes(nodes, [scope], report, 1, undefined);
    return {
        bodyHtml: filled,
        missing: [...report.missing].sort(),
        notLists: [...report.notLists].sort(),
        truncated: [...report.truncated].sort(),
        tooDeep: [...report.tooDeep].sort(),
        errors,
    };
}

/**
 * The placeholders a template actually has, in the order they first appear.
 *
 * This is what a step editor lists so the author binds the right names, and
 * what the builders read so the AI knows what a template wants. `kind` says
 * how the hole is used: a `list` needs an array, a `value` needs a scalar, a
 * `condition` decides whether a block prints. A list's `fields` are the paths
 * its own block asks of each ITEM — which is what turns "bind lines" into
 * "bind lines, each with a description and an amount".
 *
 * Paths inside a block are deliberately not reported at the top level: they
 * are relative to the item, and listing them beside the outer ones would ask
 * the author to bind `description` as a document-level value.
 */
function listPlaceholders(bodyHtml) {
    const { nodes } = parseTemplate(bodyHtml);
    const seen = new Map();
    const add = (key, kind, extra) => {
        if (!seen.has(key)) seen.set(key, { key, kind, ...(extra || {}) });
    };

    // The paths a block's body asks of each item, one level down.
    const fieldsOf = (children) => {
        const fields = [];
        const walk = (list) => {
            for (const n of list) {
                if (n.kind === 'value' && !fields.includes(n.path)) fields.push(n.path);
                else if (n.kind === 'if') { if (!fields.includes(n.path)) fields.push(n.path); walk(n.nodes); walk(n.whenFalse); }
                else if (n.kind === 'each') walk(n.nodes);
            }
        };
        walk(children);
        return fields;
    };

    const walk = (list) => {
        for (const n of list) {
            if (n.kind === 'value') add(n.path, 'value');
            else if (n.kind === 'each') add(n.path, 'list', { fields: fieldsOf(n.nodes) });
            else if (n.kind === 'if') { add(n.path, 'condition'); walk(n.nodes); walk(n.whenFalse); }
        }
    };
    walk(nodes);
    return [...seen.values()];
}

/** Whether a document carries any placeholder at all — i.e. is a template. */
function isTemplate(bodyHtml) {
    return listPlaceholders(bodyHtml).length > 0;
}

module.exports = {
    MAX_BLOCK_DEPTH,
    MAX_LIST_ITEMS,
    fillDocumentBody,
    listPlaceholders,
    isTemplate,
    parseTemplate,
    _test: { lookup, renderValue, isTruthy, escapeHtml, classifyTag },
};
