// @typecheck
/**
 * Prompt blocks for the Studio document the person has open next to the chat.
 *
 * Direct chat has the document tools, so it only learns WHICH document is open
 * (`buildDirectNote`); agent chats have no document tools, so the text is
 * injected read-only (`buildAgentContent`). Both run only on turns whose
 * request carries `sidePanelDocument` and only when the person may read the
 * document: otherwise they return '' and nothing is injected.
 *
 * A notebook open in the panel (`kind: 'notebook'`) is not a document: no
 * document tool reaches it, so both chats get its text, read-only, the same
 * way agent chats get a document's. Whether the person may read it is the
 * notebook store's answer (getNotebook: owner, project role or shared).
 *
 * The client's name hint is never used: the stored name is. Names and content
 * never go to logs.
 */

const documentStore = require('../../stores/documentStore');
const notebookStore = require('../../stores/notebookStore');
const { htmlToText } = require('../../stores/lib/documentText');
const { normaliseSidePanelDocument } = require('./aiDocumentScope');
const log = require('../../telemetry/log');

const MAX_CONTENT_CHARS = 20_000;
const oneLine = (s, fallback = 'Untitled document') => String(s ?? '').replace(/[\r\n\t"]+/g, ' ').trim().slice(0, 200) || fallback;

/** The panel's document, if the person can read it; null otherwise. */
async function readableDocument(panel, userId, deps = {}) {
    try {
        const doc = await (deps.documentStore || documentStore).getDocument(panel.id, userId);
        return doc || null;
    } catch (e) {
        log.warn('[sidePanelDocument] lookup failed:', /** @type {Error} */ (e).message);
        return null;
    }
}

/** The panel's notebook, if the person can read it; null otherwise. */
async function readableNotebook(panel, userId, deps = {}) {
    try {
        const nb = await (deps.notebookStore || notebookStore).getNotebook(panel.id, userId);
        return nb || null;
    } catch (e) {
        log.warn('[sidePanelDocument] notebook lookup failed:', /** @type {Error} */ (e).message);
        return null;
    }
}

/** The text block for a body of plain text, capped. */
function textBlock(head, text, noun) {
    if (!text) return `${head}\n(The ${noun} is empty.)`;
    if (text.length <= MAX_CONTENT_CHARS) return `${head}\n\n${text}`;
    return `${head}\n\n${text.slice(0, MAX_CONTENT_CHARS)}\n…[truncated, the ${noun} is ${text.length} characters]`;
}

/** An open notebook, read-only, for either chat; '' when it cannot be read. */
async function notebookContent(panel, userId, deps) {
    const nb = await readableNotebook(panel, userId, deps);
    if (!nb) return '';
    const head = `\n\n[NOTEBOOK OPEN: ${oneLine(nb.name, 'Untitled notebook')}]\nThe user has this notebook open next to the chat. It is read-only context: you cannot change it from this chat.`;
    const md = typeof nb.documentMd === 'string' ? nb.documentMd.trim() : '';
    const text = md || htmlToText(nb.documentContent || '');
    return textBlock(head, text, 'notebook');
}

/** Direct chat: tell the model which document is open (it reads it with document_read). */
async function buildDirectNote(rawPanel, userId, deps) {
    const panel = normaliseSidePanelDocument(rawPanel);
    if (!panel || !userId) return '';
    if (panel.kind === 'notebook') return notebookContent(panel, userId, deps);
    const doc = await readableDocument(panel, userId, deps);
    if (!doc) return '';
    const sheetHint = doc.docType === 'spreadsheet'
        ? ' It has tabs: read one with document_read({ documentId, tab }) and change cells with document_write({ documentId, cells, tab }).'
        : '';
    return `\n\n[DOCUMENT OPEN] The user has "${oneLine(doc.name)}" (documentId: ${doc.id}, type: ${doc.docType || 'document'}) open next to the chat. Read it with document_read when the request is about it.${sheetHint}`;
}

/** Agent chat: the document's text, read-only, capped. */
async function buildAgentContent(rawPanel, userId, deps) {
    const panel = normaliseSidePanelDocument(rawPanel);
    if (!panel || !userId) return '';
    if (panel.kind === 'notebook') return notebookContent(panel, userId, deps);
    const doc = await readableDocument(panel, userId, deps);
    if (!doc) return '';
    const head = `\n\n[DOCUMENT OPEN: ${oneLine(doc.name)}]\nThe user has this document open next to the chat. It is read-only context: you cannot change it.`;
    if (doc.docType === 'spreadsheet') {
        return `${head}\n(This is a spreadsheet; its cell contents are not included here.)`;
    }
    return textBlock(head, htmlToText(doc.bodyHtml), 'document');
}

module.exports = { buildDirectNote, buildAgentContent, MAX_CONTENT_CHARS };
