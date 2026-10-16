// @typecheck
'use strict';

const log = require('../../telemetry/log');

// app_list_documents — the OWNER's designed documents, with the placeholders
// each one carries. Read-only, and the analogue of app_list_connectors: the AI
// WIRES an existing document into a fill_document step; it never authors one,
// because the layout is the thing a person drew by hand.
//
// Owner-scoped (documentStore.getDocument/listTemplates take a userId), and the
// owner is the app's — an app prints on the company's letterhead, not on the
// letterhead of whoever pressed the button.
const DOCUMENT_LIST_LIMIT = 50;

async function applyListDocuments(draftWrap) {
    const documentStore = require('../../stores/documentStore');
    let templates = [];
    try {
        templates = await documentStore.listTemplates(draftWrap.userId, { limit: DOCUMENT_LIST_LIMIT });
    } catch (e) {
        log.warn('app_list_documents failed', { error: e.message });
        // An outage is not "the owner has no documents": saying so would send
        // the model off to build a text export instead of asking again.
        return { error: 'The documents could not be read right now.', _fixHint: 'Try again; do not build a substitute document out of text.' };
    }
    // An explicit allow-list: the store rows carry owner/editor ids, project ids
    // and the whole contract, none of which the model needs to wire a step.
    return {
        documents: templates.map(t => ({
            documentId: t.id,
            name: t.name,
            docType: t.docType,
            kind: t.kind,
            versionId: t.versionId,
            placeholders: (Array.isArray(t.placeholders) ? t.placeholders : []).map(p => ({
                key: p.key,
                kind: p.kind,
                ...(Array.isArray(p.fields) ? { fields: p.fields } : {}),
            })),
        })),
        ...(templates.length >= DOCUMENT_LIST_LIMIT ? { truncated: `Only the first ${DOCUMENT_LIST_LIMIT} are listed; use app_search_documents to find others.` } : {}),
        note: templates.length
            ? 'Use one of these documentIds in a fill_document step; the keys of `values` are the placeholder names exactly as listed. A "list" placeholder needs a binding that resolves to an array.'
            : 'No designed documents yet — the owner makes them in Studio → Documents. You cannot create one; say so instead of exporting text as a substitute.',
    };
}

module.exports = { applyListDocuments };
