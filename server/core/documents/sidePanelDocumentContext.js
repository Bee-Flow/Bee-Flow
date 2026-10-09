/**
 * Prompt blocks for the Studio document the person has open next to the chat.
 *
 * Direct chat has the document tools, so it only learns WHICH document is open
 * (`buildDirectNote`); agent chats have no document tools, so the text is
 * injected read-only (`buildAgentContent`). Both run only on turns whose
 * request carries `sidePanelDocument` and only when the person may read the
 * document: otherwise they return '' and nothing is injected.
 *
 * The client's name hint is never used: the stored name is. Names and content
 * never go to logs.
 */

const documentStore = require('../../stores/documentStore');
const { htmlToText } = require('../../stores/lib/documentText');
const { normaliseSidePanelDocument } = require('./aiDocumentScope');
const log = require('../../telemetry/log');

const MAX_CONTENT_CHARS = 20_000;
const oneLine = (s) => String(s ?? '').replace(/[\r\n\t"]+/g, ' ').trim().slice(0, 200) || 'Untitled document';

/** The panel's document, if the person can read it; null otherwise. */
async function readableDocument(rawPanel, userId, deps = {}) {
    const panel = normaliseSidePanelDocument(rawPanel);
    if (!panel || !userId) return null;
    try {
        const doc = await (deps.documentStore || documentStore).getDocument(panel.id, userId);
        return doc || null;
    } catch (e) {
        log.warn('[sidePanelDocument] lookup failed:', e.message);
        return null;
    }
}

/** Direct chat: tell the model which document is open (it reads it with document_read). */
async function buildDirectNote(rawPanel, userId, deps) {
    const doc = await readableDocument(rawPanel, userId, deps);
    if (!doc) return '';
    return `\n\n[DOCUMENT OPEN] The user has "${oneLine(doc.name)}" (documentId: ${doc.id}, type: ${doc.docType || 'document'}) open next to the chat. Read it with document_read when the request is about it.`;
}

/** Agent chat: the document's text, read-only, capped. */
async function buildAgentContent(rawPanel, userId, deps) {
    const doc = await readableDocument(rawPanel, userId, deps);
    if (!doc) return '';
    const head = `\n\n[DOCUMENT OPEN: ${oneLine(doc.name)}]\nThe user has this document open next to the chat. It is read-only context: you cannot change it.`;
    if (doc.docType === 'spreadsheet') {
        return `${head}\n(This is a spreadsheet; its cell contents are not included here.)`;
    }
    const text = htmlToText(doc.bodyHtml);
    if (!text) return `${head}\n(The document is empty.)`;
    if (text.length <= MAX_CONTENT_CHARS) return `${head}\n\n${text}`;
    return `${head}\n\n${text.slice(0, MAX_CONTENT_CHARS)}\n…[truncated, the document is ${text.length} characters]`;
}

module.exports = { buildDirectNote, buildAgentContent, MAX_CONTENT_CHARS };
