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
function parse(html) {
    return cheerio.load(html || '', { xmlMode: true, decodeEntities: false }, false);
}
function fail(message) {
    throw Object.assign(new Error(message), { status: 422, errorClass: 'document_section_invalid' });
}

// Keep the root condition as well as descendant rules. A library item must have
// the same applicability as the content from which it was saved.
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
function insertSection(doc, source, sectionId, { replace = false } = {}) {
    if (!/^[\w-]{1,64}$/.test(sectionId)) fail('Invalid insertion ID');
    const contract = getContract(doc);
    const from = getContract(source);
    const sourceHtml = parse(source.bodyHtml);
    const ids = new Map();
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
    const start = `/* document-section:${sectionId}:start */`;
    const end = `/* document-section:${sectionId}:end */`;
    let originalCss = doc.css || '';
    const startAt = originalCss.indexOf(start), endAt = originalCss.indexOf(end, startAt);
    if (startAt >= 0 && endAt >= 0) originalCss = originalCss.slice(0, startAt) + originalCss.slice(endAt + end.length);
    const sectionOverrides = Object.fromEntries(Object.entries(doc.settings?.sectionOverrides || {}).filter(([id]) => contract.sections.some(s => s.id === id)));
    return { bodyHtml: body.html(), css: `${originalCss.trimEnd()}\n${start}\n${css}\n${end}`,
        settings: { ...doc.settings, sectionOverrides, contract: normalizeContract(contract) } };
}
module.exports = { extractSection, insertSection, ruleKeys };
