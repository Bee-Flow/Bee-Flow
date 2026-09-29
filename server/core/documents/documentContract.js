'use strict';

const { listPlaceholders, fillDocumentBody, _test: { lookup } } = require('./documentTemplate');

const TYPES = ['text', 'number', 'boolean', 'date', 'choice', 'list'];
const OPERATORS = ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_set'];
const bad = (message) => Object.assign(new Error(message), { status: 422, errorClass: 'document_contract_invalid' });
function safePath(path) {
    return typeof path === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(path)
        && path.split('.').every(p => p && !['__proto__', 'prototype', 'constructor'].includes(p));
}
function validateCondition(rule, depth = 0) {
    if (!rule) return;
    if (depth > 6) throw bad('Section rules may nest at most six levels.');
    if (rule.all || rule.any) {
        const children = rule.all || rule.any;
        if (!Array.isArray(children) || !children.length || children.length > 50 || (rule.all && rule.any)) throw bad('Use a nonempty all or any rule group.');
        children.forEach(r => { if (!r || typeof r !== 'object') throw bad('Invalid condition in rule group.'); validateCondition(r, depth + 1); });
    } else if (!safePath(rule.parameter) || !OPERATORS.includes(rule.operator)) throw bad('Invalid section rule.');
}
function normalizeContract(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('Expected a document contract.');
    const parameters = raw.parameters || [];
    const sections = raw.sections || [];
    if (!Array.isArray(parameters) || parameters.length > 200 || !Array.isArray(sections) || sections.length > 100) throw bad('Maximum 200 parameters and 100 sections.');
    const keys = new Set();
    function parameter(p, nested = false) {
        if (!p || !safePath(p.key) || !TYPES.includes(p.type)) throw bad('Each parameter needs a safe key and a supported type.');
        if (!nested && keys.has(p.key)) throw bad(`Duplicate parameter: ${p.key}`);
        if (!nested) keys.add(p.key);
        if (p.type === 'list' && nested) throw bad('Nested list fields are not supported.');
        if (p.fields && (!Array.isArray(p.fields) || p.fields.length > 100)) throw bad('Invalid list fields.');
        if (p.type === 'choice' && (!Array.isArray(p.options) || !p.options.length || p.options.length > 100 || p.options.some(o => typeof o !== 'string'))) throw bad('Choices need a list of options.');
        if (p.fields && new Set(p.fields.map(f => f?.key)).size !== p.fields.length) throw bad('List field keys must be unique.');
        return {
            key: p.key, type: p.type, label: String(p.label || p.key).slice(0, 200), required: p.required === true,
            summary: String(p.summary || '').slice(0, 1000), instructions: String(p.instructions || '').slice(0, 8000),
            ...(p.example !== undefined ? { example: p.example } : {}), ...(p.default !== undefined ? { default: p.default } : {}),
            ...(p.type === 'choice' ? { options: p.options } : {}),
            ...(p.type === 'list' ? { fields: (p.fields || []).map(f => parameter(f, true)) } : {}),
        };
    }
    const ids = new Set();
    return {
        schemaVersion: 1, instructions: String(raw.instructions || '').slice(0, 20000),
        parameters: parameters.map(p => parameter(p)),
        sections: sections.map(s => {
            if (!s || !/^[\w-]{1,100}$/.test(s.id) || ids.has(s.id)) throw bad('Section IDs must be unique letters, numbers, underscores or hyphens.');
            ids.add(s.id); validateCondition(s.condition);
            return { id: s.id, title: String(s.title || s.id).slice(0, 200), summary: String(s.summary || '').slice(0, 2000),
                condition: s.condition || null, ...(s.source ? { source: { documentId: String(s.source.documentId), versionId: String(s.source.versionId) } } : {}) };
        }),
    };
}
function getContract(doc) {
    const explicit = normalizeContract(doc.settings?.contract || {});
    const placeholders = listPlaceholders(doc.bodyHtml || '');
    const parameters = [...explicit.parameters];
    for (const p of placeholders) {
        if (!safePath(p.key)) throw bad(`Unsafe placeholder: ${p.key}`);
        if (!parameters.some(x => x.key === p.key)) parameters.push({ key: p.key, label: p.key,
            type: p.kind === 'list' ? 'list' : p.kind === 'condition' ? 'boolean' : 'text',
            required: false, summary: '', instructions: '', inferred: true,
            ...(p.fields ? { fields: p.fields.map(key => ({ key, type: 'text', required: false })) } : {}) });
    }
    const ruleParameters = new Map();
    function collectRule(rule, sectionId) {
        if (!rule) return;
        if (rule.parameter) {
            const entry = ruleParameters.get(rule.parameter) || { sections: [], type: ['greater_than','less_than'].includes(rule.operator) || typeof rule.value === 'number' ? 'number' : typeof rule.value === 'boolean' ? 'boolean' : 'text' };
            entry.sections.push(sectionId); ruleParameters.set(rule.parameter, entry);
        }
        (rule.all || rule.any || []).forEach(r => collectRule(r, sectionId));
    }
    explicit.sections.forEach(s => collectRule(s.condition, s.id));
    for (const [key, info] of ruleParameters) {
        if (!parameters.some(p => p.key === key)) parameters.push({ key, label: key, type: info.type, required: false,
            summary: '', instructions: '', inferred: true });
    }
    if (parameters.length > 200) throw bad('Maximum 200 parameters, including inferred inputs.');
    if (explicit.sections.length) {
        const $ = require('cheerio').load(doc.bodyHtml || '',{xmlMode:true},false);
        for (const s of explicit.sections) s.parentId = $(`[data-doc-section="${s.id}"]`).parents('[data-doc-section]').first().attr('data-doc-section') || null;
        const sectionKeys = new Map(explicit.sections.map(s => {
            const content = $(`[data-doc-section="${s.id}"]`).clone();
            content.find('[data-doc-section]').remove();
            return [s.id,new Set(listPlaceholders(content.html() || '').map(p => p.key))];
        }));
        for (const p of parameters) {
            p.usedInSections = explicit.sections.filter(s=>sectionKeys.get(s.id).has(p.key)).map(s=>s.id);
            p.conditionForSections = [...new Set(ruleParameters.get(p.key)?.sections || [])];
        }
        $('[data-doc-section]').remove();
        const outside = new Set(listPlaceholders($.html()).map(p => p.key));
        for (const p of parameters) p.usedOutsideSections = outside.has(p.key);
    }
    return { ...explicit, parameters, placeholders, documentId: doc.id, versionId: doc.versionId,
        name: doc.name, docType: doc.docType, description: doc.description || '' };
}
function setPath(target, key, value) {
    if (!safePath(key)) throw bad(`Unsafe parameter path: ${key}`);
    const parts = key.split('.');
    let cur = target;
    for (const part of parts.slice(0, -1)) {
        if (!Object.hasOwn(cur, part) || !cur[part] || typeof cur[part] !== 'object' || Array.isArray(cur[part])) cur[part] = Object.create(null);
        cur = cur[part];
    }
    cur[parts.at(-1)] = value;
}
function evaluateCondition(rule, values) {
    if (!rule) return { state: 'included', reason: 'Always included' };
    if (rule.all || rule.any) {
        const results = (rule.all || rule.any).map(r => evaluateCondition(r, values));
        const state = rule.all
            ? results.some(r => r.state === 'excluded') ? 'excluded' : results.some(r => r.state === 'unresolved') ? 'unresolved' : 'included'
            : results.some(r => r.state === 'included') ? 'included' : results.some(r => r.state === 'unresolved') ? 'unresolved' : 'excluded';
        return { state, reason: results.map(r => r.reason).join(rule.all ? ' AND ' : ' OR ') };
    }
    const { found, value } = lookup(rule.parameter, [values]);
    if (!found || value === null) return { state: 'unresolved', reason: `Needs input: ${rule.parameter}` };
    let yes;
    switch (rule.operator) {
        case 'is_set': yes = value !== ''; break;
        case 'equals': yes = value === rule.value; break;
        case 'not_equals': yes = value !== rule.value; break;
        case 'contains': yes = (typeof value === 'string' || Array.isArray(value)) && value.includes(rule.value); break;
        case 'greater_than': case 'less_than':
            if (typeof value !== 'number' || typeof rule.value !== 'number') return { state: 'unresolved', reason: `Needs a number: ${rule.parameter}` };
            yes = rule.operator === 'greater_than' ? value > rule.value : value < rule.value; break;
        default: return { state: 'unresolved', reason: 'Invalid rule' };
    }
    return { state: yes ? 'included' : 'excluded', reason: `${rule.parameter}: ${rule.operator.replaceAll('_', ' ')} ${rule.value ?? ''}`.trim() };
}
function typeValid(p, value) {
    switch (p.type) {
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'boolean': return typeof value === 'boolean';
        case 'date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
        case 'choice': return p.options.includes(value);
        case 'list': return Array.isArray(value);
        default: return typeof value === 'string';
    }
}
function prepareDocument(doc, supplied = {}, overrides = {}) {
    const contract = getContract(doc);
    const values = Object.create(null);
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).length > 200) throw bad('Expected at most 200 parameter values.');
    for (const [key, value] of Object.entries(supplied)) setPath(values, key, value);
    for (const p of contract.parameters) if (!lookup(p.key, [values]).found && p.default !== undefined) setPath(values, p.key, p.default);
    const issues = [];
    for (const [id, choice] of Object.entries(overrides || {})) {
        if (!contract.sections.some(s => s.id === id) || !['automatic', 'include', 'exclude'].includes(choice)) issues.push({ code: 'invalid_override', sectionId: id, message: 'Invalid section choice' });
    }
    let bodyHtml = doc.bodyHtml || '';
    let $;
    if (contract.sections.length) $ = require('cheerio').load(bodyHtml, { xmlMode: true, decodeEntities: false }, false);
    const originalCounts = new Map(contract.sections.map(s=>[s.id,$(`[data-doc-section="${s.id}"]`).length]));
    const sections = contract.sections.map(s => {
        const choice = overrides?.[s.id];
        const outcome = choice === 'include' || choice === 'exclude'
            ? { state: choice === 'include' ? 'included' : 'excluded', reason: 'Explicit reviewed choice' }
            : evaluateCondition(s.condition, values);
        return { ...s, ...outcome };
    });
    // Remove excluded parents first, then suppress descendants' requirements.
    for (const s of sections) if (s.state === 'excluded') $(`[data-doc-section="${s.id}"]`).remove();
    for (const s of sections) {
        if (originalCounts.get(s.id) !== 1) issues.push({code:'section_missing',sectionId:s.id,message:`Section ${s.title} must appear exactly once`});
        else if (s.state !== 'excluded' && !$(`[data-doc-section="${s.id}"]`).length) {s.state='excluded';s.reason='Parent section excluded';}
        if (s.state === 'unresolved') issues.push({code:'section_unresolved',sectionId:s.id,message:s.reason});
    }
    if ($) bodyHtml = $.html();
    const active = new Set(listPlaceholders(bodyHtml).map(p => p.key));
    const all = new Set(contract.placeholders.map(p => p.key));
    function check(p, scope, prefix = '') {
        const { found, value } = lookup(p.key, [scope]);
        const key = prefix + p.key;
        if (!found || value === null || value === '') {
            if (p.required) issues.push({ code: 'required', key, message: `${p.label || key} is required` });
            return;
        }
        if (!typeValid(p, value)) issues.push({ code: 'type', key, message: `${key} must be ${p.type}` });
        else if (p.type === 'list') value.forEach((item, i) => (p.fields || []).forEach(f => check(f, item, `${key}[${i}].`)));
    }
    const ruleKeys = new Set(); const activeRuleKeys = new Set();
    const collect = (rule,target) => {if(!rule)return;if(rule.parameter)target.add(rule.parameter);(rule.all || rule.any || []).forEach(r=>collect(r,target));};
    for(const s of sections) {
        collect(s.condition,ruleKeys);
        if(s.reason !== 'Parent section excluded' && !['include','exclude'].includes(overrides?.[s.id])) collect(s.condition,activeRuleKeys);
    }
    for (const p of contract.parameters) {
        if (activeRuleKeys.has(p.key) || (all.has(p.key) ? active.has(p.key) : ruleKeys.has(p.key) ? false : true)) check(p, values);
    }
    // A presentation's body is a markdown OUTLINE the deck renderer escapes
    // when it paints (core/documents/deckDocument.js); escaping here too would
    // print "&amp;" on a slide.
    const fill = fillDocumentBody(bodyHtml, values, { escape: doc.docType !== 'presentation' });
    // Missing legacy condition inputs must never silently hide customer content.
    for (const p of listPlaceholders(bodyHtml)) if (p.kind === 'condition' && fill.missing.includes(p.key)) issues.push({ code: 'section_unresolved', key: p.key, message: `Needs input: ${p.key}` });
    for (const code of ['notLists', 'truncated', 'tooDeep', 'errors']) for (const item of fill[code]) issues.push({ code, message: String(item) });
    if (/\{\{[^{}]*\}\}/.test(fill.bodyHtml)) issues.push({ code: 'malformed_template', message: 'Unresolved or malformed template markers remain' });
    if (Buffer.byteLength(fill.bodyHtml) > 512 * 1024) issues.push({ code: 'document_too_large', message: 'Filled document exceeds 512 KB' });
    return { ...fill, valid: issues.length === 0, issues, sections, versionId: doc.versionId };
}
function assertFinal(fill) {
    if (!fill.valid) throw Object.assign(new Error(fill.issues.map(i => i.message).join('; ')), { status: 422, errorClass: 'document_validation_failed', issues: fill.issues });
}
module.exports = { TYPES, OPERATORS, safePath, setPath, normalizeContract, getContract, evaluateCondition, prepareDocument, assertFinal, validateCondition };
