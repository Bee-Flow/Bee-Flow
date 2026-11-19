// @typecheck strict
/**
 * Step kind `generate_document`: the app's own text (markdown, or HTML) in, a PDF or Word file
 * out, stored as an app attachment like generate_file, fill_document and generate_presentation
 * (the same `studio_attachment` descriptor, so file_preview, download_file, send_email
 * attachments and a file-column record write take it unchanged). No designed document needed:
 * a report after an approval built from the record's data, a summary an ai_generate step wrote,
 * a letter. Executor: actionExecutor/steps/generate_document.mts, which renders through the same
 * core/documents/render/documentRenderer.js the automation step `generate_document` uses.
 *
 * It writes one attachment of the app and reaches nobody, so it runs wherever generate_file runs:
 * a click, a background action, a mailbox hook, an unattended run and an anonymous public page.
 */

'use strict';

module.exports = {
    kind: 'generate_document',
    since: 3,
    side: 'server',
    fields: {
        content: { type: 'binding', required: true, description: 'The text of the document: markdown (headings, lists, tables, bold), e.g. { "kind": "formula", "expr": "vars.summary.text" } for what an ai_generate step wrote, a record field, or a static template with {{form.x}} / {{vars.x}} placeholders. At most 2,000,000 characters.' },
        contentFormat: { type: 'enum', values: ['markdown', 'html'], default: 'markdown', description: 'How `content` is read: markdown, or html (scripts, frames and remote images are removed).' },
        title: { type: 'binding', description: 'The document title: the heading of the first page and the file\'s title. Optional.' },
        format: { type: 'enum', values: ['pdf', 'docx'], default: 'pdf', description: 'pdf (a PDF) or docx (a Word file).' },
        fileName: { type: 'binding', required: true, description: 'The file name without extension, e.g. { "kind": "formula", "expr": "\\"Report \\" + item.number" }. The extension follows `format`.' },
        houseStyle: { type: 'boolean', default: true, description: 'A Word file wears the Word house style of the owner\'s organisation (fonts, heading colours, margins). false: a neutral document. A PDF uses the standard print layout.' },
        aiGenerated: { type: 'boolean', default: false, description: 'true when the content was written by an AI step (ai_generate, ai_extract, kb_query). The document then carries the AI content marking of the owner\'s organisation (EU AI Act Art. 50(2): a visible line and the file metadata) when the organisation marks AI output.' },
        attachToRecordId: { type: 'binding', description: 'The record the file belongs to. With attachToFieldKey, everyone who can read that record can download the file; without, only the app owner can.' },
        attachToFieldKey: { type: 'string', maxLen: 100, description: 'The `file` column of that record the file is linked to. Set both or neither.' },
        resultVar: { type: 'string', required: true, maxLen: 60, description: 'The variable that gets the file: { kind: "studio_attachment", fileId, name, mime, size, format, marked, marking, degraded? }.' },
    },
    childSlots: [],
    // A second attempt stores a second file of the same bytes against the quota, nothing more.
    retrySafe: true,
    budget: 'heavy',
    handler: 'file',
    // As generate_file: one attachment of the app, nothing leaves Bee Flow. mcpDryRun 'skip': a
    // dry run does not store a file.
    policy: { click: 'step', background: 'run', mailboxHook: 'run', unattended: 'run', mcpRun: 'run', mcpDryRun: 'skip', public: 'step' },
    inLoop: {
        severity: 'warning', code: 'action.generate_document_in_loop',
        message: 'A "generate document" step runs inside a loop — one stored file per iteration.',
        hint: 'That is fine for one letter per row; keep the list short, since each file counts against the app\'s storage quota.',
    },
    /** @param {Record<string, unknown>} s */
    summary: (s) => `generate_document(${s.format === 'docx' ? 'docx' : 'pdf'})→${typeof s.resultVar === 'string' && s.resultVar ? s.resultVar : '?'}`,
    description: 'Renders text (markdown) into a PDF or Word file. No designed document is needed. '
        + 'Give `content` (markdown: "# " headings, lists, tables), `fileName` and `resultVar`; optionally `title`, `format` (pdf or docx) and `houseStyle` (a Word file in the organisation\'s Word house style, default true). '
        + 'Use it for a report built from a record\'s fields (a formula or template binding), a summary an ai_generate step wrote (vars.<its resultVar>.text), or a letter. To fill a layout the owner designed under Documents use fill_document instead; for slides, generate_presentation. '
        + 'Set `aiGenerated: true` when the content came from an AI step: the file then carries the organisation\'s AI content marking (a visible line and the file metadata) when the organisation marks AI output. '
        + 'The result in vars.<resultVar> is the attachment descriptor generate_file returns ({ kind: "studio_attachment", fileId, name, mime, size, format, marked }), so file_preview shows it, download_file hands it over, a send_email attachment carries it and a file column of a record takes it. '
        + 'Set attachToRecordId and attachToFieldKey (a `file` column) together, or only the app owner can download the file. When no browser renderer is available the PDF uses a plain layout and the result says degraded: true. '
        + 'An empty content fails with error.code "document_empty", more than 2,000,000 characters with "document_too_large". '
        + 'Example: { "kind": "generate_document", "content": { "kind": "formula", "expr": "vars.summary.text" }, "title": { "kind": "field", "name": "subject" }, "format": "pdf", "fileName": { "kind": "static", "value": "Summary" }, "aiGenerated": true, "attachToRecordId": { "kind": "formula", "expr": "item.id" }, "attachToFieldKey": "report", "resultVar": "report" }.',
};
