// @typecheck strict
/**
 * App Studio catalog — Studio documents inside an app: a read-only viewer, a
 * picker and a compare (routes/studioAppDocuments.js serves them), and the
 * copy_document step's fields (registered in actionSpecs.js STEP_SPECS).
 *
 * A document reference is "<id>", "<id>@<versionId>" or { documentId,
 * versionId? } (what copy_document returns). An app shows only the documents
 * its builder put into it (a fixed id here, a picker's documentIds/folderId,
 * a copy_document step) plus copies it made itself — appDocuments/pool.mts.
 */

'use strict';

/** Most documents one picker may name. */
const MAX_PICKER_DOCUMENTS = 50;

const DOCUMENT_SPECS = {
    document_viewer: {
        label: 'Document', category: 'Content',
        description: 'A Studio document, read-only (page, presentation, spreadsheet…). source: a document id (static) or a formula/record field/action result holding one; a dynamic id shows only if this app pins it elsewhere or copied it.',
        props: {
            source: { type: 'binding', default: { kind: 'static', value: null } },
            emptyText: { type: 'string', maxLen: 200, default: 'No document selected.' },
            showHeader: { type: 'boolean', default: true },
        },
        styleKnobs: ['span', 'height', 'radius'],
        defaultStyle: { span: 12, height: 'lg' },
    },
    document_compare: {
        label: 'Document compare', category: 'Content',
        description: 'What changed between two Studio documents. Text per paragraph, decks per slide (+ look), sheets per row/column/cell. left/right: document ids ("<id>@<versionId>" = a version); only left = the viewer picks a version to compare.',
        props: {
            left: { type: 'binding', default: { kind: 'static', value: null } },
            right: { type: 'binding', default: { kind: 'static', value: null } },
            leftLabel: { type: 'string', maxLen: 60, default: 'Before' },
            rightLabel: { type: 'string', maxLen: 60, default: 'After' },
            mode: { type: 'enum', values: ['side', 'inline'], default: 'side' },
            onlyChanges: { type: 'boolean', default: true },
            emptyText: { type: 'string', maxLen: 200, default: 'No documents to compare.' },
        },
        styleKnobs: ['span', 'height', 'radius'],
        defaultStyle: { span: 12, height: 'xl' },
    },
    input_document: {
        label: 'Document picker', category: 'Input', isInput: true,
        description: 'Pick a Studio document. Offers documentIds and/or folderId (the owner\'s), narrowed by kind; submits its id.',
        props: {
            name: { type: 'string', required: true, maxLen: 60, default: 'document' },
            label: { type: 'string', required: true, maxLen: 120, default: 'Document' },
            kind: { type: 'enum', values: ['any', 'text', 'presentation', 'spreadsheet'], default: 'any' },
            documentIds: { type: 'stringList', maxItems: MAX_PICKER_DOCUMENTS, itemMaxLen: 100, default: [] },
            folderId: { type: 'string', maxLen: 100, default: null },
            required: { type: 'boolean', default: false },
        },
        events: ['onChange'],
        styleKnobs: ['span', 'size'],
        defaultStyle: { span: 6 },
    },
};

/**
 * copy_document — a copy of a Studio document in the OWNER's library, the
 * hook for "convert this presentation to another template and show me what
 * changed". `source` is a document reference ("<id>", "<id>@<versionId>",
 * { documentId }) that must be in the app's document pool, like everything a
 * document component shows. `templateDocumentId` names a presentation whose
 * LOOK (settings.deck: preset, colours, fonts, template deck, logo) the copy
 * of a presentation takes; the outline is copied as it is. The copy is a
 * private library document marked `createdByApp`, which puts it in this app's
 * pool. The result `{ kind:'studio_document', documentId, versionId, name,
 * docType, sourceDocumentId }` binds straight into document_compare / _viewer.
 * A spreadsheet cannot be copied by an app yet (its cells live in tables).
 */
const COPY_DOCUMENT_FIELDS = {
    source: { type: 'binding', required: true },
    templateDocumentId: { type: 'string', maxLen: 100 },
    name: { type: 'binding' },
    resultVar: { type: 'string', required: true, maxLen: 60 },
};

module.exports = { DOCUMENT_SPECS, MAX_PICKER_DOCUMENTS, COPY_DOCUMENT_FIELDS };
