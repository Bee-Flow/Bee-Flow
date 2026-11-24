// @typecheck
'use strict';

const cheerio = require('cheerio');
const { createHash } = require('crypto');
const { getContract, normalizeContract } = require('./documentContract');
const { listPlaceholders } = require('./documentTemplate');

function ruleKeys(rule, keys = new Set()) {
    if (rule?.parameter) keys.add(rule.parameter);
    for (const child of rule?.all || rule?.any || []) ruleKeys(child, keys);
    return keys;
}
/**
 * @param {string | Buffer<ArrayBufferLike> | AnyNode | AnyNode[]} html
 */
function parse(html) {
    // HTML mode via htmlparser2 (no table foster-parenting, entities kept as
    // written) and an HTML serialiser: XML mode stored an empty `<div></div>` as
    // `<div/>`, which a browser reads as an open div swallowing what follows.
    return cheerio.load(html || '', { xml: { xmlMode: false, decodeEntities: false } }, false);
}
/**
 * @param {string} message
 */
function fail(message) {
    throw Object.assign(new Error(message), { status: 422, errorClass: 'document_section_invalid' });
}

// ── Scoping a section's stylesheet ───────────────────────────────────
// A library section carries the stylesheet of the document it came from. Appended as it is, `h2 { … }` or
// `:root { --doc-accent: … }` would restyle the whole document it is inserted into. So every rule is put
// under the inserted section's own element: `h2` becomes `[data-doc-section="x"] h2`, and `:root`, `html`
// and `body` become that element itself. Page geometry (@page) is the document's, and is left out.

/**
 * Split at the top level (outside strings, brackets and parentheses).
 * @param {string} text @param {string} sep
 */
function splitTop(text, sep) {
    const parts = []; let depth = 0; let quote = ''; let from = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (c === sep && depth === 0) { parts.push(text.slice(from, i)); from = i + 1; }
    }
    parts.push(text.slice(from));
    return parts;
}

/** @param {string} selector @param {string} scope */
function scopeSelector(selector, scope) {
    const sel = selector.trim();
    if (!sel) return '';
    const words = sel.split(/\s+/);
    // The document's own roots stand for the section's element.
    while (words.length && /^(?::root|html|body)$/i.test(words[0])) words.shift();
    return words.length ? `${scope} ${words.join(' ')}` : scope;
}

/**
 * The top-level rules of a stylesheet: [prelude, body] pairs (comments removed).
 * @param {string} css
 * @returns {Array<[string, string]>}
 */
function cssRules(css) {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    /** @type {Array<[string, string]>} */
    const rules = [];
    let i = 0;
    while (i < text.length) {
        const { open, end, closed } = ruleEnd(text, i);
        if (open >= 0 && closed) rules.push([text.slice(i, open).trim(), text.slice(open + 1, end)]);
        i = end + 1;
    }
    return rules;
}

/**
 * Where the rule starting at `from` opens its block and ends.
 * @param {string} text @param {number} from
 */
function ruleEnd(text, from) {
    let depth = 0; let quote = ''; let open = -1; let j = from;
    for (; j < text.length; j++) {
        const c = text[j];
        if (quote) { if (c === '\\') j++; else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === ';' && depth === 0) break; // a statement without a block (@charset, @import)
        else if (c === '{' && depth++ === 0) open = j;
        else if (c === '}' && --depth === 0) break;
    }
    return { open, end: j, closed: depth === 0 };
}

/**
 * A stylesheet whose every rule applies inside `scope` only.
 * @param {string} css @param {string} scope
 * @returns {string}
 */
function scopeCss(css, scope) {
    return cssRules(css).map(([prelude, body]) => {
        if (!prelude.startsWith('@')) {
            const selectors = splitTop(prelude, ',').map(sel => scopeSelector(sel, scope)).filter(Boolean);
            return selectors.length ? `${selectors.join(', ')} {${body}}` : '';
        }
        const name = prelude.slice(1).split(/[\s({]/)[0].toLowerCase();
        // Conditional groups hold rules: scope those. Keyframes and fonts are names, not restyling.
        if (['media', 'supports', 'container', 'layer'].includes(name)) { const inner = scopeCss(body, scope); return inner ? `${prelude} {\n${inner}\n}` : ''; }
        if (name === 'keyframes' || name === 'font-face' || name.endsWith('-keyframes')) return `${prelude} {${body}}`;
        return '';
    }).filter(Boolean).join('\n');
}

// Keep the root condition as well as descendant rules. A library item must have
// the same applicability as the content from which it was saved.
/**
 * @param {string} sectionId
 */
function extractSection(doc, sectionId) {
    const contract = getContract(doc);
    const section = contract.sections.find(s => s.id === sectionId);
    if (!section) fail('Section not found');
    const $ = parse(doc.bodyHtml);
    const node = $(`[data-doc-section="${sectionId}"]`);
    if (node.length !== 1) fail('Section must appear exactly once');
    const bodyHtml = $.html(node);
    const ids = new Set([sectionId, ...node.find('[data-doc-section]').map((_, el) => $(el).attr('data-doc-section')).get()]);
    const sections = contract.sections.filter(s => ids.has(s.id));
    const keys = new Set(listPlaceholders(bodyHtml).map(p => p.key));
    sections.forEach(s => ruleKeys(s.condition, keys));
    return {
        name: section.title, description: section.summary, kind: 'section', bodyHtml, css: doc.css,
        settings: { design: doc.settings?.design, contract: normalizeContract({
            instructions: contract.instructions, parameters: contract.parameters.filter(p => keys.has(p.key)), sections,
        }) },
    };
}

// IDs are scoped to the insertion, but deterministic across reviewed source
// revisions. Two copies can coexist and existing overrides survive updates.
/**
 * @param {string} sectionId
 */
function insertSection(doc, source, sectionId, { replace = false } = {}) {
    if (!/^[\w-]{1,64}$/.test(sectionId)) fail('Invalid insertion ID');
    const contract = getContract(doc);
    const from = getContract(source);
    const sourceHtml = parse(source.bodyHtml);
    const ids = new Map();
    /**
     * @param {string | undefined} id
     */
    const scopedId = id => `${sectionId}-${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
    sourceHtml('[data-doc-section]').each((_, el) => {
        const old = sourceHtml(el).attr('data-doc-section');
        ids.set(old, scopedId(old));
        sourceHtml(el).attr('data-doc-section', ids.get(old));
    });
    for (const s of from.sections) if (!ids.has(s.id)) fail(`Source section missing: ${s.title}`);
    const body = parse(doc.bodyHtml);
    const oldRoot = contract.sections.find(s => s.id === sectionId);
    let previousIds = new Set();
    if (replace) {
        const node = body(`[data-doc-section="${sectionId}"]`);
        if (node.length !== 1 || !oldRoot) fail('Section to update is missing');
        previousIds = new Set(node.find('[data-doc-section]').map((_, el) => body(el).attr('data-doc-section')).get());
        node.html(sourceHtml.html());
    } else {
        if (oldRoot) fail('Section ID already exists');
        body.root().append(`<section data-doc-section="${sectionId}">${sourceHtml.html()}</section>`);
    }
    const oldSections = contract.sections;
    contract.sections = contract.sections.filter(s => s.id !== sectionId && !previousIds.has(s.id));
    contract.sections.push({ ...oldRoot, id: sectionId, title: oldRoot?.title || source.name,
        summary: oldRoot?.summary || source.description, source: { documentId: source.id, versionId: source.versionId } });
    contract.sections.push(...from.sections.map(s => ({ ...s, id: ids.get(s.id) })));

    // Remove inputs that belonged solely to removed source content. Otherwise
    // an update that removes a required field would demand it forever.
    const remainingKeys = new Set(listPlaceholders(body.html()).map(p => p.key));
    contract.sections.forEach(s => ruleKeys(s.condition, remainingKeys));
    const previousKeys = new Set();
    oldSections.filter(s => previousIds.has(s.id)).forEach(s => ruleKeys(s.condition, previousKeys));
    for (const p of contract.parameters) if (p.usedInSections?.some(id => id === sectionId || previousIds.has(id))) previousKeys.add(p.key);
    contract.parameters = contract.parameters.filter(p => !previousKeys.has(p.key) || remainingKeys.has(p.key));
    for (const p of from.parameters) {
        const existing = contract.parameters.find(x => x.key === p.key);
        if (existing && (existing.type !== p.type || JSON.stringify(existing.fields) !== JSON.stringify(p.fields) || JSON.stringify(existing.options) !== JSON.stringify(p.options))) fail(`Parameter definition conflict: ${p.key}`);
        if (!existing) contract.parameters.push(p);
    }
    let css = source.css || '';
    css = css.replace(/(\[data-doc-section\s*=\s*)(["']?)([\w-]+)\2(\s*\])/g,
        (match, before, quote, id, after) => ids.has(id) ? `${before}${quote}${ids.get(id)}${quote}${after}` : match);
    css = scopeCss(css, `[data-doc-section="${sectionId}"]`);
    const start = `/* document-section:${sectionId}:start */`;
    const end = `/* document-section:${sectionId}:end */`;
    let originalCss = doc.css || '';
    const startAt = originalCss.indexOf(start), endAt = originalCss.indexOf(end, startAt);
    if (startAt >= 0 && endAt >= 0) originalCss = originalCss.slice(0, startAt) + originalCss.slice(endAt + end.length);
    const sectionOverrides = Object.fromEntries(Object.entries(doc.settings?.sectionOverrides || {}).filter(([id]) => contract.sections.some(s => s.id === id)));
    return { bodyHtml: body.html(), css: `${originalCss.trimEnd()}\n${start}\n${css}\n${end}`,
        settings: { ...doc.settings, sectionOverrides, contract: normalizeContract(contract) } };
}
module.exports = { extractSection, insertSection, ruleKeys, _test: { scopeCss } };

/** @typedef {import('domhandler').AnyNode} AnyNode */
