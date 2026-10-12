/**
 * Make a document and Fill in a document — the web's GenerateDocumentFields
 * and FillDocumentFields (actionEditors/documentFields.jsx).
 *
 * Fill in a document has a bespoke editor (editors/document): its document
 * picker, the pinned revision and the per-placeholder value rows read the
 * Documents API. This spec holds its plain bands — the values as stored (what
 * that editor falls back to when the document cannot be read), the file and
 * the options — which the editor renders as they are declared here.
 */

import { msg, type EditorSpec } from '../spec';
import { KEEP_FOR, TITLES } from './common';

export const GENERATE_DOCUMENT: EditorSpec = {
    type: 'generate_document',
    sections: [
        {
            key: 'content',
            title: TITLES.content,
            defaultOpen: true,
            fields: [
                {
                    kind: 'template',
                    key: 'content',
                    multiline: true,
                    required: true,
                    example: '{{steps.ai_1.output.text}}',
                    label: msg('mobile.flow.doc.text', 'Text'),
                    hint: msg('mobile.flow.doc.text_hint', 'Usually the step that wrote the text.'),
                },
                {
                    kind: 'select',
                    key: 'contentFormat',
                    label: msg('mobile.flow.doc.written_as', 'Written as'),
                    hint: msg('mobile.flow.doc.written_as_hint', 'Markdown is what AI steps produce; its headings, bold, links and tables are rendered properly.'),
                    options: [
                        { value: 'markdown', label: msg('mobile.flow.doc.markdown', 'Markdown') },
                        { value: 'html', label: msg('mobile.flow.doc.html', 'HTML') },
                    ],
                },
            ],
        },
        {
            key: 'output',
            title: TITLES.file,
            defaultOpen: true,
            fields: [
                {
                    kind: 'select',
                    key: 'format',
                    required: true,
                    label: msg('mobile.flow.doc.format', 'Format'),
                    options: [
                        { value: 'pdf', label: msg('mobile.flow.doc.pdf', 'PDF') },
                        { value: 'docx', label: msg('mobile.flow.doc.docx', 'Word (.docx)') },
                    ],
                },
                {
                    kind: 'template',
                    key: 'title',
                    example: 'Offerte {{trigger.output.bedrijf}}',
                    label: msg('mobile.flow.doc.title', 'Title'),
                    hint: msg('mobile.flow.doc.title_hint', 'Shown as the heading on the first page, and used as the filename when you leave that blank.'),
                },
                {
                    kind: 'template',
                    key: 'fileName',
                    example: 'offerte-{{trigger.output.nummer}}',
                    label: msg('mobile.flow.doc.file_name', 'Filename'),
                    hint: msg('mobile.flow.doc.file_name_hint', 'Without the extension — that follows from the format.'),
                },
            ],
        },
        { key: 'options', title: TITLES.options, fields: [KEEP_FOR] },
    ],
};

export const FILL_DOCUMENT: EditorSpec = {
    type: 'fill_document',
    sections: [
        {
            key: 'values',
            title: msg('automations.versions.setting.values', 'Values'),
            defaultOpen: true,
            fields: [
                {
                    kind: 'templateMap',
                    key: 'values',
                    hint: msg('mobile.flow.fill.values_hint', 'The placeholders this step already fills. A list placeholder takes one whole list and nothing else around it.'),
                },
            ],
        },
        {
            key: 'output',
            title: TITLES.file,
            fields: [
                {
                    kind: 'select',
                    key: 'format',
                    // Only a presentation has a format to choose, and only then is one stored.
                    visibleWhen: (draft) => draft.format === 'pdf' || draft.format === 'pptx',
                    label: msg('mobile.flow.doc.format', 'Format'),
                    options: [
                        { value: 'pptx', label: msg('mobile.flow.doc.pptx', 'PowerPoint (.pptx)') },
                        { value: 'pdf', label: msg('mobile.flow.doc.pdf_deck', 'PDF deck') },
                    ],
                },
                {
                    kind: 'template',
                    key: 'fileName',
                    example: 'factuur-{{steps.extract.output.nummer}}',
                    label: msg('mobile.flow.doc.file_name', 'Filename'),
                    hint: msg('mobile.flow.fill.file_name_hint', 'Without the extension — that is added. Leave it blank to use the document’s own name.'),
                },
                {
                    kind: 'toggle',
                    key: 'saveCopy',
                    label: msg('mobile.flow.doc.keep_copy', 'Also keep it in Documents'),
                    description: msg(
                        'mobile.flow.fill.keep_copy_hint',
                        'Keeps the FILLED document in Studio → Documents so you can correct a line by hand before it goes out. Leave it off for an automation that runs often — it makes a document every run.',
                    ),
                },
                {
                    kind: 'template',
                    key: 'copyName',
                    example: 'Factuur {{steps.extract.output.nummer}}',
                    visibleWhen: (draft) => draft.saveCopy === true,
                    label: msg('mobile.flow.doc.copy_name', 'Name of the copy'),
                    hint: msg('mobile.flow.fill.copy_name_hint', 'Defaults to the document’s name plus today’s date.'),
                },
            ],
        },
        { key: 'options', title: TITLES.options, fields: [KEEP_FOR] },
    ],
};

