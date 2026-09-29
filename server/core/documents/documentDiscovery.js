// @typecheck
'use strict';
const { getContract, evaluateCondition, setPath } = require('./documentContract');
function schemas(prefix) {
    return [
        { type:'function', function:{ name:`${prefix}_search_documents`, description:'Search all accessible private and team document templates. Paginate with offset; the prompt catalog is only a sample. Read the selected document contract before configuring a fill_document step.', parameters:{ type:'object',properties:{ query:{type:'string'},offset:{type:'integer'},limit:{type:'integer'} } } } },
        { type:'function', function:{ name:`${prefix}_read_document`, description:'Read the complete document contract: all typed parameters, requirements, instructions, section outline and pinned revision. Optionally read one section or the document body for context. Required before building or updating a fill_document binding.', parameters:{ type:'object',properties:{documentId:{type:'string'},versionId:{type:'string'},sectionId:{type:'string'},includeBody:{type:'boolean'}},required:['documentId'] } } },
    ];
}
async function execute(name,args,wrap) {
    try { return await executeRead(name,args,wrap); }
    catch (e) { return {error:e.message || 'Could not read the document library. Please retry.',code:e.errorClass || 'document_discovery_failed'}; }
}
async function executeRead(name,args,wrap) {
    const store = require('../../stores/documentStore');
    if (name.endsWith('_search_documents')) {
        const limit = Math.min(Math.max(Number(args.limit) || 25,1),100);
        const matches = await store.listTemplates(wrap.userId,{query:args.query,offset:args.offset,limit});
        const documents = matches.map(d => ({ id:d.id, name:d.name, docType:d.docType, kind:d.kind,
            description:d.description, versionId:d.versionId, parameterCount:d.parameters?.length || 0, sectionCount:d.sections?.length || 0 }));
        return { documents, nextOffset:documents.length === limit ? (Number(args.offset)||0)+limit : null };
    }
    if (!args.documentId) return {error:'Choose a documentId from the document search results.'};
    const doc = args.versionId ? await store.getDocumentVersion(args.documentId,wrap.userId,args.versionId) : await store.getDocument(args.documentId,wrap.userId);
    if (!doc || doc.kind === 'section') return {error:'Document not found'};
    const contract = getContract(doc);
    wrap._documentContracts ||= {};
    wrap._documentContracts[doc.id] = contract;
    wrap._documents ||= [];
    wrap._documents = [...wrap._documents.filter(d => d.id !== doc.id),{...contract,id:doc.id}];
    let bodyHtml;
    if (args.sectionId) {
        const section = contract.sections.find(s => s.id === args.sectionId);
        if (!section) return { error:'Section not found',contract };
        const $ = require('cheerio').load(doc.bodyHtml,{xmlMode:true},false);
        bodyHtml = $(`[data-doc-section="${section.id}"]`).html();
    } else if (args.includeBody) bodyHtml = doc.bodyHtml;
    return { contract,...(bodyHtml !== undefined ? {bodyHtml} : {}) };
}
// Runs before mutation, including batch tools, so failed inspection never leaves
// a partially wired document step behind. Existing non-document edits are untouched.
function inspectBindings(args,wrap, prefix) {
    let error;
    function walk(value) {
        if (!value || typeof value !== 'object' || error) return;
        if (typeof value.documentId === 'string') {
            const contract = wrap._documentContracts?.[value.documentId];
            // Versioned contracts identify upgraded documents; legacy test/tool
            // callers without contract metadata retain their original protocol.
            const known = wrap._documents?.find(d => d.id === value.documentId);
            if (!contract && (known?.versionId || wrap._documentDiscoveryRequired)) {
                error = `Read ${prefix}_read_document({documentId:"${value.documentId}"}) before configuring this document.`; return;
            }
            if (contract) {
                if (value.documentVersionId && value.documentVersionId !== contract.versionId) {
                    error = 'Read the selected document revision before changing its bindings.'; return;
                }
                value.documentVersionId = contract.versionId;
                const supplied = value.values || {};
                const overrides = Object.fromEntries(Object.entries(value.sectionOverrides || {}).map(([id,binding]) => [id, binding && ['literal','static'].includes(binding.kind) ? binding.value : binding]));
                const knownValues = {};
                for (const p of contract.parameters) if (p.default !== undefined) setPath(knownValues, p.key, p.default);
                for (const [key,binding] of Object.entries(supplied)) {
                    const v = binding && ['literal','static'].includes(binding.kind) ? binding.value : binding;
                    if (!(typeof v === 'string' && v.includes('{{')) && !(v && typeof v === 'object' && v.kind)) setPath(knownValues,key,v);
                }
                const inactive = new Set(contract.sections.filter(s=>overrides[s.id]==='exclude' || (overrides[s.id]!=='include' && evaluateCondition(s.condition,knownValues).state==='excluded')).map(s=>s.id));
                for (let pass = 0; pass < contract.sections.length; pass++) {
                    for (const s of contract.sections) if (inactive.has(s.parentId)) inactive.add(s.id);
                }
                const needsConditionInput = p => p.conditionForSections?.some(id => {
                    const s = contract.sections.find(s => s.id === id);
                    return !inactive.has(s?.parentId) && !['include','exclude'].includes(overrides[id]);
                });
                const missing = contract.parameters.filter(p => {
                    const binding = supplied[p.key];
                    const v = binding && ['literal','static'].includes(binding.kind) ? binding.value : binding;
                    if (p.default !== undefined || (Object.hasOwn(supplied,p.key) && v !== undefined && v !== null && v !== '')) return false;
                    if (needsConditionInput(p)) return true;
                    if (!p.required) return false;
                    if (p.usedOutsideSections) return true;
                    if (p.usedInSections?.length) return !p.usedInSections.every(id => inactive.has(id));
                    return !p.conditionForSections?.length;
                });
                if (missing.length) error = `Missing document bindings: ${missing.map(p => `${p.key} (${p.summary || p.label})`).join(', ')}. Supply bindings or inspect conditional applicability before completing this step.`;
            }
        }
        Object.values(value).forEach(walk);
    }
    try { walk(args); } catch (e) { error=e.message; }
    return error ? {error} : null;
}
module.exports = { schemas,execute,inspectBindings };
